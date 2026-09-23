import type { ToolCatalog, ToolDefinition, ToolInvoker, InvokeOptions } from './types.ts';
import type { NextStep, NextStepParams, NextStepParamsMap } from '../types/common.ts';
import type { DaemonToolResult, ToolInvokeResult } from '../daemon/protocol.ts';

import { DaemonClient, DaemonVersionMismatchError } from '../cli/daemon-client.ts';
import {
  ensureDaemonRunning,
  forceStopDaemon,
  DEFAULT_DAEMON_STARTUP_TIMEOUT_MS,
} from '../cli/daemon-control.ts';
import { log } from '../utils/logger.ts';
import {
  recordInternalErrorMetric,
  recordToolInvocationMetric,
  type SentryToolInvocationOutcome,
  type SentryToolRuntime,
  type SentryToolTransport,
} from '../utils/sentry.ts';
import type { RenderSession, ToolHandlerContext } from '../rendering/types.ts';
import { createRenderSession } from '../rendering/render.ts';
import { createStructuredErrorOutput } from '../utils/structured-error.ts';

type BuiltTemplateNextStep = {
  step: NextStep;
  templateToolId?: string;
  condition?: string;
};

function emitExplicitRuntimeError(params: {
  session: RenderSession;
  handlerContext?: ToolHandlerContext;
  onStructuredOutput?: InvokeOptions['onStructuredOutput'];
  code: string;
  message: string;
}): void {
  const output = createStructuredErrorOutput({
    category: 'runtime',
    code: params.code,
    message: params.message,
  });
  params.session.setStructuredOutput?.(output);
  if (params.handlerContext) {
    params.handlerContext.structuredOutput = output;
  }
  params.onStructuredOutput?.(output);
}

function buildTemplateNextSteps(
  tool: ToolDefinition,
  catalog: ToolCatalog,
): BuiltTemplateNextStep[] {
  if (!tool.nextStepTemplates || tool.nextStepTemplates.length === 0) {
    return [];
  }

  const built: BuiltTemplateNextStep[] = [];
  for (const template of tool.nextStepTemplates) {
    if (!template.toolId) {
      built.push({
        step: {
          label: template.label,
          priority: template.priority,
          when: template.when,
        },
        condition: template.condition,
      });
      continue;
    }

    const target = catalog.getByToolId(template.toolId);
    if (!target) {
      continue;
    }

    built.push({
      step: {
        tool: target.mcpName,
        label: template.label,
        params: template.params ?? {},
        priority: template.priority,
        when: template.when,
      },
      templateToolId: template.toolId,
      condition: template.condition,
    });
  }

  return built;
}

function consumeDynamicParams(
  nextStepParams: NextStepParamsMap | undefined,
  toolId: string,
  consumedCounts: Map<string, number>,
): NextStepParams | undefined {
  const candidate = nextStepParams?.[toolId];
  if (!candidate) {
    return undefined;
  }

  if (Array.isArray(candidate)) {
    const current = consumedCounts.get(toolId) ?? 0;
    consumedCounts.set(toolId, current + 1);
    return candidate[current];
  }

  return candidate;
}

function mergeTemplateAndResponseNextSteps(
  templateSteps: BuiltTemplateNextStep[],
  responseParamsMap: NextStepParamsMap | undefined,
): NextStep[] {
  const consumedCounts = new Map<string, number>();

  return templateSteps.map((builtTemplateStep) => {
    const templateStep = builtTemplateStep.step;
    if (!builtTemplateStep.templateToolId || !templateStep.tool) {
      return templateStep;
    }

    const paramsFromMap = consumeDynamicParams(
      responseParamsMap,
      builtTemplateStep.templateToolId,
      consumedCounts,
    );
    if (!paramsFromMap) {
      return templateStep;
    }

    return {
      ...templateStep,
      params: {
        ...(templateStep.params ?? {}),
        ...paramsFromMap,
      },
    };
  });
}

