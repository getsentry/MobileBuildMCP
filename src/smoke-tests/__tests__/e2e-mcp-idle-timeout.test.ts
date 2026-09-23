import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, it } from 'vitest';
const CLI_PATH = join(process.cwd(), 'build/cli.js');
const MCP_IDLE_TIMEOUT_MS = 1_000;
const MCP_BASELINE_WAIT_MS = 2_000;
const MCP_CONNECT_TIMEOUT_MS = 10_000;
const MCP_EXIT_WAIT_MS = 8_000;
const MCP_TEST_TIMEOUT_MS = 30_000;

type ChildExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

function getSmokeTestEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const { VITEST: _vitest, NODE_ENV: _nodeEnv, ...rest } = process.env;
  const env = Object.fromEntries(
    Object.entries(rest).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  return { ...env, ...overrides };
}

let activeClient: Client | null = null;
let activeChild: ChildProcess | null = null;

function collectOutput(stream: Readable | null): () => string {
  let output = '';
  stream?.setEncoding('utf8');
  stream?.on('data', (chunk: string | Buffer) => {
    output += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  });
  return () => output;
}

function getTransportChildIfSpawned(transport: StdioClientTransport): ChildProcess | null {
  return (transport as unknown as { _process?: ChildProcess })._process ?? null;
}

function getTransportChild(transport: StdioClientTransport): ChildProcess {
  const child = getTransportChildIfSpawned(transport);
  if (!child) {
    throw new Error('MCP stdio transport did not expose a spawned child process.');
  }
  return child;
}

function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
  getDiagnostics: () => string,
): Promise<ChildExit> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `MCP server process did not exit within ${timeoutMs}ms. stderr:\n${getDiagnostics()}`,
        ),
      );
    }, timeoutMs);

    const cleanup = (): void => {
      clearTimeout(timeout);
      child.removeListener('close', onClose);
    };

    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      resolve({ code, signal });
    };

    child.once('close', onClose);
  });
}

function waitForUnexpectedExit(child: ChildProcess, timeoutMs: number): Promise<ChildExit | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);

    const cleanup = (): void => {
      clearTimeout(timeout);
      child.removeListener('close', onClose);
    };

    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      resolve({ code, signal });
    };

    child.once('close', onClose);
  });
}

async function cleanupActiveProcess(): Promise<void> {
  const client = activeClient;
  const child = activeChild;
  activeClient = null;
  activeChild = null;

  if (child && child.exitCode === null && child.signalCode === null) {
    await client?.close().catch(() => undefined);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await waitForExit(child, 2_000, () => '').catch(() => undefined);
    }
  }
}

afterEach(async () => {
  await cleanupActiveProcess();
});

describe('MCP server idle timeout e2e', () => {
  it(
    'stays running when the idle timeout is not configured',
    async () => {
      if (!existsSync(CLI_PATH)) {
        throw new Error(
          'MCP idle timeout e2e test requires build/cli.js. Run npm run build first.',
        );
      }

      const transport = new StdioClientTransport({
        command: 'node',
        args: [CLI_PATH, 'mcp'],
        cwd: process.cwd(),
        env: getSmokeTestEnv({
          SENTRY_DISABLED: 'true',
          MOBILEBUILDMCP_ENABLED_WORKFLOWS: 'simulator',
          MOBILEBUILDMCP_DISABLE_SESSION_DEFAULTS: 'true',
          MOBILEBUILDMCP_DISABLE_XCODE_AUTO_SYNC: '1',
        }),
        stderr: 'pipe',
      });
      const getStderr = collectOutput(transport.stderr as Readable | null);
      const client = new Client({ name: 'mcp-idle-timeout-baseline-client', version: '1.0.0' });

      activeClient = client;
      try {
        await client.connect(transport, { timeout: MCP_CONNECT_TIMEOUT_MS });
      } catch (error) {
        activeChild = getTransportChildIfSpawned(transport);
        throw error;
      }
      const child = getTransportChild(transport);
      activeChild = child;

      const tools = await client.listTools(undefined, { timeout: 10_000 });
      expect(tools.tools.length).toBeGreaterThan(0);

      const unexpectedExit = await waitForUnexpectedExit(child, MCP_BASELINE_WAIT_MS);
      expect(unexpectedExit).toBeNull();
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
      expect(getStderr()).toContain('MCP idle shutdown disabled');

      await client.close();
      activeClient = null;
      const exit = await waitForExit(child, 2_000, getStderr);
      activeChild = null;
      expect(exit).toEqual({ code: 0, signal: null });
    },
    MCP_TEST_TIMEOUT_MS,
  );

  it(
    'exits gracefully after the opt-in idle timeout',
    async () => {
      if (!existsSync(CLI_PATH)) {
        throw new Error(
          'MCP idle timeout e2e test requires build/cli.js. Run npm run build first.',
        );
      }

      const transport = new StdioClientTransport({
        command: 'node',
        args: [CLI_PATH, 'mcp'],
        cwd: process.cwd(),
        env: getSmokeTestEnv({
          SENTRY_DISABLED: 'true',
          MOBILEBUILDMCP_ENABLED_WORKFLOWS: 'simulator',
          MOBILEBUILDMCP_DISABLE_SESSION_DEFAULTS: 'true',
          MOBILEBUILDMCP_DISABLE_XCODE_AUTO_SYNC: '1',
          MOBILEBUILDMCP_MCP_IDLE_TIMEOUT_MS: String(MCP_IDLE_TIMEOUT_MS),
        }),
        stderr: 'pipe',
      });
      const getStderr = collectOutput(transport.stderr as Readable | null);
      const client = new Client({ name: 'mcp-idle-timeout-e2e-client', version: '1.0.0' });

      activeClient = client;
      try {
        await client.connect(transport, { timeout: MCP_CONNECT_TIMEOUT_MS });
      } catch (error) {
        activeChild = getTransportChildIfSpawned(transport);
        throw error;
      }
      const child = getTransportChild(transport);
      activeChild = child;

      const tools = await client.listTools(undefined, { timeout: 10_000 });
      expect(tools.tools.length).toBeGreaterThan(0);

      const exit = await waitForExit(child, MCP_EXIT_WAIT_MS, getStderr);
      activeClient = null;
      activeChild = null;

      expect(exit).toEqual({ code: 0, signal: null });
      expect(getStderr()).toContain('MCP idle timeout reached');
    },
    MCP_TEST_TIMEOUT_MS,
  );
});
