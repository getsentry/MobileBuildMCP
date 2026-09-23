import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadManifest } from '../core/manifest/load-manifest.ts';
import type { ResourceManifestEntry } from '../core/manifest/schema.ts';
import { normalizeSnapshotOutput } from './normalize.ts';

const CLI_PATH = path.resolve(process.cwd(), 'build/cli.js');
const PROCESS_UPTIME_MS_REGEX = /"uptimeMs"\s*:\s*\d+/g;
const PROCESS_RSS_BYTES_REGEX = /"rssBytes"\s*:\s*\d+/g;
const PROCESS_HEAP_BYTES_REGEX = /"heapUsedBytes"\s*:\s*\d+/g;
const PROCESS_TREE_LINE_REGEX = /^ {2}\d+ \(ppid \d+\): .+$/gm;
const ARGV_LINE_REGEX = /^( {2,}argv:) .+$/gm;
const EXEC_PATH_LINE_REGEX = /^( {2,}execPath:) .+$/gm;
const NVM_PATH_LINE_REGEX = /\/\.nvm\/versions\/node\/v[\d.]+\/bin/g;
const DEVICE_CONNECTION_STATUS_REGEX = /\[✓\]|\[✗\]/g;

function normalizeResourceOutput(text: string): string {
  let normalized = normalizeSnapshotOutput(text);
  normalized = normalized.replace(PROCESS_UPTIME_MS_REGEX, '"uptimeMs": <UPTIME>');
  normalized = normalized.replace(PROCESS_RSS_BYTES_REGEX, '"rssBytes": <BYTES>');
  normalized = normalized.replace(PROCESS_HEAP_BYTES_REGEX, '"heapUsedBytes": <BYTES>');
  normalized = normalized.replace(PROCESS_TREE_LINE_REGEX, '   <PID> (ppid <PID>): <PROCESS>');
  normalized = normalized.replace(NVM_PATH_LINE_REGEX, '/.nvm/versions/node/<NODE_VERSION>/bin');
  normalized = normalized.replace(ARGV_LINE_REGEX, '$1 <ARGV>');
  normalized = normalized.replace(EXEC_PATH_LINE_REGEX, '$1 <EXEC_PATH>');
  normalized = normalized.replace(DEVICE_CONNECTION_STATUS_REGEX, '[<STATUS>]');
  return normalized;
}

export interface ResourceSnapshotResult {
  text: string;
  rawText: string;
}

function resolveResourceManifest(resourceId: string): ResourceManifestEntry | null {
  const manifest = loadManifest();
  return manifest.resources.get(resourceId) ?? null;
}

function isDefinedEnvEntry(entry: [string, string | undefined]): entry is [string, string] {
  return entry[1] !== undefined;
}

function createSnapshotHarnessEnv(overrides: Record<string, string>): Record<string, string> {
  const { VITEST: _vitest, NODE_ENV: _nodeEnv, ...rest } = process.env;
  const env = Object.fromEntries(Object.entries(rest).filter(isDefinedEnvEntry));
  return { ...env, ...overrides };
}

function extractResourceText(result: unknown): string {
  const contents = (result as { contents?: unknown }).contents;
  if (!Array.isArray(contents)) {
    throw new Error('MCP resource snapshot result did not include a contents array.');
  }

  const contentBlocks: string[] = [];
  for (const entry of contents) {
    if (!entry || typeof entry !== 'object') {
      throw new Error('MCP resource snapshot result contained an invalid content block.');
    }

    const typedEntry = entry as { text?: unknown };
    if (typeof typedEntry.text !== 'string') {
      throw new Error('MCP resource snapshot result contained a non-text content block.');
    }

    contentBlocks.push(typedEntry.text);
  }

  return `${contentBlocks.join('\n')}\n`;
}

export async function invokeResource(resourceId: string): Promise<ResourceSnapshotResult> {
  const manifest = resolveResourceManifest(resourceId);
  if (!manifest) {
    throw new Error(`Resource '${resourceId}' not found in manifest`);
  }

  const transport = new StdioClientTransport({
    command: 'node',
    args: [CLI_PATH, 'mcp'],
    env: createSnapshotHarnessEnv({
      NODE_ENV: 'test',
      MOBILEBUILDMCP_ENABLED_WORKFLOWS: '',
    }),
    stderr: 'pipe',
  });

  const client = new Client({ name: 'resource-snapshot-client', version: '1.0.0' });

  try {
    await client.connect(transport, { timeout: 30_000 });
    const result = await client.readResource({ uri: manifest.uri }, { timeout: 120_000 });
    const rawText = extractResourceText(result);

    return {
      text: normalizeResourceOutput(rawText),
      rawText,
    };
  } finally {
    await client.close();
  }
}
