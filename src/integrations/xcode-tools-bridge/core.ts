import { execFile } from 'node:child_process';
import process from 'node:process';
import { promisify } from 'node:util';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { XcodeToolsBridgeClientStatus } from './client.ts';

const execFileAsync = promisify(execFile);

export type XcodeToolsBridgeStatus = {
  workflowEnabled: boolean;
  bridgeAvailable: boolean;
  bridgePath: string | null;
  xcodeRunning: boolean | null;
  connected: boolean;
  bridgePid: number | null;
  proxiedToolCount: number;
  lastError: string | null;
  xcodePid: string | null;
  xcodeSessionId: string | null;
};

export interface SerializedBridgeTool {
  name: string;
  title: string | null;
  description: string | null;
  inputSchema: Record<string, unknown> | boolean | null;
  outputSchema: Record<string, unknown> | boolean | null;
  annotations: Record<string, unknown> | null;
}

export function serializeBridgeTool(tool: Tool): SerializedBridgeTool {
  return {
    name: tool.name,
    title: tool.title ?? null,
    description: tool.description ?? null,
    inputSchema: toJsonSchemaValue(tool.inputSchema),
    outputSchema: toJsonSchemaValue(tool.outputSchema),
    annotations: toJsonObject(tool.annotations),
  };
}

export interface BuildXcodeToolsBridgeStatusArgs {
  workflowEnabled: boolean;
  proxiedToolCount: number;
  lastError: string | null;
  clientStatus: XcodeToolsBridgeClientStatus;
}

export async function buildXcodeToolsBridgeStatus(
  args: BuildXcodeToolsBridgeStatusArgs,
): Promise<XcodeToolsBridgeStatus> {
  const bridge = await getMcpBridgeAvailability();
  const xcodeRunning = await isXcodeRunning();

  return {
    workflowEnabled: args.workflowEnabled,
    bridgeAvailable: bridge.available,
    bridgePath: bridge.path,
    xcodeRunning,
    connected: args.clientStatus.connected,
    bridgePid: args.clientStatus.bridgePid,
    proxiedToolCount: args.proxiedToolCount,
    lastError: args.lastError ?? args.clientStatus.lastError,
    xcodePid: process.env.MOBILEBUILDMCP_XCODE_PID ?? process.env.MCP_XCODE_PID ?? null,
    xcodeSessionId:
      process.env.MOBILEBUILDMCP_XCODE_SESSION_ID ?? process.env.MCP_XCODE_SESSION_ID ?? null,
  };
}

export async function getMcpBridgeAvailability(): Promise<{
  available: boolean;
  path: string | null;
}> {
  try {
    const res = await execFileAsync('xcrun', ['--find', 'mcpbridge'], { timeout: 2000 });
    const out = (res.stdout ?? '').toString().trim();
    return out ? { available: true, path: out } : { available: false, path: null };
  } catch {
    return { available: false, path: null };
  }
}

export async function isXcodeRunning(): Promise<boolean | null> {
  try {
    const res = await execFileAsync('pgrep', ['-x', 'Xcode'], { timeout: 1000 });
    const out = (res.stdout ?? '').toString().trim();
    return out.length > 0;
  } catch {
    return null;
  }
}

export function classifyBridgeError(
  error: unknown,
  operation: 'list' | 'call',
  opts?: { connected?: boolean },
): string {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();

  if (message.includes('mcpbridge not available')) {
    return 'MCPBRIDGE_NOT_FOUND';
  }
  if (message.includes('workflow is not enabled')) {
    return 'XCODE_MCP_UNAVAILABLE';
  }
  if (message.includes('timed out') || message.includes('timeout')) {
    if (opts?.connected === false) {
      return 'BRIDGE_CONNECT_TIMEOUT';
    }
    return operation === 'list' ? 'BRIDGE_LIST_TIMEOUT' : 'BRIDGE_CALL_TIMEOUT';
  }
  if (message.includes('permission') || message.includes('not allowed')) {
    return 'XCODE_APPROVAL_REQUIRED';
  }
  if (
    message.includes('connection closed') ||
    message.includes('closed') ||
    message.includes('disconnected')
  ) {
    return 'XCODE_SESSION_NOT_READY';
  }
  return 'XCODE_MCP_UNAVAILABLE';
}

function toJsonSchemaValue(value: unknown): Record<string, unknown> | boolean | null {
  if (typeof value === 'boolean') {
    return value;
  }
  return toJsonObject(value);
}

function toJsonObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