function getNextStepTarget(params: {
  catalog: ToolCatalog;
  mcpName: string;
  preferredWorkflow: string;
}): ToolDefinition | null {
  return (
    params.catalog.tools.find(
      (tool) =>
        tool.mcpName.toLowerCase() === params.mcpName.toLowerCase().trim() &&
        tool.workflow === params.preferredWorkflow,
    ) ?? params.catalog.getByMcpName(params.mcpName)
  );
}

function normalizeNextSteps(
  steps: NextStep[],
  catalog: ToolCatalog,
  preferredWorkflow: string,
): NextStep[] {
  return steps.map((step) => {
    if (!step.tool) {
      return step;
    }

    const target = getNextStepTarget({ catalog, mcpName: step.tool, preferredWorkflow });
    if (!target) {
      return step;
    }

    return {
      ...step,
      tool: target.mcpName,
      workflow: target.workflow,
      cliTool: target.cliName,
    };
  });
}

function isStructuredXcodebuildFailureSession(session: RenderSession): boolean {
  const structuredOutput = session.getStructuredOutput?.();
  if (!structuredOutput?.result.didError) {
    return false;
  }

  return (
    structuredOutput.result.kind === 'build-result' ||
    structuredOutput.result.kind === 'build-run-result' ||
    structuredOutput.result.kind === 'test-result'
  );
}

function buildEffectiveNextStepParams(
  nextStepParams: NextStepParamsMap | undefined,
  handlerNextSteps: NextStep[] | undefined,
  catalog: ToolCatalog,
): NextStepParamsMap | undefined {
  if (!handlerNextSteps || handlerNextSteps.length === 0) {
    return nextStepParams;
  }

  let merged: NextStepParamsMap | undefined = nextStepParams;
  for (const step of handlerNextSteps) {
    if (!step.tool || !step.params || Object.keys(step.params).length === 0) {
      continue;
    }
    const target = catalog.getByMcpName(step.tool);
    const toolId = target?.id ?? step.tool;
    if (merged?.[toolId]) {
      continue;
    }
    merged = { ...merged, [toolId]: step.params as NextStepParams };
  }
  return merged;
}

export function postProcessSession(params: {
  tool: ToolDefinition;
  session: RenderSession;
  ctx: ToolHandlerContext;
  catalog: ToolCatalog;
  runtime: InvokeOptions['runtime'];
  applyTemplateNextSteps?: boolean;
}): void {
  const { tool, session, ctx, catalog, runtime, applyTemplateNextSteps = true } = params;

  const isError = session.isError();
  const nextStepParams = ctx.nextStepParams;
  const nextStepConditionKeys = new Set(ctx.nextStepConditionKeys ?? []);
  const handlerNextSteps = ctx.nextSteps;
  const suppressNextStepsForStructuredFailure =
    isError && isStructuredXcodebuildFailureSession(session);

  if (suppressNextStepsForStructuredFailure) {
    return;
  }

  const suppressTemplateNextSteps = handlerNextSteps !== undefined && handlerNextSteps.length === 0;

  const effectiveNextStepParams = buildEffectiveNextStepParams(
    nextStepParams,
    handlerNextSteps,
    catalog,
  );

  const allTemplateSteps = buildTemplateNextSteps(tool, catalog);
  const templateSteps = allTemplateSteps.filter((t) => {
    const when = t.step.when ?? 'always';
    const statusMatches = when === 'success' ? !isError : when === 'failure' ? isError : true;
    const conditionMatches = !t.condition || nextStepConditionKeys.has(t.condition);
    return statusMatches && conditionMatches;
  });

  let finalSteps: NextStep[];

  if (applyTemplateNextSteps && !suppressTemplateNextSteps && templateSteps.length > 0) {
    finalSteps = mergeTemplateAndResponseNextSteps(templateSteps, effectiveNextStepParams);
  } else if (handlerNextSteps && handlerNextSteps.length > 0) {
    finalSteps = handlerNextSteps;
  } else {
    return;
  }

  const normalized = normalizeNextSteps(finalSteps, catalog, tool.workflow);

  if (normalized.length > 0) {
    session.setNextSteps?.(normalized, runtime);
  }
}

