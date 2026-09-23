import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  type StdioServerParameters,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { CompatibilityCallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import process from 'node:process';

export interface XcodeToolsBridgeClientStatus {
  connected: boolean;
  bridgePid: number | null;
  lastError: string | null;
}

export interface XcodeToolsBridgeClientOptions {
  serverParams?: StdioServerParameters;
  connectTimeoutMs?: number;
  listToolsTimeoutMs?: number;
  callToolTimeoutMs?: number;
  onToolsListChanged?: () => void;
  onBridgeClosed?: () => void;
}

export class XcodeToolsBridgeClient {
  private readonly options: Required<
    Pick<
      XcodeToolsBridgeClientOptions,
      'connectTimeoutMs' | 'listToolsTimeoutMs' | 'callToolTimeoutMs'
    >
  > &
    Omit<
      XcodeToolsBridgeClientOptions,
      'connectTimeoutMs' | 'listToolsTimeoutMs' | 'callToolTimeoutMs'
    >;

  private transport: StdioClientTransport | null = null;
  private client: Client | null = null;
  private connectPromise: Promise<void> | null = null;
  private lastError: string | null = null;

  constructor(options: XcodeToolsBridgeClientOptions = {}) {
    this.options = {
      connectTimeoutMs: options.connectTimeoutMs ?? 15_000,
      listToolsTimeoutMs: options.listToolsTimeoutMs ?? 60_000,
      callToolTimeoutMs: options.callToolTimeoutMs ?? 60_000,
      ...options,
    };
  }

  getStatus(): XcodeToolsBridgeClientStatus {
    return {
      connected: this.client !== null,
      bridgePid: this.transport?.pid ?? null,
      lastError: this.lastError,
    };
  }

  async connectOnce(): Promise<void> {
    if (this.client) return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = (async (): Promise<void> => {
      try {
        const serverParams =
          this.options.serverParams ??
          ({
            command: 'xcrun',
            args: ['mcpbridge'],
            stderr: 'pipe',
            env: mapXcodeEnvForMcpBridge(process.env),
          } satisfies StdioServerParameters);

        const transport = new StdioClientTransport(serverParams);
        transport.onclose = (): void => {
          this.client = null;
          this.transport = null;
          this.connectPromise = null;
          this.options.onBridgeClosed?.();
        };

        const client = new Client(
          { name: 'mobilebuildmcp-xcode-tools-bridge', version: '0.0.0' },
          {
            listChanged: {
              tools: {
                autoRefresh: false,
                debounceMs: 250,
                onChanged: (): void => {
                  this.options.onToolsListChanged?.();
                },
              },
            },
          },
        );

        await client.connect(transport, { timeout: this.options.connectTimeoutMs });

        this.transport = transport;
        this.client = client;
        this.lastError = null;
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        await this.disconnect();
        throw error;
      } finally {
        this.connectPromise = null;
      }
    })();

    return this.connectPromise;
  }

  async disconnect(): Promise<void> {
    const client = this.client;
    const transport = this.transport;
    this.client = null;
    this.transport = null;
    this.connectPromise = null;

    try {
      await client?.close();
    } finally {
      try {
        await transport?.close?.();
      } catch {
        // ignore
      }
    }
  }

  async listTools(): Promise<Tool[]> {
    if (!this.client) {
      throw new Error('Bridge client is not connected');
    }
    const result = await this.client.listTools(undefined, {
      timeout: this.options.listToolsTimeoutMs,
    });
    return result.tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    opts: { timeoutMs?: number } = {},
  ): Promise<CallToolResult> {
    if (!this.client) {
      throw new Error('Bridge client is not connected');
    }
    const result: unknown = await this.client.request(
      { method: 'tools/call', params: { name, arguments: args } },
      CompatibilityCallToolResultSchema,
      {
        timeout: opts.timeoutMs ?? this.options.callToolTimeoutMs,
        resetTimeoutOnProgress: true,
      },
    );

    if (isCallToolResult(result)) {
      return result;
    }
    if (result && typeof result === 'object' && 'toolResult' in result) {
      const toolResult = (result as { toolResult: unknown }).toolResult;
      if (isCallToolResult(toolResult)) {
        return toolResult;
      }
    }

    // If this is a task result, we don't support it today.
    if (result && typeof result === 'object' && 'task' in result) {
      throw new Error(
        `Tool "${name}" returned a task result; task-based tools are not supported by the bridge proxy`,
      );
    }

    throw new Error(`Tool "${name}" returned an unexpected result shape`);
  }
}

function isCallToolResult(result: unknown): result is CallToolResult {
  if (!result || typeof result !== 'object') return false;
  const record = result as Record<string, unknown>;
  return Array.isArray(record.content);
}

function mapXcodeEnvForMcpBridge(env: NodeJS.ProcessEnv): Record<string, string> {
  const mapped: Record<string, string> = {};

  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') {
      mapped[key] = value;
    }
  }

  if (typeof env.MOBILEBUILDMCP_XCODE_PID === 'string' && mapped.MCP_XCODE_PID === undefined) {
    mapped.MCP_XCODE_PID = env.MOBILEBUILDMCP_XCODE_PID;
  }
  if (
    typeof env.MOBILEBUILDMCP_XCODE_SESSION_ID === 'string' &&
    mapped.MCP_XCODE_SESSION_ID === undefined
  ) {
    mapped.MCP_XCODE_SESSION_ID = env.MOBILEBUILDMCP_XCODE_SESSION_ID;
  }

  return mapped;
}
