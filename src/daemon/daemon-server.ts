import net from 'node:net';
import { writeFrame, createFrameReader } from './framing.ts';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ToolCatalog } from '../runtime/types.ts';
import type { AnyFragment } from '../types/domain-fragments.ts';
import type {
  DaemonRequest,
  DaemonResponse,
  DaemonToolResult,
  ToolInvokeParams,
  ToolInvokeProgressFrame,
  ToolInvokeResultFrame,
  DaemonStatusResult,
  ToolListItem,
  XcodeIdeListParams,
  XcodeIdeListResult,
  XcodeIdeInvokeParams,
  XcodeIdeInvokeResult,
} from './protocol.ts';
import { DAEMON_PROTOCOL_VERSION } from './protocol.ts';
import { DefaultToolInvoker } from '../runtime/tool-invoker.ts';
import type { ToolHandlerContext } from '../rendering/types.ts';

import { log } from '../utils/logger.ts';
import { XcodeIdeToolService } from '../integrations/xcode-tools-bridge/tool-service.ts';
import {
  callToolResultToBridgeResultWithArtifact,
  type BridgeToolResult,
} from '../integrations/xcode-tools-bridge/bridge-tool-result.ts';
import { toLocalToolName } from '../integrations/xcode-tools-bridge/registry.ts';
import { toBridgeCallResultDomainResult } from '../mcp/tools/xcode-ide/shared.ts';

export interface DaemonServerContext {
  socketPath: string;
  logPath?: string;
  startedAt: string;
  enabledWorkflows: string[];
  catalog: ToolCatalog;
  workspaceRoot: string;
  workspaceKey: string;
  instanceId?: string;
  xcodeIdeWorkflowEnabled: boolean;
  /** Callback to request graceful shutdown (used instead of direct process.exit) */
  requestShutdown: () => void;
  /** Callback invoked whenever a daemon request starts processing. */
  onRequestStarted?: () => void;
  /** Callback invoked after a daemon request has finished processing. */
  onRequestFinished?: () => void;
}

function bridgeResultToDaemonResult(
  remoteTool: string,
  bridgeResult: BridgeToolResult,
): DaemonToolResult {
  const result = toBridgeCallResultDomainResult(bridgeResult, remoteTool);
  return {
    structuredOutput: {
      schema: 'mobilebuildmcp.output.xcode-bridge-call-result',
      schemaVersion: '3',
      result,
    },
    isError: result.didError,
    nextStepParams: bridgeResult.nextStepParams,
    nextStepConditionKeys: bridgeResult.nextStepConditionKeys,
  };
}

async function toolResponseToDaemonResult(
  remoteTool: string,
  response: CallToolResult,
  args: Record<string, unknown>,
): Promise<DaemonToolResult> {
  return bridgeResultToDaemonResult(
    remoteTool,
    await callToolResultToBridgeResultWithArtifact(response, { remoteTool, arguments: args }),
  );
}

function toolErrorToDaemonResult(remoteTool: string, error: unknown): DaemonToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return bridgeResultToDaemonResult(remoteTool, {
    isError: true,
    errorMessage: message,
    payload: {
      kind: 'call-result',
      succeeded: false,
      content: [{ type: 'text', text: message }],
    },
  });
}

/**
 * Start the daemon server listening on a Unix domain socket.
 */
