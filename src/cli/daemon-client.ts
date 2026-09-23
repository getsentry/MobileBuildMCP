import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { writeFrame, createFrameReader } from '../daemon/framing.ts';
import {
  DAEMON_PROTOCOL_VERSION,
  type DaemonRequest,
  type DaemonResponse,
  type DaemonMethod,
  type DaemonToolResult,
  type ToolInvokeParams,
  type ToolInvokeResult,
  type ToolInvokeProgressFrame,
  type DaemonStatusResult,
  type ToolListItem,
  type XcodeIdeListParams,
  type XcodeIdeListResult,
  type XcodeIdeToolListItem,
  type XcodeIdeInvokeParams,
  type XcodeIdeInvokeResult,
} from '../daemon/protocol.ts';
import { getSocketPath } from '../daemon/socket-path.ts';
import type { AnyFragment } from '../types/domain-fragments.ts';

export class DaemonVersionMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaemonVersionMismatchError';
  }
}

export interface DaemonClientOptions {
  socketPath?: string;
  timeout?: number;
}

export interface InvokeToolOptions {
  onFragment?: (fragment: AnyFragment) => void;
}

export class DaemonClient {
  private socketPath: string;
  private timeout: number;

  constructor(opts: DaemonClientOptions = {}) {
    this.socketPath = opts.socketPath ?? getSocketPath();
    this.timeout = opts.timeout ?? 30000;
  }

  /**
   * Send a request to the daemon and wait for a response.
   */
  async request<TResult>(method: DaemonMethod, params?: unknown): Promise<TResult> {
    const id = randomUUID();
    const req: DaemonRequest = {
      v: DAEMON_PROTOCOL_VERSION,
      id,
      method,
      params,
    };

    return new Promise<TResult>((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      let resolved = false;

      const cleanup = (): void => {
        if (!resolved) {
          resolved = true;
          socket.destroy();
        }
      };

      const timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error(`Daemon request timed out after ${this.timeout}ms`));
      }, this.timeout);

      socket.on('error', (err) => {
        clearTimeout(timeoutId);
        cleanup();
        if (err.message.includes('ECONNREFUSED') || err.message.includes('ENOENT')) {
          reject(new Error('Daemon is not running. Start it with: mobilebuildmcp daemon start'));
        } else {
          reject(err);
        }
      });

      const onData = createFrameReader(
        (msg) => {
          const res = msg as DaemonResponse<TResult>;
          if (res.id !== id) return;

          clearTimeout(timeoutId);
          resolved = true;
          socket.end();

          if (res.error) {
            if (
              res.error.code === 'BAD_REQUEST' &&
              res.error.message.startsWith('Unsupported protocol version')
            ) {
              reject(new DaemonVersionMismatchError(res.error.message));
            } else {
              reject(new Error(`${res.error.code}: ${res.error.message}`));
            }
          } else {
            resolve(res.result as TResult);
          }
        },
        (err) => {
          clearTimeout(timeoutId);
          cleanup();
          reject(err);
        },
      );

