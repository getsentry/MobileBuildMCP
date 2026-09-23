import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DaemonClient } from '../../cli/daemon-client.ts';
import { startDaemonServer } from '../daemon-server.ts';
import type { ToolCatalog, ToolDefinition } from '../../runtime/types.ts';

const xcodeIdeInvokeToolMock = vi.hoisted(() => vi.fn());
const xcodeIdeDisconnectMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('../../integrations/xcode-tools-bridge/tool-service.ts', () => ({
  XcodeIdeToolService: class {
    setWorkflowEnabled = vi.fn();
    listTools = vi.fn(async () => []);
    invokeTool = xcodeIdeInvokeToolMock;
    disconnect = xcodeIdeDisconnectMock;
  },
}));

vi.mock('../../integrations/xcode-tools-bridge/bridge-response-artifact.ts', () => ({
  writeBridgeCallResponseArtifact: vi.fn(async () => ({ path: '/tmp/bridge-response.json' })),
}));

function createCatalog(tools: ToolDefinition[]): ToolCatalog {
  return {
    tools,
    getByCliName: (name) => tools.find((tool) => tool.cliName === name) ?? null,
    getByMcpName: (name) => tools.find((tool) => tool.mcpName === name) ?? null,
    getByToolId: (toolId) => tools.find((tool) => tool.id === toolId) ?? null,
    resolve: (input) => {
      const tool =
        tools.find((candidate) => candidate.cliName === input) ??
        tools.find((candidate) => candidate.mcpName === input);
      return tool ? { tool } : { notFound: true };
    },
  };
}

async function createSocketPath(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'mobilebuildmcp-daemon-'));
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

