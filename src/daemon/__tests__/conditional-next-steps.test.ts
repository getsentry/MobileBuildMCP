import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createRenderSession } from '../../rendering/render.ts';
import { createToolCatalog } from '../../runtime/tool-catalog.ts';
import { DefaultToolInvoker } from '../../runtime/tool-invoker.ts';
import type { ToolDefinition } from '../../runtime/types.ts';
import { startDaemonServer } from '../daemon-server.ts';

function createTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    id: 'source',
    cliName: 'source',
    mcpName: 'source',
    workflow: 'simulator',
    cliSchema: {},
    mcpSchema: {},
    stateful: true,
    handler: async () => {},
    ...overrides,
  };
}

async function createSocketPath(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'mobilebuildmcp-daemon-conditions-'));
  return path.join(directory, 'daemon.sock');
}

async function listen(server: net.Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

describe('daemon conditional next steps', () => {
  const cleanupPaths: string[] = [];
  const cleanupServers: net.Server[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanupServers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      ),
    );
    await Promise.all(
      cleanupPaths.splice(0).map(async (socketPath) => {
        await rm(path.dirname(socketPath), { recursive: true, force: true });
      }),
    );
  });

  it('selects a manifest template using condition metadata returned by the daemon', async () => {
    const daemonSource = createTool({
      handler: async (_args, ctx) => {
        ctx.nextStepConditionKeys = ['prepared_tests_available'];
        ctx.nextStepParams = {
          test_sim: { testProductsPath: '/tmp/App.xctestproducts' },
        };
        ctx.structuredOutput = {
          schema: 'mobilebuildmcp.output.simulator-list',
          schemaVersion: '1',
          result: {
            kind: 'simulator-list',
            didError: false,
            error: null,
            simulators: [],
          },
        };
      },
    });
    const clientSource = createTool({
      nextStepTemplates: [
        {
          label: 'Run prepared tests',
          toolId: 'test_sim',
          when: 'success',
          condition: 'prepared_tests_available',
        },
      ],
    });
    const testTool = createTool({
      id: 'test_sim',
      cliName: 'test',
      mcpName: 'test_sim',
      stateful: false,
    });
    const socketPath = await createSocketPath();
    cleanupPaths.push(socketPath);

    const server = startDaemonServer({
      socketPath,
      startedAt: new Date().toISOString(),
      enabledWorkflows: ['simulator'],
      catalog: createToolCatalog([daemonSource, testTool]),
      workspaceRoot: '/repo',
      workspaceKey: 'repo-key',
      xcodeIdeWorkflowEnabled: false,
      requestShutdown: () => {},
    });
    cleanupServers.push(server);
    await listen(server, socketPath);

    const session = createRenderSession('text');
    const invoker = new DefaultToolInvoker(createToolCatalog([clientSource, testTool]));
    await invoker.invoke('source', {}, { runtime: 'cli', renderSession: session, socketPath });

    expect(session.getNextSteps?.()).toEqual([
      {
        tool: 'test_sim',
        cliTool: 'test',
        workflow: 'simulator',
        label: 'Run prepared tests',
        params: { testProductsPath: '/tmp/App.xctestproducts' },
        priority: undefined,
        when: 'success',
      },
    ]);
  });
});