export function startDaemonServer(ctx: DaemonServerContext): net.Server {
  const invoker = new DefaultToolInvoker(ctx.catalog);
  const xcodeIdeService = new XcodeIdeToolService();
  xcodeIdeService.setWorkflowEnabled(ctx.xcodeIdeWorkflowEnabled);

  const server = net.createServer((socket) => {
    log('info', '[Daemon] Client connected');

    const onData = createFrameReader(
      async (msg) => {
        const req = msg as DaemonRequest;
        const base: Pick<DaemonResponse, 'v' | 'id'> = {
          v: DAEMON_PROTOCOL_VERSION,
          id: req?.id ?? 'unknown',
        };

        ctx.onRequestStarted?.();
        try {
          if (!req || typeof req !== 'object') {
            return writeFrame(socket, {
              ...base,
              error: { code: 'BAD_REQUEST', message: 'Invalid request format' },
            });
          }

          if (req.v !== DAEMON_PROTOCOL_VERSION) {
            return writeFrame(socket, {
              ...base,
              error: {
                code: 'BAD_REQUEST',
                message: `Unsupported protocol version: ${req.v}`,
              },
            });
          }

          switch (req.method) {
            case 'daemon.status': {
              const result: DaemonStatusResult = {
                pid: process.pid,
                socketPath: ctx.socketPath,
                logPath: ctx.logPath,
                startedAt: ctx.startedAt,
                enabledWorkflows: ctx.enabledWorkflows,
                toolCount: ctx.catalog.tools.length,
                workspaceRoot: ctx.workspaceRoot,
                workspaceKey: ctx.workspaceKey,
                instanceId: ctx.instanceId,
              };
              return writeFrame(socket, { ...base, result });
            }

            case 'daemon.stop': {
              log('info', '[Daemon] Stop requested');
              // Send response before initiating shutdown
              writeFrame(socket, { ...base, result: { ok: true } });
              // Request shutdown through callback (allows proper cleanup)
              setTimeout(() => ctx.requestShutdown(), 100);
              return;
            }

            case 'tool.list': {
              const result: ToolListItem[] = ctx.catalog.tools.map((t) => ({
                name: t.cliName,
                workflow: t.workflow,
                description: t.description ?? '',
                stateful: t.stateful,
              }));
              return writeFrame(socket, { ...base, result });
            }

            case 'tool.invoke': {
              const params = req.params as ToolInvokeParams;
              if (!params?.tool) {
                return writeFrame(socket, {
                  ...base,
                  error: { code: 'BAD_REQUEST', message: 'Missing tool parameter' },
                });
              }

              const resolved = ctx.catalog.resolve(params.tool);
              if (resolved.ambiguous) {
                return writeFrame(socket, {
                  ...base,
                  error: {
                    code: 'AMBIGUOUS_TOOL',
                    message: `Ambiguous tool '${params.tool}'`,
                    data: { matches: resolved.ambiguous },
                  },
                });
              }

              if (resolved.notFound || !resolved.tool) {
                return writeFrame(socket, {
                  ...base,
                  error: {
                    code: 'NOT_FOUND',
                    message: `Unknown tool '${params.tool}'`,
                  },
                });
              }

              log('info', `[Daemon] Invoking tool: ${params.tool}`);
              const streamFragment = (fragment: AnyFragment): void => {
                const frame: ToolInvokeProgressFrame = {
                  v: DAEMON_PROTOCOL_VERSION,
                  id: base.id,
                  stream: { kind: 'fragment', fragment },
                };
                writeFrame(socket, frame);
              };

              const handlerContext: ToolHandlerContext = {
                emit: (fragment) => {
                  streamFragment(fragment);
                },
                attach: () => {},
              };

              await invoker.invokeDirect(resolved.tool, params.args ?? {}, {
                runtime: 'daemon',
                handlerContext,
                enabledWorkflows: ctx.enabledWorkflows,
              });

              const resultFrame: ToolInvokeResultFrame = {
                v: DAEMON_PROTOCOL_VERSION,
                id: base.id,
                result: {
                  structuredOutput: handlerContext.structuredOutput ?? null,
                  nextStepParams: handlerContext.nextStepParams,
                  nextStepConditionKeys: handlerContext.nextStepConditionKeys,
                  nextSteps: handlerContext.nextSteps,
                },
              };
              return writeFrame(socket, resultFrame);
            }

            case 'xcode-ide.list': {
              if (!ctx.xcodeIdeWorkflowEnabled) {
                return writeFrame(socket, {
                  ...base,
                  error: {
                    code: 'NOT_FOUND',
                    message:
                      'xcode-ide workflow is not enabled for this daemon session (set MOBILEBUILDMCP_ENABLED_WORKFLOWS to include xcode-ide)',
                  },
                });
              }

              const params = (req.params ?? {}) as XcodeIdeListParams;
              const refresh = params.refresh;
              if (params.prefetch === true && refresh !== true) {
                void xcodeIdeService.listTools({ refresh: true }).catch((error) => {
                  const message = error instanceof Error ? error.message : String(error);
                  log('debug', `[Daemon] xcode-ide prefetch failed: ${message}`);
                });
              }
              const tools = await xcodeIdeService.listTools({
                refresh,
              });
              const result: XcodeIdeListResult = {
                tools: tools.map((tool) => ({
                  remoteName: tool.name,
                  localName: toLocalToolName(tool.name),
                  description: tool.description ?? '',
                  inputSchema: tool.inputSchema,
                  annotations: tool.annotations,
                })),
              };
              return writeFrame(socket, { ...base, result });
            }

            case 'xcode-ide.invoke': {
              if (!ctx.xcodeIdeWorkflowEnabled) {
                return writeFrame(socket, {
                  ...base,
                  error: {
                    code: 'NOT_FOUND',
                    message:
                      'xcode-ide workflow is not enabled for this daemon session (set MOBILEBUILDMCP_ENABLED_WORKFLOWS to include xcode-ide)',
                  },
                });
              }

              const params = req.params as XcodeIdeInvokeParams;
              if (!params?.remoteTool) {
                return writeFrame(socket, {
                  ...base,
                  error: {
                    code: 'BAD_REQUEST',
                    message: 'Missing remoteTool parameter',
                  },
                });
              }

              let xcodeResult: DaemonToolResult;
              try {
                const response = await xcodeIdeService.invokeTool(
                  params.remoteTool,
                  params.args ?? {},
                );
                xcodeResult = await toolResponseToDaemonResult(
                  params.remoteTool,
                  response,
                  params.args ?? {},
                );
              } catch (error) {
                xcodeResult = toolErrorToDaemonResult(params.remoteTool, error);
              }

              const result: XcodeIdeInvokeResult = { result: xcodeResult };
              return writeFrame(socket, { ...base, result });
            }

            default:
              return writeFrame(socket, {
                ...base,
                error: { code: 'BAD_REQUEST', message: `Unknown method: ${req.method}` },
              });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log('error', `[Daemon] Internal error handling request: ${message}`, { sentry: true });
          return writeFrame(socket, {
            ...base,
            error: {
              code: 'INTERNAL',
              message,
            },
          });
        } finally {
          ctx.onRequestFinished?.();
        }
      },
      (err) => {
        log('warn', `[Daemon] Frame parse error: ${err.message}`);
      },
    );

    socket.on('data', onData);
    socket.on('close', () => {
      log('info', '[Daemon] Client disconnected');
    });
    socket.on('error', (err) => {
      log('warn', `[Daemon] Socket error: ${err.message}`);
    });
  });

  server.on('error', (err) => {
    log('warn', `[Daemon] Server error: ${err.message}`);
  });
  server.on('close', () => {
    void xcodeIdeService.disconnect();
  });

  return server;
}