describe('daemon tool.invoke streaming', () => {
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
    xcodeIdeInvokeToolMock.mockReset();
    xcodeIdeDisconnectMock.mockClear();
  });

  it('streams fragments to the daemon client callback and still returns a terminal structured result', async () => {
    const tool: ToolDefinition = {
      cliName: 'stream-tool',
      mcpName: 'stream_tool',
      workflow: 'simulator',
      description: 'stream tool',
      cliSchema: {},
      mcpSchema: {},
      stateful: true,
      handler: async (_params, ctx) => {
        ctx.emit({
          kind: 'infrastructure',
          fragment: 'status',
          level: 'info',
          message: 'Starting build',
        });
        ctx.emit({
          kind: 'transcript',
          fragment: 'process-line',
          stream: 'stderr',
          line: 'Build Log: /tmp/build.log',
        });
        ctx.nextStepConditionKeys = ['build_artifact_available'];
        ctx.nextSteps = [{ label: 'Open the build log' }];
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
    };

    const socketPath = await createSocketPath();
    cleanupPaths.push(socketPath);

    const server = startDaemonServer({
      socketPath,
      startedAt: new Date().toISOString(),
      enabledWorkflows: ['simulator'],
      catalog: createCatalog([tool]),
      workspaceRoot: '/repo',
      workspaceKey: 'repo-key',
      xcodeIdeWorkflowEnabled: false,
      requestShutdown: () => {},
    });
    cleanupServers.push(server);
    await listen(server, socketPath);

    const client = new DaemonClient({ socketPath, timeout: 1000 });
    const progress: string[] = [];
    const result = await client.invokeTool(
      'stream_tool',
      {},
      {
        onFragment: (fragment) => {
          progress.push(fragment.fragment);
        },
      },
    );

    expect(progress).toEqual(['status', 'process-line']);
    expect(result).toEqual({
      structuredOutput: {
        schema: 'mobilebuildmcp.output.simulator-list',
        schemaVersion: '1',
        result: {
          kind: 'simulator-list',
          didError: false,
          error: null,
          simulators: [],
        },
      },
      nextStepConditionKeys: ['build_artifact_available'],
      nextSteps: [{ label: 'Open the build log' }],
    });
  });

  it('includes daemon instance identity in status', async () => {
    const socketPath = await createSocketPath();
    cleanupPaths.push(socketPath);

    const server = startDaemonServer({
      socketPath,
      startedAt: '2026-05-05T00:00:00.000Z',
      enabledWorkflows: ['simulator'],
      catalog: createCatalog([]),
      workspaceRoot: '/repo',
      workspaceKey: 'repo-key',
      instanceId: 'daemon-instance-a',
      xcodeIdeWorkflowEnabled: false,
      requestShutdown: () => {},
    });
    cleanupServers.push(server);
    await listen(server, socketPath);

    const client = new DaemonClient({ socketPath, timeout: 1000 });

    await expect(client.status()).resolves.toMatchObject({
      instanceId: 'daemon-instance-a',
      workspaceRoot: '/repo',
      workspaceKey: 'repo-key',
    });
  });

  it('returns a terminal structured error when the handler throws', async () => {
    const tool: ToolDefinition = {
      cliName: 'failing-tool',
      mcpName: 'failing_tool',
      workflow: 'simulator',
      description: 'failing tool',
      cliSchema: {},
      mcpSchema: {},
      stateful: true,
      handler: async () => {
        throw new Error('boom');
      },
    };

    const socketPath = await createSocketPath();
    cleanupPaths.push(socketPath);

    const server = startDaemonServer({
      socketPath,
      startedAt: new Date().toISOString(),
      enabledWorkflows: ['simulator'],
      catalog: createCatalog([tool]),
      workspaceRoot: '/repo',
      workspaceKey: 'repo-key',
      xcodeIdeWorkflowEnabled: false,
      requestShutdown: () => {},
    });
    cleanupServers.push(server);
    await listen(server, socketPath);

    const client = new DaemonClient({ socketPath, timeout: 1000 });
    const result = await client.invokeTool('failing_tool', {});

    expect(result.structuredOutput?.result).toEqual(
      expect.objectContaining({
        kind: 'error',
        didError: true,
        code: 'DIRECT_HANDLER_FAILED',
        error: 'Tool execution failed: boom',
      }),
    );
  });

  it('returns a terminal xcode-ide structured error when bridge invocation throws', async () => {
    xcodeIdeInvokeToolMock.mockRejectedValueOnce(new Error('bridge unavailable'));

    const socketPath = await createSocketPath();
    cleanupPaths.push(socketPath);

    const server = startDaemonServer({
      socketPath,
      startedAt: new Date().toISOString(),
      enabledWorkflows: ['xcode-ide'],
      catalog: createCatalog([]),
      workspaceRoot: '/repo',
      workspaceKey: 'repo-key',
      xcodeIdeWorkflowEnabled: true,
      requestShutdown: () => {},
    });
    cleanupServers.push(server);
    await listen(server, socketPath);

    const client = new DaemonClient({ socketPath, timeout: 1000 });
    const result = await client.invokeXcodeIdeTool('FailingRemote', {});

    expect(result.isError).toBe(true);
    expect(result.structuredOutput).toEqual({
      schema: 'mobilebuildmcp.output.xcode-bridge-call-result',
      schemaVersion: '3',
      result: {
        kind: 'xcode-bridge-call-result',
        remoteTool: 'FailingRemote',
        didError: true,
        error: 'bridge unavailable',
        succeeded: false,
        content: [{ type: 'text', text: 'bridge unavailable' }],
      },
    });
  });

  it('forwards Xcode IDE next-step condition keys through the daemon', async () => {
    xcodeIdeInvokeToolMock.mockResolvedValueOnce({
      content: [],
      nextStepConditionKeys: ['build_artifact_available'],
    });

    const socketPath = await createSocketPath();
    cleanupPaths.push(socketPath);

    const server = startDaemonServer({
      socketPath,
      startedAt: new Date().toISOString(),
      enabledWorkflows: ['xcode-ide'],
      catalog: createCatalog([]),
      workspaceRoot: '/repo',
      workspaceKey: 'repo-key',
      xcodeIdeWorkflowEnabled: true,
      requestShutdown: () => {},
    });
    cleanupServers.push(server);
    await listen(server, socketPath);

    const client = new DaemonClient({ socketPath, timeout: 1000 });
    const result = await client.invokeXcodeIdeTool('BuildRemote', {});

    expect(result.nextStepConditionKeys).toEqual(['build_artifact_available']);
  });
});