function buildDaemonEnvOverrides(opts: InvokeOptions): Record<string, string> | undefined {
  if (!opts.logLevel) {
    return undefined;
  }
  return { MOBILEBUILDMCP_DAEMON_LOG_LEVEL: opts.logLevel };
}

function getErrorKind(error: unknown): string {
  return error instanceof Error ? error.name || 'Error' : typeof error;
}

function mapRuntimeToSentryToolRuntime(runtime: InvokeOptions['runtime']): SentryToolRuntime {
  if (runtime === 'daemon' || runtime === 'mcp') {
    return runtime;
  }
  return 'cli';
}

export class DefaultToolInvoker implements ToolInvoker {
  constructor(private catalog: ToolCatalog) {}

  async invoke(
    toolName: string,
    args: Record<string, unknown>,
    opts: InvokeOptions,
  ): Promise<void> {
    const resolved = this.catalog.resolve(toolName);
    const session = opts.renderSession ?? createRenderSession('text');
    const resolvedOpts = { ...opts, renderSession: session };

    if (resolved.ambiguous) {
      emitExplicitRuntimeError({
        session,
        handlerContext: opts.handlerContext,
        onStructuredOutput: opts.onStructuredOutput,
        code: 'AMBIGUOUS_TOOL',
        message: `Ambiguous tool name: Multiple tools match '${toolName}'. Use one of:\n- ${resolved.ambiguous.join('\n- ')}`,
      });
      return;
    }

    if (resolved.notFound || !resolved.tool) {
      emitExplicitRuntimeError({
        session,
        handlerContext: opts.handlerContext,
        onStructuredOutput: opts.onStructuredOutput,
        code: 'TOOL_NOT_FOUND',
        message: `Tool not found: Unknown tool '${toolName}'. Run 'mobilebuildmcp tools' to see available tools.`,
      });
      return;
    }

    return this.executeTool(resolved.tool, args, resolvedOpts);
  }

  async invokeDirect(
    tool: ToolDefinition,
    args: Record<string, unknown>,
    opts: InvokeOptions,
  ): Promise<void> {
    const session = opts.renderSession ?? createRenderSession('text');
    return this.executeTool(tool, args, { ...opts, renderSession: session });
  }

