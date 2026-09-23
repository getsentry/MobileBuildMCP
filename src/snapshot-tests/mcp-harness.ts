import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { StructuredOutputEnvelope } from '../types/structured-output.ts';
import { normalizeSnapshotOutput } from './normalize.ts';
import type {
  SnapshotInvokeOptions,
  SnapshotResult,
  SnapshotResultOutcome,
  WorkflowSnapshotHarness,
} from './contracts.ts';
import { resolveSnapshotToolManifest } from './tool-manifest-resolver.ts';

const CLI_PATH = path.resolve(process.cwd(), 'build/cli.js');
const MCP_TOOL_TIMEOUT_MS = 120_000;
export const MCP_SNAPSHOT_PARITY_WORKFLOWS = [
  'coverage',
  'debugging',
  'device',
  'macos',
  'project-discovery',
  'project-scaffolding',
  'session-management',
  'simulator',
  'simulator-management',
  'swift-package',
  'ui-automation',
  'utilities',
] as const;

export interface McpSnapshotHarness extends WorkflowSnapshotHarness {
  callTool(name: string, args: Record<string, unknown>): Promise<SnapshotResult>;
  client: Client;
  cleanup(): Promise<void>;
}

export interface CreateMcpSnapshotHarnessOptions {
  cwd?: string;
  disableSessionDefaults?: boolean;
  enabledWorkflows?: string[];
  env?: Record<string, string>;
}

function extractSnapshotTextContent(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    throw new Error('MCP snapshot result did not include a content array.');
  }

  let text = '';
  let textBlockCount = 0;

  for (const part of content) {
    if (!part || typeof part !== 'object') {
      throw new Error('MCP snapshot result contained an invalid content block.');
    }

    const typedPart = part as { type?: unknown; text?: unknown };
    if (typedPart.type === 'text') {
      if (typeof typedPart.text !== 'string') {
        throw new Error('MCP snapshot result contained a text block without string text.');
      }
      textBlockCount += 1;
      if (textBlockCount > 1) {
        throw new Error(
          'MCP snapshot result contained multiple text blocks; snapshot extraction refuses to invent separators.',
        );
      }
      text += typedPart.text;
    }
  }

  return text;
}

function extractStructuredEnvelope(result: unknown): StructuredOutputEnvelope<unknown> | null {
  if (!result || typeof result !== 'object') {
    return null;
  }

  const structuredContent = (result as { structuredContent?: unknown }).structuredContent;
  if (!structuredContent || typeof structuredContent !== 'object') {
    return null;
  }

  return structuredContent as StructuredOutputEnvelope<unknown>;
}

function createSnapshotHarnessEnv(overrides: Record<string, string>): Record<string, string> {
  const { VITEST: _vitest, NODE_ENV: _nodeEnv, ...rest } = process.env;
  const env = Object.fromEntries(
    Object.entries(rest).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  return { ...env, ...overrides };
}

export function resolveMcpSnapshotOutcome(
  transportDidError: boolean | undefined,
  envelopeDidError: boolean | undefined,
  label: string,
  rawText = '',
): SnapshotResultOutcome {
  const didTransportError = transportDidError ?? false;
  if (envelopeDidError !== undefined && didTransportError !== envelopeDidError) {
    throw new Error(
      `MCP result.isError (${String(transportDidError)}) disagrees with structuredContent.didError (${envelopeDidError}) for ${label}.`,
    );
  }

  if (envelopeDidError === true) {
    return 'domain-error';
  }
  if (didTransportError) {
    if (/^MCP error -32602: Input validation error:/u.test(rawText.trim())) {
      return 'validation-error';
    }
    return 'infrastructure-error';
  }
  return 'success';
}

export async function connectMcpClientWithCleanup(
  connect: () => Promise<void>,
  closeClient: () => Promise<void>,
  closeTransport: () => Promise<void>,
): Promise<void> {
  try {
    await connect();
  } catch (error) {
    await Promise.allSettled([
      Promise.resolve().then(closeClient),
      Promise.resolve().then(closeTransport),
    ]);
    throw error;
  }
}

export async function createMcpSnapshotHarness(
  opts: CreateMcpSnapshotHarnessOptions = {},
): Promise<McpSnapshotHarness> {
  const enabledWorkflows = opts.enabledWorkflows ?? [...MCP_SNAPSHOT_PARITY_WORKFLOWS];
  const transport = new StdioClientTransport({
    command: 'node',
    args: [CLI_PATH, 'mcp'],
    cwd: opts.cwd,
    env: createSnapshotHarnessEnv({
      ...(opts.env ?? {}),
      MOBILEBUILDMCP_ENABLED_WORKFLOWS: enabledWorkflows.join(','),
      MOBILEBUILDMCP_DISABLE_SESSION_DEFAULTS: String(opts.disableSessionDefaults ?? true),
      MOBILEBUILDMCP_DISABLE_XCODE_AUTO_SYNC: '1',
      MOBILEBUILDMCP_TEST_FORCE_TOOL_EXPOSURE: 'sync_xcode_defaults',
    }),
    stderr: 'pipe',
  });

  const client = new Client({ name: 'snapshot-test-client', version: '1.0.0' });
  await connectMcpClientWithCleanup(
    () => client.connect(transport, { timeout: 30_000 }),
    () => client.close(),
    () => transport.close(),
  );

  async function callTool(name: string, args: Record<string, unknown>): Promise<SnapshotResult> {
    const result = await client.callTool({ name, arguments: args }, undefined, {
      timeout: MCP_TOOL_TIMEOUT_MS,
    });
    const rawText = extractSnapshotTextContent(result);
    const text = normalizeSnapshotOutput(rawText);
    const structuredEnvelope = extractStructuredEnvelope(result);
    const outcome = resolveMcpSnapshotOutcome(
      (result as { isError?: boolean }).isError,
      structuredEnvelope?.didError,
      name,
      rawText,
    );

    return {
      text,
      rawText,
      isError: outcome !== 'success',
      outcome,
      structuredEnvelope,
    };
  }

  async function invoke(
    workflow: string,
    cliToolName: string,
    args: Record<string, unknown>,
    _options: SnapshotInvokeOptions = {},
  ): Promise<SnapshotResult> {
    const resolved = resolveSnapshotToolManifest(workflow, cliToolName);
    if (!resolved) {
      throw new Error(`Tool '${cliToolName}' not found in workflow '${workflow}'`);
    }
    if (!resolved.isMcpAvailable) {
      throw new Error(`Tool '${cliToolName}' in workflow '${workflow}' is not MCP-available`);
    }

    return callTool(resolved.mcpToolName, args);
  }

  return {
    invoke,
    callTool,
    client,
    cleanup: () => client.close(),
  };
}