      socket.on('data', onData);
      socket.on('connect', () => {
        writeFrame(socket, req);
      });
    });
  }

  /**
   * Get daemon status.
   */
  async status(): Promise<DaemonStatusResult> {
    return this.request<DaemonStatusResult>('daemon.status');
  }

  /**
   * Stop the daemon.
   */
  async stop(): Promise<void> {
    await this.request<{ ok: boolean }>('daemon.stop');
  }

  /**
   * List available tools.
   */
  async listTools(): Promise<ToolListItem[]> {
    return this.request<ToolListItem[]>('tool.list');
  }

  /**
   * Invoke a tool.
   */
  async invokeTool(
    tool: string,
    args: Record<string, unknown>,
    options: InvokeToolOptions = {},
  ): Promise<ToolInvokeResult> {
    const id = randomUUID();
    const req: DaemonRequest<ToolInvokeParams> = {
      v: DAEMON_PROTOCOL_VERSION,
      id,
      method: 'tool.invoke',
      params: {
        tool,
        args,
      },
    };

    return new Promise<ToolInvokeResult>((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      let settled = false;
      let terminalResult: ToolInvokeResult | undefined;
      let receivedTerminalResult = false;
      let timeoutId: NodeJS.Timeout;

      const failWithTransportError = (err: Error): void => {
        if (!settled) {
          settled = true;
          clearTimeout(timeoutId);
          socket.destroy();
          reject(err);
        }
      };

      const scheduleTimeout = (): void => {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => {
          failWithTransportError(new Error(`Daemon request timed out after ${this.timeout}ms`));
        }, this.timeout);
      };

      const resolveTerminalResult = (): void => {
        queueMicrotask(() => {
          if (settled || terminalResult === undefined) {
            return;
          }

          settled = true;
          clearTimeout(timeoutId);
          socket.end();
          resolve(terminalResult);
        });
      };

      scheduleTimeout();

      socket.on('error', (err) => {
        if (settled) {
          return;
        }

        if (err.message.includes('ECONNREFUSED') || err.message.includes('ENOENT')) {
          failWithTransportError(
            new Error('Daemon is not running. Start it with: mobilebuildmcp daemon start'),
          );
        } else {
          failWithTransportError(err);
        }
      });

      socket.on('close', () => {
        if (!settled) {
          failWithTransportError(new Error('Daemon connection closed before terminal tool result'));
        }
      });

      const onData = createFrameReader(
        (msg) => {
          const frame = msg as
            | ToolInvokeProgressFrame
            | DaemonResponse<ToolInvokeResult>
            | Record<string, unknown>;

          if (frame.id !== id) {
            return;
          }

          scheduleTimeout();

          if ('stream' in frame && frame.stream) {
            if (receivedTerminalResult) {
              failWithTransportError(
                new Error('Daemon protocol error: received progress after terminal result'),
              );
              return;
            }

            const progressFrame = frame as ToolInvokeProgressFrame;
            if (progressFrame.stream.kind === 'fragment') {
              options.onFragment?.(progressFrame.stream.fragment);
            } else {
              failWithTransportError(
                new Error(
                  `Daemon protocol error: unknown stream kind '${(progressFrame.stream as { kind: string }).kind}'`,
                ),
              );
              return;
            }
            return;
          }

          const res = frame as DaemonResponse<ToolInvokeResult>;
          if (res.error) {
            if (
              res.error.code === 'BAD_REQUEST' &&
              res.error.message.startsWith('Unsupported protocol version')
            ) {
              failWithTransportError(new DaemonVersionMismatchError(res.error.message));
            } else {
              failWithTransportError(new Error(`${res.error.code}: ${res.error.message}`));
            }
            return;
          }

          if (receivedTerminalResult) {
            failWithTransportError(
              new Error('Daemon protocol error: received duplicate terminal result'),
            );
            return;
          }

          if (res.result === undefined) {
            failWithTransportError(new Error('Daemon protocol error: missing terminal result'));
            return;
          }

          receivedTerminalResult = true;
          terminalResult = res.result;
          resolveTerminalResult();
        },
        (err) => {
          failWithTransportError(err);
        },
      );

      socket.on('data', onData);
      socket.on('connect', () => {
        writeFrame(socket, req);
      });
    });
  }

  /**
   * List dynamic xcode-ide bridge tools from the daemon-managed bridge session.
   */
  async listXcodeIdeTools(params?: XcodeIdeListParams): Promise<XcodeIdeToolListItem[]> {
    const result = await this.request<XcodeIdeListResult>('xcode-ide.list', params);
    return result.tools;
  }

  /**
   * Invoke a dynamic xcode-ide bridge tool through the daemon-managed bridge session.
   */
  async invokeXcodeIdeTool(
    remoteTool: string,
    args: Record<string, unknown>,
  ): Promise<DaemonToolResult> {
    const result = await this.request<XcodeIdeInvokeResult>('xcode-ide.invoke', {
      remoteTool,
      args,
    } satisfies XcodeIdeInvokeParams);
    return result.result;
  }

  /**
   * Check if daemon is running by attempting to connect.
   */
  async isRunning(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const socket = net.createConnection(this.socketPath);
      let settled = false;

      const finish = (value: boolean): void => {
        if (settled) return;
        settled = true;
        try {
          socket.destroy();
        } catch {
          // ignore
        }
        resolve(value);
      };

      const timeoutId = setTimeout(() => {
        finish(false);
      }, this.timeout);

      socket.on('connect', () => {
        clearTimeout(timeoutId);
        finish(true);
      });

      socket.on('error', () => {
        clearTimeout(timeoutId);
        finish(false);
      });
    });
  }
}