  private async invokeViaDaemon<TResult>(
    opts: InvokeOptions,
    invoke: (client: DaemonClient) => Promise<TResult>,
    context: {
      label: string;
      errorTitle: string;
      captureInfraErrorMetric: (error: unknown) => void;
      captureInvocationMetric: (outcome: SentryToolInvocationOutcome) => void;
      consumeResult: (result: TResult) => void;
      postProcessParams: {
        tool: ToolDefinition;
        catalog: ToolCatalog;
        runtime: InvokeOptions['runtime'];
      };
    },
  ): Promise<void> {
    const session = opts.renderSession!;
    const socketPath = opts.socketPath;
    if (!socketPath) {
      const error = new Error('SocketPathMissing');
      context.captureInfraErrorMetric(error);
      context.captureInvocationMetric('infra_error');
      emitExplicitRuntimeError({
        session,
        handlerContext: opts.handlerContext,
        onStructuredOutput: opts.onStructuredOutput,
        code: 'SOCKET_PATH_MISSING',
        message: 'Socket path required: No socket path configured for daemon communication.',
      });
      return;
    }

    const daemonTimeout =
      context.postProcessParams.tool.workflow === 'xcode-ide' ? 60_000 : undefined;
    const client = new DaemonClient({ socketPath, timeout: daemonTimeout });
    const isRunning = await client.isRunning();

    if (!isRunning) {
      try {
        await ensureDaemonRunning({
          socketPath,
          workspaceRoot: opts.workspaceRoot,
          startupTimeoutMs: opts.daemonStartupTimeoutMs ?? DEFAULT_DAEMON_STARTUP_TIMEOUT_MS,
          env: buildDaemonEnvOverrides(opts),
        });
      } catch (error) {
        log(
          'error',
          `[infra/tool-invoker] ${context.label} daemon auto-start failed (${getErrorKind(error)})`,
          { sentry: true },
        );
        context.captureInfraErrorMetric(error);
        context.captureInvocationMetric('infra_error');
        emitExplicitRuntimeError({
          session,
          handlerContext: opts.handlerContext,
          onStructuredOutput: opts.onStructuredOutput,
          code: 'DAEMON_AUTO_START_FAILED',
          message: `Daemon auto-start failed: ${error instanceof Error ? error.message : String(error)}\n\nYou can try starting the daemon manually:\n  mobilebuildmcp daemon start`,
        });
        return;
      }
    }

    try {
      const daemonResult = await invoke(client);
      context.captureInvocationMetric('completed');
      context.consumeResult(daemonResult);
    } catch (error) {
      if (error instanceof DaemonVersionMismatchError) {
        log('info', `[infra/tool-invoker] ${context.label} daemon protocol mismatch, restarting`);
        try {
          await forceStopDaemon(socketPath);
          await ensureDaemonRunning({
            socketPath,
            workspaceRoot: opts.workspaceRoot,
            startupTimeoutMs: opts.daemonStartupTimeoutMs ?? DEFAULT_DAEMON_STARTUP_TIMEOUT_MS,
            env: buildDaemonEnvOverrides(opts),
          });
          const retryClient = new DaemonClient({ socketPath, timeout: daemonTimeout });
          const daemonResult = await invoke(retryClient);
          context.captureInvocationMetric('completed');
          context.consumeResult(daemonResult);
          return;
        } catch (retryError) {
          log(
            'error',
            `[infra/tool-invoker] ${context.label} daemon restart failed (${getErrorKind(retryError)})`,
            { sentry: true },
          );
          context.captureInfraErrorMetric(retryError);
          context.captureInvocationMetric('infra_error');
          emitExplicitRuntimeError({
            session,
            handlerContext: opts.handlerContext,
            onStructuredOutput: opts.onStructuredOutput,
            code: 'DAEMON_RESTART_FAILED',
            message: `Daemon restart failed after protocol mismatch: ${retryError instanceof Error ? retryError.message : String(retryError)}\n\nTry restarting manually:\n  mobilebuildmcp daemon stop && mobilebuildmcp daemon start`,
          });
          return;
        }
      }

      log(
        'error',
        `[infra/tool-invoker] ${context.label} transport failed (${getErrorKind(error)})`,
        { sentry: true },
      );
      context.captureInfraErrorMetric(error);
      context.captureInvocationMetric('infra_error');
      emitExplicitRuntimeError({
        session,
        handlerContext: opts.handlerContext,
        onStructuredOutput: opts.onStructuredOutput,
        code: 'DAEMON_TRANSPORT_FAILED',
        message: `${context.errorTitle}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  private async executeTool(
    tool: ToolDefinition,
    args: Record<string, unknown>,
    opts: InvokeOptions,
  ): Promise<void> {
    const startedAt = Date.now();
    const runtime = mapRuntimeToSentryToolRuntime(opts.runtime);
    let transport: SentryToolTransport = 'direct';

    const captureInvocationMetric = (outcome: SentryToolInvocationOutcome): void => {
      recordToolInvocationMetric({
        toolName: tool.mcpName,
        runtime,
        transport,
        outcome,
        durationMs: Date.now() - startedAt,
      });
    };

    const captureInfraErrorMetric = (error: unknown): void => {
      recordInternalErrorMetric({
        component: 'tool-invoker',
        runtime,
        errorKind: getErrorKind(error),
      });
    };

    const postProcessParams = { tool, catalog: this.catalog, runtime: opts.runtime };
    const xcodeIdeRemoteToolName = tool.xcodeIdeRemoteToolName;
    const isDynamicXcodeIdeTool =
      tool.workflow === 'xcode-ide' && typeof xcodeIdeRemoteToolName === 'string';

    if (opts.runtime === 'cli' && isDynamicXcodeIdeTool) {
      transport = 'xcode-ide-daemon';
      return this.invokeViaDaemon(
        opts,
        (client) => client.invokeXcodeIdeTool(xcodeIdeRemoteToolName, args),
        {
          label: 'xcode-ide',
          errorTitle: 'Xcode IDE invocation failed',
          captureInfraErrorMetric,
          captureInvocationMetric,
          consumeResult: (daemonResult: DaemonToolResult) => {
            const structuredOutput = daemonResult.structuredOutput ?? undefined;
            if (structuredOutput) {
              opts.renderSession!.setStructuredOutput?.(structuredOutput);
              opts.onStructuredOutput?.(structuredOutput);
            }

            const ctx: ToolHandlerContext = {
              emit: (fragment) => {
                opts.renderSession!.emit(fragment);
              },
              attach: (image) => opts.renderSession!.attach(image),
              nextStepParams: daemonResult.nextStepParams,
              nextStepConditionKeys: daemonResult.nextStepConditionKeys,
              nextSteps: daemonResult.nextSteps,
              structuredOutput,
            };

            postProcessSession({
              ...postProcessParams,
              session: opts.renderSession!,
              ctx,
            });
          },
          postProcessParams,
        },
      );
    }

    if (opts.runtime === 'cli' && tool.stateful) {
      const session = opts.renderSession!;

      transport = 'daemon';
      return this.invokeViaDaemon(
        opts,
        (client) =>
          client.invokeTool(tool.mcpName, args, {
            onFragment: (fragment) => {
              session.emit(fragment);
              opts.onProgress?.(fragment);
            },
          }),
        {
          label: `daemon/${tool.mcpName}`,
          errorTitle: 'Daemon invocation failed',
          captureInfraErrorMetric,
          captureInvocationMetric,
          consumeResult: (daemonResult: ToolInvokeResult) => {
            if (daemonResult.structuredOutput) {
              session.setStructuredOutput?.(daemonResult.structuredOutput);
              opts.onStructuredOutput?.(daemonResult.structuredOutput);
            }

            const ctx: ToolHandlerContext = {
              emit: (fragment) => {
                session.emit(fragment);
              },
              attach: (image) => session.attach(image),
              nextStepParams: daemonResult.nextStepParams,
              nextStepConditionKeys: daemonResult.nextStepConditionKeys,
              nextSteps: daemonResult.nextSteps,
              structuredOutput: daemonResult.structuredOutput ?? undefined,
            };

            postProcessSession({
              ...postProcessParams,
              session,
              ctx,
            });
          },
          postProcessParams,
        },
      );
    }

    // Direct invocation (CLI stateless or daemon internal)
    const session = opts.renderSession!;
    let ctx: ToolHandlerContext | undefined;
    try {
      ctx = opts.handlerContext ?? {
        emit: (fragment): void => {
          session.emit(fragment);
          opts.onProgress?.(fragment);
        },
        attach: (image): void => {
          session.attach(image);
        },
      };

      await tool.handler(args, ctx);

      if (ctx.structuredOutput) {
        session.setStructuredOutput?.(ctx.structuredOutput);
        opts.onStructuredOutput?.(ctx.structuredOutput);
      }

      captureInvocationMetric('completed');

      if (opts.runtime !== 'daemon') {
        postProcessSession({
          ...postProcessParams,
          session,
          ctx,
        });
      }
    } catch (error) {
      log(
        'error',
        `[infra/tool-invoker] direct tool handler failed for ${tool.mcpName} (${getErrorKind(error)})`,
        { sentry: true },
      );
      captureInfraErrorMetric(error);
      captureInvocationMetric('infra_error');
      const message = error instanceof Error ? error.message : String(error);
      emitExplicitRuntimeError({
        session,
        handlerContext: ctx ?? opts.handlerContext,
        onStructuredOutput: opts.onStructuredOutput,
        code: 'DIRECT_HANDLER_FAILED',
        message: `Tool execution failed: ${message}`,
      });
    }
  }
}
