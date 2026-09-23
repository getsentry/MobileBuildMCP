import { type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { server } from '../server/server-state.ts';
import type { ToolResponse } from '../types/common.ts';
import type { ToolCatalog, ToolDefinition } from '../runtime/types.ts';
import { log } from './logger.ts';
import { loadManifest, type ResolvedManifest } from '../core/manifest/load-manifest.ts';
import { importToolModule } from '../core/manifest/import-tool-module.ts';
import {
  getEffectiveCliName,
  type ToolManifestEntry,
  type WorkflowManifestEntry,
} from '../core/manifest/schema.ts';
import { createToolCatalog } from '../runtime/tool-catalog.ts';
import { postProcessSession } from '../runtime/tool-invoker.ts';
import type { PredicateContext } from '../visibility/predicate-types.ts';
import { selectWorkflowsForMcp, isToolExposedForRuntime } from '../visibility/exposure.ts';
import { getConfig } from './config-store.ts';
import { recordInternalErrorMetric, recordToolInvocationMetric } from './sentry.ts';
import type { ToolHandlerContext } from '../rendering/types.ts';
import { createRenderSession } from '../rendering/render.ts';
import type { StructuredOutputEnvelope } from '../types/structured-output.ts';
import { toStructuredEnvelope } from './structured-output-envelope.ts';
import { getMcpOutputSchemaForRegistration } from '../core/structured-output-schema.ts';

type RenderSession = ReturnType<typeof createRenderSession>;

function buildStructuredContent(
  session: RenderSession,
): StructuredOutputEnvelope<unknown> | undefined {
  const structuredOutput = session.getStructuredOutput?.();
  if (!structuredOutput) {
    return undefined;
  }

  return toStructuredEnvelope(
    structuredOutput.result,
    structuredOutput.schema,
    structuredOutput.schemaVersion,
    {
      nextSteps: session.getNextSteps?.(),
      nextStepRuntime: 'mcp',
      outputStyle: 'minimal',
    },
  );
}

function sessionToToolResponse(session: RenderSession): ToolResponse {
  const text = session.finalize();
  const attachments = session.getAttachments();

  const content: ToolResponse['content'] = [];
  if (text) {
    content.push({ type: 'text' as const, text });
  }
  for (const attachment of attachments) {
    content.push({
      type: 'image' as const,
      data: attachment.data,
      mimeType: attachment.mimeType,
    });
  }

  const structuredContent = buildStructuredContent(session);

  return {
    content,
    isError: session.isError() || undefined,
    ...(structuredContent ? { structuredContent } : {}),
  };
}

export interface RuntimeToolInfo {
  enabledWorkflows: string[];
  registeredToolCount: number;
}

const registryState: {
  tools: Map<string, RegisteredTool>;
  enabledWorkflows: Set<string>;
  currentContext: PredicateContext | null;
  catalog: ToolCatalog | null;
} = {
  tools: new Map<string, RegisteredTool>(),
  enabledWorkflows: new Set<string>(),
  currentContext: null,
  catalog: null,
};

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

function getForceExposedToolAliases(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const value = env.MOBILEBUILDMCP_TEST_FORCE_TOOL_EXPOSURE;
  if (!value) {
    return new Set();
  }

  return new Set(
    value
      .split(',')
      .map((alias) => alias.trim().toLowerCase())
      .filter((alias) => alias.length > 0),
  );
}

function buildToolAliasMap(manifest: ResolvedManifest): Map<string, string> {
  const toolIdByAlias = new Map<string, string>();
  for (const tool of manifest.tools.values()) {
    toolIdByAlias.set(normalizeName(tool.id), tool.id);
    toolIdByAlias.set(normalizeName(tool.names.mcp), tool.id);
  }
  return toolIdByAlias;
}

function resolveCustomWorkflowToolIds(
  toolIdByAlias: Map<string, string>,
  toolNames: string[],
): { toolIds: string[]; unknownToolNames: string[] } {
  const toolIds: string[] = [];
  const seen = new Set<string>();
  const unknownToolNames: string[] = [];

  for (const toolName of toolNames) {
    const normalizedToolName = normalizeName(toolName);
    if (!normalizedToolName) {
      continue;
    }
    const toolId = toolIdByAlias.get(normalizedToolName);
    if (!toolId) {
      unknownToolNames.push(toolName);
      continue;
    }
    if (!seen.has(toolId)) {
      seen.add(toolId);
      toolIds.push(toolId);
    }
  }

  return { toolIds, unknownToolNames };
}

function buildCustomWorkflowEntry(name: string, toolIds: string[]): WorkflowManifestEntry {
  return {
    id: name,
    title: name,
    description: `Custom workflow '${name}' from config.yaml.`,
    targetPlatforms: [],
    availability: { mcp: true, cli: false },
    selection: { mcp: { defaultEnabled: false, autoInclude: false } },
    predicates: [],
    tools: toolIds,
  };
}

export function createCustomWorkflowsFromConfig(
  manifest: ResolvedManifest,
  customWorkflows: Record<string, string[]>,
): { workflows: WorkflowManifestEntry[]; warnings: string[] } {
  const workflows: WorkflowManifestEntry[] = [];
  const warnings: string[] = [];
  const toolIdByAlias = buildToolAliasMap(manifest);

  for (const [rawWorkflowName, rawToolNames] of Object.entries(customWorkflows)) {
    const workflowName = normalizeName(rawWorkflowName);
    if (!workflowName) {
      continue;
    }

    if (manifest.workflows.has(workflowName)) {
      warnings.push(
        `[config] Ignoring custom workflow '${workflowName}' because it conflicts with a built-in workflow.`,
      );
      continue;
    }

    const { toolIds, unknownToolNames } = resolveCustomWorkflowToolIds(toolIdByAlias, rawToolNames);
    if (unknownToolNames.length > 0) {
      warnings.push(
        `[config] Custom workflow '${workflowName}' references unknown tools: ${unknownToolNames.join(', ')}`,
      );
    }
    if (toolIds.length === 0) {
      warnings.push(
        `[config] Ignoring custom workflow '${workflowName}' because it resolved to no known tools.`,
      );
      continue;
    }

    workflows.push(buildCustomWorkflowEntry(workflowName, toolIds));
  }

  return { workflows, warnings };
}

function emitConfigWarningMetric(kind: 'unknown_workflow' | 'invalid_custom_workflow'): void {
  recordInternalErrorMetric({
    component: 'config/workflow-selection',
    runtime: 'mcp',
    errorKind: kind,
  });
}

function snapshotRuntimeRegistration(): RuntimeToolInfo {
  return {
    enabledWorkflows: [...registryState.enabledWorkflows],
    registeredToolCount: registryState.tools.size,
  };
}

export function getRuntimeRegistration(): RuntimeToolInfo | null {
  if (registryState.tools.size === 0 && registryState.enabledWorkflows.size === 0) {
    return null;
  }
  return snapshotRuntimeRegistration();
}

export function getRegisteredWorkflows(): string[] {
  return [...registryState.enabledWorkflows];
}

function defaultPredicateContext(): PredicateContext {
  return {
    runtime: 'mcp',
    config: getConfig(),
    runningUnderXcode: false,
  };
}

export function getMcpPredicateContext(): PredicateContext {
  return registryState.currentContext ?? defaultPredicateContext();
}

type ImportedToolModule = Awaited<ReturnType<typeof importToolModule>>;

function recordMcpInvocation(
  toolName: string,
  startedAt: number,
  outcome: 'completed' | 'infra_error',
): void {
  recordToolInvocationMetric({
    toolName,
    runtime: 'mcp',
    transport: 'direct',
    outcome,
    durationMs: Date.now() - startedAt,
  });
}

async function invokeRegisteredTool(
  toolName: string,
  toolModule: ImportedToolModule,
  args: unknown,
): Promise<ToolResponse> {
  const startedAt = Date.now();

  try {
    const session = createRenderSession('text', { outputStyle: 'minimal' });
    const ctx: ToolHandlerContext = {
      emit: (fragment) => {
        session.emit(fragment);
      },
      attach: session.attach,
    };
    await toolModule.handler(args as Record<string, unknown>, ctx);

    if (ctx.structuredOutput) {
      session.setStructuredOutput?.(ctx.structuredOutput);
    }

    const catalog = registryState.catalog;
    const catalogTool = catalog?.getByMcpName(toolName);
    if (catalog && catalogTool) {
      postProcessSession({
        tool: catalogTool,
        session,
        ctx,
        catalog,
        runtime: 'mcp',
      });
    }

    const response = sessionToToolResponse(session);
    recordMcpInvocation(toolName, startedAt, 'completed');
    return response;
  } catch (error) {
    recordInternalErrorMetric({
      component: 'mcp-tool-registry',
      runtime: 'mcp',
      errorKind: error instanceof Error ? error.name || 'Error' : typeof error,
    });
    recordMcpInvocation(toolName, startedAt, 'infra_error');
    throw error;
  }
}

function registerToolFromManifest(
  toolManifest: ToolManifestEntry,
  toolModule: ImportedToolModule,
): void {
  if (!server) {
    throw new Error('Tool registry has not been initialized.');
  }

  const toolName = toolManifest.names.mcp;
  if (registryState.tools.has(toolName)) {
    return;
  }

  const outputSchema = toolManifest.outputSchema
    ? getMcpOutputSchemaForRegistration(toolManifest.outputSchema)
    : undefined;

  const registeredTool = server.registerTool(
    toolName,
    {
      description: toolManifest.description ?? '',
      inputSchema: toolModule.mcpSchema,
      ...(outputSchema ? { outputSchema } : {}),
      annotations: toolManifest.annotations,
    },
    (args: unknown): Promise<ToolResponse> => invokeRegisteredTool(toolName, toolModule, args),
  );
  registryState.tools.set(toolName, registeredTool);
}

function shouldExposeTool(
  toolManifest: ToolManifestEntry,
  ctx: PredicateContext,
  forceExposedToolAliases: Set<string>,
): boolean {
  const isForceExposed =
    forceExposedToolAliases.has(normalizeName(toolManifest.id)) ||
    forceExposedToolAliases.has(normalizeName(toolManifest.names.mcp));

  return isForceExposed || isToolExposedForRuntime(toolManifest, ctx);
}

function resolveSelectedWorkflows(
  manifest: ResolvedManifest,
  requestedWorkflows: string[] | undefined,
  ctx: PredicateContext,
): WorkflowManifestEntry[] {
  const customSelection = createCustomWorkflowsFromConfig(manifest, ctx.config.customWorkflows);
  for (const warning of customSelection.warnings) {
    log('warning', warning);
    emitConfigWarningMetric('invalid_custom_workflow');
  }
  const allWorkflows = [...manifest.workflows.values(), ...customSelection.workflows];

  const normalizedRequestedWorkflows = requestedWorkflows
    ?.map(normalizeName)
    .filter((name) => name.length > 0);

  const selectedWorkflows = selectWorkflowsForMcp(allWorkflows, normalizedRequestedWorkflows, ctx);
  const knownWorkflowIds = new Set(allWorkflows.map((workflow) => workflow.id));
  const unknownRequestedWorkflows = (normalizedRequestedWorkflows ?? []).filter(
    (workflowName) => !knownWorkflowIds.has(workflowName),
  );
  if (unknownRequestedWorkflows.length > 0) {
    const uniqueUnknownRequestedWorkflows = [...new Set(unknownRequestedWorkflows)];
    log(
      'warning',
      `[config] Ignoring unknown workflow(s): ${uniqueUnknownRequestedWorkflows.join(', ')}`,
    );
    emitConfigWarningMetric('unknown_workflow');
  }

  return selectedWorkflows;
}

async function tryImportToolModule(
  toolManifest: ToolManifestEntry,
  cache: Map<string, ImportedToolModule>,
): Promise<ImportedToolModule | undefined> {
  const cached = cache.get(toolManifest.id);
  if (cached) {
    return cached;
  }

  try {
    const toolModule = await importToolModule(toolManifest.module);
    cache.set(toolManifest.id, toolModule);
    return toolModule;
  } catch (err) {
    log('warn', `Failed to import tool module ${toolManifest.module}: ${err}`);
    return undefined;
  }
}

function toCatalogTool(
  toolManifest: ToolManifestEntry,
  workflow: WorkflowManifestEntry,
  toolModule: ImportedToolModule,
): ToolDefinition {
  return {
    id: toolManifest.id,
    cliName: getEffectiveCliName(toolManifest),
    mcpName: toolManifest.names.mcp,
    workflow: workflow.id,
    description: toolManifest.description,
    annotations: toolManifest.annotations,
    outputSchema: toolManifest.outputSchema,
    nextStepTemplates: toolManifest.nextSteps,
    mcpSchema: toolModule.mcpSchema,
    cliSchema: toolModule.schema,
    stateful: toolManifest.routing?.stateful ?? false,
    handler: toolModule.handler as ToolDefinition['handler'],
  };
}

async function enumerateAndRegisterTools(
  manifest: ResolvedManifest,
  selectedWorkflows: WorkflowManifestEntry[],
  ctx: PredicateContext,
): Promise<{ registeredCount: number; desiredWorkflows: Set<string> }> {
  const desiredToolNames = new Set<string>();
  const desiredWorkflows = new Set<string>();
  const catalogTools: ToolDefinition[] = [];
  const moduleCache = new Map<string, ImportedToolModule>();
  const forceExposedToolAliases = getForceExposedToolAliases();

  for (const workflow of selectedWorkflows) {
    desiredWorkflows.add(workflow.id);

    for (const toolId of workflow.tools) {
      const toolManifest = manifest.tools.get(toolId);
      if (!toolManifest) continue;

      if (!shouldExposeTool(toolManifest, ctx, forceExposedToolAliases)) {
        continue;
      }

      const toolModule = await tryImportToolModule(toolManifest, moduleCache);
      if (!toolModule) {
        continue;
      }

      desiredToolNames.add(toolManifest.names.mcp);
      catalogTools.push(toCatalogTool(toolManifest, workflow, toolModule));
      registerToolFromManifest(toolManifest, toolModule);
    }
  }

  registryState.catalog = createToolCatalog(catalogTools);

  for (const [toolName, registeredTool] of registryState.tools.entries()) {
    if (!desiredToolNames.has(toolName)) {
      registeredTool.remove();
      registryState.tools.delete(toolName);
    }
  }

  return { registeredCount: desiredToolNames.size, desiredWorkflows };
}

export async function applyWorkflowSelectionFromManifest(
  requestedWorkflows: string[] | undefined,
  ctx: PredicateContext,
): Promise<RuntimeToolInfo> {
  if (!server) {
    throw new Error('Tool registry has not been initialized.');
  }

  registryState.currentContext = ctx;

  const manifest = loadManifest();
  const selectedWorkflows = resolveSelectedWorkflows(manifest, requestedWorkflows, ctx);
  const { registeredCount, desiredWorkflows } = await enumerateAndRegisterTools(
    manifest,
    selectedWorkflows,
    ctx,
  );

  registryState.enabledWorkflows = desiredWorkflows;

  const workflowLabel = selectedWorkflows.map((w) => w.id).join(', ');
  log('info', `Registered ${registeredCount} tools from workflows: ${workflowLabel}`);

  return snapshotRuntimeRegistration();
}

export async function registerWorkflowsFromManifest(
  workflowNames?: string[],
  ctx?: PredicateContext,
): Promise<void> {
  await applyWorkflowSelectionFromManifest(workflowNames, ctx ?? defaultPredicateContext());
}

export function __resetToolRegistryForTests(): void {
  for (const tool of registryState.tools.values()) {
    try {
      tool.remove();
    } catch {
      // Safe to ignore: server may already be closed during cleanup
    }
  }
  registryState.tools.clear();
  registryState.enabledWorkflows.clear();
  registryState.currentContext = null;
  registryState.catalog = null;
}
