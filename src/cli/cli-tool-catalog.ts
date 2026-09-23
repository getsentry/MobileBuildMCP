import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { ToolSchemaShape } from '../core/plugin-types.ts';
import { startDaemonBackground } from './daemon-control.ts';
import { DaemonClient } from './daemon-client.ts';
import { buildCliToolCatalogFromManifest, createToolCatalog } from '../runtime/tool-catalog.ts';
import type { ToolCatalog, ToolDefinition } from '../runtime/types.ts';
import { toKebabCase } from '../runtime/naming.ts';
import type { ToolHandlerContext } from '../rendering/types.ts';

import { jsonSchemaToZod } from '../integrations/xcode-tools-bridge/jsonschema-to-zod.ts';
import { XcodeIdeToolService } from '../integrations/xcode-tools-bridge/tool-service.ts';
import { toLocalToolName } from '../integrations/xcode-tools-bridge/registry.ts';
import { log } from '../utils/logging/index.ts';
import { infrastructureStatus } from '../types/runtime-status.ts';

interface BuildCliToolCatalogOptions {
  socketPath: string;
  workspaceRoot: string;
  cliExposedWorkflowIds: string[];
  discoveryMode?: 'none' | 'quick';
}

type JsonSchemaObject = {
  properties?: Record<string, unknown>;
  required?: unknown[];
};

function jsonSchemaToToolSchemaShape(inputSchema: unknown): ToolSchemaShape {
  if (!inputSchema || typeof inputSchema !== 'object') {
    return {};
  }

  const schema = inputSchema as JsonSchemaObject;
  const properties = schema.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    return {};
  }

  const requiredFields = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((name): name is string => typeof name === 'string')
      : [],
  );

  const shape: ToolSchemaShape = {};
  for (const [name, propertySchema] of Object.entries(properties)) {
    const zodSchema = jsonSchemaToZod(propertySchema);
    shape[name] = requiredFields.has(name) ? zodSchema : zodSchema.optional();
  }

  return shape;
}

async function invokeRemoteToolOneShot(
  remoteToolName: string,
  args: Record<string, unknown>,
  ctx: ToolHandlerContext,
): Promise<void> {
  const service = new XcodeIdeToolService();
  service.setWorkflowEnabled(true);
  try {
    const response = (await service.invokeTool(remoteToolName, args)) as unknown as {
      content?: Array<{ type: string; text: string }>;
      isError?: boolean;
      _meta?: Record<string, unknown>;
    };
    if (response.content) {
      for (const item of response.content) {
        if (item.type === 'text') {
          ctx.emit(infrastructureStatus(response.isError ? 'error' : 'success', item.text));
        }
      }
    }
  } finally {
    await service.disconnect();
  }
}

type DynamicBridgeTool = {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: ToolAnnotations;
};

function getBridgeDiscoveryTimeoutMs(quickMode: boolean): number {
  const configured = process.env.MOBILEBUILDMCP_XCODE_IDE_DISCOVERY_TIMEOUT_MS;
  if (configured !== undefined) {
    const parsed = Number(configured);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return quickMode ? 400 : 250;
}

function createCliXcodeProxyTool(remoteTool: DynamicBridgeTool): ToolDefinition {
  const cliSchema = jsonSchemaToToolSchemaShape(remoteTool.inputSchema);

  return {
    cliName: toKebabCase(remoteTool.name),
    mcpName: toLocalToolName(remoteTool.name),
    workflow: 'xcode-ide',
    description: remoteTool.description ?? '',
    annotations: remoteTool.annotations,
    mcpSchema: cliSchema,
    cliSchema,
    stateful: false,
    xcodeIdeRemoteToolName: remoteTool.name,
    handler: async (params, ctx): Promise<void> => {
      return invokeRemoteToolOneShot(remoteTool.name, params, ctx);
    },
  };
}

async function loadDaemonBackedXcodeProxyTools(
  opts: BuildCliToolCatalogOptions,
): Promise<ToolDefinition[]> {
  const discoveryMode = opts.discoveryMode ?? 'none';
  const quickMode = discoveryMode === 'quick';
  const daemonClient = new DaemonClient({
    socketPath: opts.socketPath,
    timeout: getBridgeDiscoveryTimeoutMs(quickMode),
  });

  try {
    const isRunning = await daemonClient.isRunning();
    if (!isRunning) {
      if (!quickMode) {
        return [];
      }

      // Fast path for CLI help/discovery: fire-and-forget daemon startup to avoid
      // blocking command rendering while still warming a long-lived bridge session.
      try {
        startDaemonBackground({
          socketPath: opts.socketPath,
          workspaceRoot: opts.workspaceRoot,
        });
      } catch (startError) {
        const message = startError instanceof Error ? startError.message : String(startError);
        log('warn', `[xcode-ide] Failed to start daemon in background: ${message}`);
      }
      return [];
    }

    const tools = await daemonClient.listXcodeIdeTools({
      refresh: false,
      prefetch: quickMode,
    });

    return tools.map(
      (tool): ToolDefinition =>
        createCliXcodeProxyTool({
          name: tool.remoteName,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: tool.annotations,
        }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (quickMode) {
      log('warn', `[xcode-ide] CLI daemon-backed bridge discovery failed: ${message}`);
    } else {
      log('debug', `[xcode-ide] CLI cached bridge discovery skipped: ${message}`);
    }
    return [];
  }
}

/**
 * Build a tool catalog for CLI usage using the manifest system.
 * CLI visibility is determined by manifest availability and predicates.
 */
export async function buildCliToolCatalog(opts: BuildCliToolCatalogOptions): Promise<ToolCatalog> {
  const manifestCatalog = await buildCliToolCatalogFromManifest();

  if (!opts.cliExposedWorkflowIds.includes('xcode-ide')) {
    return manifestCatalog;
  }

  const dynamicTools = await loadDaemonBackedXcodeProxyTools(opts);
  if (dynamicTools.length === 0) {
    return manifestCatalog;
  }

  const existingCliNames = new Set(manifestCatalog.tools.map((tool) => tool.cliName));
  const mergedTools = [
    ...manifestCatalog.tools,
    ...dynamicTools.filter((tool) => !existingCliNames.has(tool.cliName)),
  ];

  return createToolCatalog(mergedTools);
}
