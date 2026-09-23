import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ToolResponse } from '../../types/common.ts';
import type { AnyFragment, DomainFragment } from '../../types/domain-fragments.ts';
import type { RuntimeStatusFragment } from '../../types/runtime-status.ts';
import type { DaemonToolResult, ToolInvokeResult } from '../../daemon/protocol.ts';
import type { ToolDefinition } from '../types.ts';
import { createToolCatalog } from '../tool-catalog.ts';
import { DefaultToolInvoker } from '../tool-invoker.ts';
import { createRenderSession } from '../../rendering/render.ts';
import type { StructuredToolOutput, ToolHandlerContext } from '../../rendering/types.ts';
import { createStructuredErrorOutput } from '../../utils/structured-error.ts';
import { DaemonVersionMismatchError } from '../../cli/daemon-client.ts';
import { ensureDaemonRunning, forceStopDaemon } from '../../cli/daemon-control.ts';

const daemonClientMock = {
  isRunning: vi.fn<() => Promise<boolean>>(),
  invokeXcodeIdeTool:
    vi.fn<(name: string, args: Record<string, unknown>) => Promise<DaemonToolResult>>(),
  invokeTool:
    vi.fn<
      (
        name: string,
        args: Record<string, unknown>,
        options?: { onFragment?: (fragment: AnyFragment) => void },
      ) => Promise<ToolInvokeResult>
    >(),
  listTools: vi.fn<() => Promise<Array<{ name: string }>>>(),
};

vi.mock('../../cli/daemon-client.ts', () => {
  class VersionMismatchError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'DaemonVersionMismatchError';
    }
  }
  return {
    DaemonClient: class {
      isRunning = daemonClientMock.isRunning;
      invokeXcodeIdeTool = daemonClientMock.invokeXcodeIdeTool;
      invokeTool = daemonClientMock.invokeTool;
      listTools = daemonClientMock.listTools;
    },
    DaemonVersionMismatchError: VersionMismatchError,
  };
});

vi.mock('../../cli/daemon-control.ts', () => ({
  ensureDaemonRunning: vi.fn(),
  forceStopDaemon: vi.fn(),
  DEFAULT_DAEMON_STARTUP_TIMEOUT_MS: 5000,
}));

function statusFragment(
  level: 'info' | 'warning' | 'error' | 'success',
  message: string,
): RuntimeStatusFragment {
  return { kind: 'infrastructure', fragment: 'status', level, message };
}

function daemonResult(text: string, opts?: Partial<DaemonToolResult>): DaemonToolResult {
  return {
    structuredOutput: {
      schema: 'mobilebuildmcp.output.xcode-bridge-call-result',
      schemaVersion: '2',
      result: {
        kind: 'xcode-bridge-call-result',
        remoteTool: 'Alpha',
        didError: false,
        error: null,
        succeeded: true,
        content: [{ type: 'text', text }],
      },
    },
    isError: false,
    ...opts,
  };
}

function structuredTextOutput(text: string): StructuredToolOutput {
  return {
    schema: 'mobilebuildmcp.output.debug-command-result',
    schemaVersion: '1',
    result: {
      kind: 'debug-command-result',
      didError: false,
      error: null,
      command: 'test',
      outputLines: [text],
    },
  };
}

function streamedToolResult(opts: Partial<ToolInvokeResult> = {}): ToolInvokeResult {
  return {
    structuredOutput: structuredTextOutput('daemon-result'),
    ...opts,
  };
}

function makeTool(opts: {
  cliName: string;
  mcpName?: string;
  id?: string;
  nextStepTemplates?: ToolDefinition['nextStepTemplates'];
  workflow: string;
  stateful: boolean;
  handler: ToolDefinition['handler'];
  xcodeIdeRemoteToolName?: string;
}): ToolDefinition {
  return {
    id: opts.id,
    cliName: opts.cliName,
    mcpName: opts.mcpName ?? opts.cliName.replace(/-/g, '_'),
    nextStepTemplates: opts.nextStepTemplates,
    workflow: opts.workflow,
    description: `${opts.cliName} tool`,
    mcpSchema: { value: z.string().optional() },
    cliSchema: { value: z.string().optional() },
    stateful: opts.stateful,
    xcodeIdeRemoteToolName: opts.xcodeIdeRemoteToolName,
    handler: opts.handler,
  };
}

function invokeAndFinalize(
  invoker: DefaultToolInvoker,
  toolName: string,
  args: Record<string, unknown>,
  opts: {
    runtime: 'cli' | 'daemon' | 'mcp';
    socketPath?: string;
    workspaceRoot?: string;
    cliExposedWorkflowIds?: string[];
  },
): Promise<ToolResponse & { structuredOutput?: StructuredToolOutput }> {
  const session = createRenderSession('text');
  const promise = invoker.invoke(toolName, args, { ...opts, renderSession: session });
  return promise.then(() => {
    const text = session.finalize();
    const response: ToolResponse = {
      content: text ? [{ type: 'text', text }] : [],
      isError: session.isError() || undefined,
      nextSteps: undefined,
      structuredOutput: session.getStructuredOutput?.(),
    };
    return response;
  });
}

function emitHandler(text: string): ToolDefinition['handler'] {
  return vi.fn(async (_params, ctx) => {
    ctx.structuredOutput = structuredTextOutput(text);
  });
}

function emitErrorHandler(text: string): ToolDefinition['handler'] {
  return vi.fn(async (_params, ctx) => {
    ctx.emit(statusFragment('error', text));
  });
}

function emitNextStepsHandler(
  text: string,
  nextSteps: ToolResponse['nextSteps'],
  nextStepParams?: ToolResponse['nextStepParams'],
): ToolDefinition['handler'] {
  return vi.fn(async (_params, ctx) => {
    ctx.structuredOutput = structuredTextOutput(text);
    if (nextSteps) ctx.nextSteps = nextSteps;
    if (nextStepParams) ctx.nextStepParams = nextStepParams;
  });
}

function emitErrorEventsHandler(events: AnyFragment[]): ToolDefinition['handler'] {
  return vi.fn(async (_params, ctx) => {
    for (const event of events) {
      ctx.emit(event);
    }
  });
}

describe('DefaultToolInvoker CLI routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    daemonClientMock.isRunning.mockResolvedValue(true);
    daemonClientMock.invokeXcodeIdeTool.mockResolvedValue(daemonResult('daemon-xcode-ide-result'));
    daemonClientMock.invokeTool.mockImplementation(async (_name, _args, options) => {
      options?.onFragment?.({
        kind: 'infrastructure',
        fragment: 'status',
        level: 'info',
        message: 'daemon-result',
      });
      return streamedToolResult();
    });
    daemonClientMock.listTools.mockResolvedValue([]);
  });

  it('uses direct invocation for stateless tools', async () => {
    const directHandler = emitHandler('direct-result');
    const catalog = createToolCatalog([
      makeTool({
        cliName: 'list-sims',
        workflow: 'simulator',
        stateful: false,
        handler: directHandler,
      }),
    ]);
    const invoker = new DefaultToolInvoker(catalog);

    const response = await invokeAndFinalize(
      invoker,
      'list-sims',
      { value: 'hello' },
      {
        runtime: 'cli',
        socketPath: '/tmp/mobilebuildmcp.sock',
      },
    );

    expect(directHandler).toHaveBeenCalledWith(
      { value: 'hello' },
      expect.objectContaining({
        emit: expect.any(Function),
        attach: expect.any(Function),
      }),
    );
    expect(daemonClientMock.isRunning).not.toHaveBeenCalled();
    expect(daemonClientMock.invokeTool).not.toHaveBeenCalled();
    expect(response.content[0].text).toContain('direct-result');
  });

  it('sets explicit structured error output for unresolved tool names', async () => {
    const catalog = createToolCatalog([
      makeTool({
        cliName: 'list-sims',
        workflow: 'simulator',
        stateful: false,
        handler: emitHandler('direct-result'),
      }),
    ]);
    const invoker = new DefaultToolInvoker(catalog);

    const response = await invokeAndFinalize(invoker, 'missing-tool', {}, { runtime: 'cli' });

    expect(response.isError).toBe(true);
    expect(response.structuredOutput?.schema).toBe('mobilebuildmcp.output.error');
    expect(response.structuredOutput?.result).toEqual(
      expect.objectContaining({
        kind: 'error',
        didError: true,
        code: 'TOOL_NOT_FOUND',
      }),
    );
    expect(response.content[0].text).toContain("Unknown tool 'missing-tool'");
  });

  it('injects direct invocation progress and structured output hooks into the handler context', async () => {
    const progressEvents: Array<{ kind: string }> = [];
    const structuredOutputs: string[] = [];
    const handler = vi.fn(async (_params, ctx) => {
      ctx.emit(statusFragment('info', 'Working'));
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
    });

    const catalog = createToolCatalog([
      makeTool({
        cliName: 'list-sims',
        workflow: 'simulator',
        stateful: false,
        handler,
      }),
    ]);
    const invoker = new DefaultToolInvoker(catalog);

    await invoker.invokeDirect(
      catalog.tools[0],
      {},
      {
        runtime: 'cli',
        renderSession: createRenderSession('text'),
        onProgress: (fragment) => {
          progressEvents.push({ kind: fragment.kind });
        },
        onStructuredOutput: (output) => {
          structuredOutputs.push(output.schema);
        },
      },
    );

    expect(handler).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        emit: expect.any(Function),
      }),
    );
    expect(progressEvents).toEqual([{ kind: 'infrastructure' }]);
    expect(structuredOutputs).toEqual(['mobilebuildmcp.output.simulator-list']);
  });

  it('sets explicit structured error output when direct handlers throw', async () => {
    const catalog = createToolCatalog([
      makeTool({
        cliName: 'list-sims',
        workflow: 'simulator',
        stateful: false,
        handler: vi.fn(async () => {
          throw new Error('boom');
        }),
      }),
    ]);
    const invoker = new DefaultToolInvoker(catalog);

    const response = await invokeAndFinalize(invoker, 'list-sims', {}, { runtime: 'cli' });

    expect(response.isError).toBe(true);
    expect(response.structuredOutput?.result).toEqual(
      expect.objectContaining({
        kind: 'error',
        didError: true,
        code: 'DIRECT_HANDLER_FAILED',
        error: 'Tool execution failed: boom',
      }),
    );
  });

  it('keeps daemon handler failures as terminal structured output instead of protocol errors', async () => {
    const handlerContext: ToolHandlerContext = {
      emit: () => {},
      attach: () => {},
    };
    const catalog = createToolCatalog([
      makeTool({
        cliName: 'list-sims',
        workflow: 'simulator',
        stateful: false,
        handler: vi.fn(async () => {
          throw new Error('boom');
        }),
      }),
    ]);
    const invoker = new DefaultToolInvoker(catalog);

    await expect(
      invoker.invokeDirect(
        catalog.tools[0],
        {},
        {
          runtime: 'daemon',
          handlerContext,
          renderSession: createRenderSession('text'),
        },
      ),
    ).resolves.toBeUndefined();

    expect(handlerContext.structuredOutput?.result).toEqual(
      expect.objectContaining({
        kind: 'error',
        didError: true,
        code: 'DIRECT_HANDLER_FAILED',
        error: 'Tool execution failed: boom',
      }),
    );
  });

  it('routes stateful tools through daemon and auto-starts when needed', async () => {
    daemonClientMock.isRunning.mockResolvedValue(false);
    const directHandler = emitHandler('direct-result');
    const catalog = createToolCatalog([
      makeTool({
        cliName: 'start-sim-log-cap',
        workflow: 'logging',
        stateful: true,
        handler: directHandler,
      }),
    ]);
    const invoker = new DefaultToolInvoker(catalog);

    const response = await invokeAndFinalize(
      invoker,
      'start-sim-log-cap',
      { value: 'hello' },
      {
        runtime: 'cli',
        socketPath: '/tmp/mobilebuildmcp.sock',
        workspaceRoot: '/repo',
      },
    );

    expect(ensureDaemonRunning).toHaveBeenCalledWith(
      expect.objectContaining({
        socketPath: '/tmp/mobilebuildmcp.sock',
        workspaceRoot: '/repo',
        env: undefined,
      }),
    );
    expect(daemonClientMock.invokeTool).toHaveBeenCalledWith(
      'start_sim_log_cap',
      {
        value: 'hello',
      },
      expect.objectContaining({
        onFragment: expect.any(Function),
      }),
    );
    expect(directHandler).not.toHaveBeenCalled();
    expect(response.content[0].text).toContain('daemon-result');
  });

  it('renders restart failure when force-stopping a protocol-mismatched daemon fails', async () => {
    daemonClientMock.invokeTool.mockRejectedValueOnce(new DaemonVersionMismatchError('old daemon'));
    vi.mocked(forceStopDaemon).mockRejectedValueOnce(new Error('registry metadata changed'));
    const directHandler = emitHandler('direct-result');
    const catalog = createToolCatalog([
      makeTool({
        cliName: 'start-sim-log-cap',
        workflow: 'logging',
        stateful: true,
        handler: directHandler,
      }),
    ]);
    const invoker = new DefaultToolInvoker(catalog);

    const response = await invokeAndFinalize(
      invoker,
      'start-sim-log-cap',
      { value: 'hello' },
      {
        runtime: 'cli',
        socketPath: '/tmp/mobilebuildmcp.sock',
        workspaceRoot: '/repo',
      },
    );

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain(
      'Daemon restart failed after protocol mismatch: registry metadata changed',
    );
    expect(forceStopDaemon).toHaveBeenCalledWith('/tmp/mobilebuildmcp.sock');
    expect(ensureDaemonRunning).not.toHaveBeenCalled();
    expect(directHandler).not.toHaveBeenCalled();
  });

  it('does not replay streamed daemon progress into the final response', async () => {
    daemonClientMock.invokeTool.mockImplementation(async (_name, _args, options) => {
      options?.onFragment?.({
        kind: 'infrastructure',
        fragment: 'status',
        level: 'success',
        message: 'daemon-event-result',
      });
      return streamedToolResult();
    });
    const directHandler = emitHandler('direct-result');
    const catalog = createToolCatalog([
      makeTool({
        cliName: 'start-sim-log-cap',
        workflow: 'logging',
        stateful: true,
        handler: directHandler,
      }),
    ]);
    const invoker = new DefaultToolInvoker(catalog);

    const response = await invokeAndFinalize(
      invoker,
      'start-sim-log-cap',
      { value: 'hello' },
      {
        runtime: 'cli',
        socketPath: '/tmp/mobilebuildmcp.sock',
        workspaceRoot: '/repo',
      },
    );

    expect(response.content[0].text).toContain('daemon-result');
    expect(response.content[0].text).not.toContain('daemon-event-result');
  });
});

describe('DefaultToolInvoker xcode-ide dynamic routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    daemonClientMock.isRunning.mockResolvedValue(true);
    daemonClientMock.invokeXcodeIdeTool.mockResolvedValue(daemonResult('daemon-result'));
    daemonClientMock.invokeTool.mockResolvedValue(streamedToolResult());
    daemonClientMock.listTools.mockResolvedValue([]);
  });

  it('routes dynamic xcode-ide tools through daemon xcode-ide invoke API', async () => {
    daemonClientMock.isRunning.mockResolvedValue(false);
    const directHandler = emitHandler('direct-result');
    const catalog = createToolCatalog([
      makeTool({
        cliName: 'xcode-ide-alpha',
        workflow: 'xcode-ide',
        stateful: false,
        xcodeIdeRemoteToolName: 'Alpha',
        handler: directHandler,
      }),
    ]);
    const invoker = new DefaultToolInvoker(catalog);

    const response = await invokeAndFinalize(
      invoker,
      'xcode-ide-alpha',
      { value: 'hello' },
      {
        runtime: 'cli',
        socketPath: '/tmp/mobilebuildmcp.sock',
        workspaceRoot: '/repo',
        cliExposedWorkflowIds: ['simulator', 'xcode-ide'],
      },
    );

    expect(ensureDaemonRunning).toHaveBeenCalledWith(
      expect.objectContaining({
        socketPath: '/tmp/mobilebuildmcp.sock',
        workspaceRoot: '/repo',
        env: undefined,
      }),
    );
    expect(daemonClientMock.invokeXcodeIdeTool).toHaveBeenCalledWith('Alpha', { value: 'hello' });
    expect(directHandler).not.toHaveBeenCalled();
    expect(response.content[0].text).toContain('Tool "Alpha" completed successfully');
  });

  it('maps dynamic xcode-ide daemon failures to explicit structured error output', async () => {
    daemonClientMock.invokeXcodeIdeTool.mockResolvedValue(
      daemonResult('Remote tool failed', {
        isError: true,
        structuredOutput: {
          schema: 'mobilebuildmcp.output.xcode-bridge-call-result',
          schemaVersion: '2',
          result: {
            kind: 'xcode-bridge-call-result',
            remoteTool: 'Alpha',
            didError: true,
            error: 'Remote tool failed',
            succeeded: false,
            content: [{ type: 'text', text: 'Remote tool failed' }],
          },
        },
      }),
    );
    const directHandler = emitHandler('direct-result');
    const catalog = createToolCatalog([
      makeTool({
        cliName: 'xcode-ide-alpha',
        workflow: 'xcode-ide',
        stateful: false,
        xcodeIdeRemoteToolName: 'Alpha',
        handler: directHandler,
      }),
    ]);
    const invoker = new DefaultToolInvoker(catalog);

    const response = await invokeAndFinalize(
      invoker,
      'xcode-ide-alpha',
      { value: 'hello' },
      {
        runtime: 'cli',
        socketPath: '/tmp/mobilebuildmcp.sock',
        workspaceRoot: '/repo',
        cliExposedWorkflowIds: ['simulator', 'xcode-ide'],
      },
    );

    expect(response.isError).toBe(true);
    expect(response.structuredOutput?.result).toEqual(
      expect.objectContaining({
        kind: 'xcode-bridge-call-result',
        didError: true,
        error: 'Remote tool failed',
      }),
    );
    expect(response.content[0].text).toContain('Remote tool failed');
    expect(directHandler).not.toHaveBeenCalled();
  });

  it('fails for dynamic xcode-ide tools when socket path is missing', async () => {
    const directHandler = emitHandler('direct-result');
    const catalog = createToolCatalog([
      makeTool({
        cliName: 'xcode-ide-alpha',
        workflow: 'xcode-ide',
        stateful: false,
        xcodeIdeRemoteToolName: 'Alpha',
        handler: directHandler,
      }),
    ]);
    const invoker = new DefaultToolInvoker(catalog);

    const response = await invokeAndFinalize(
      invoker,
      'xcode-ide-alpha',
      { value: 'hello' },
      {
        runtime: 'cli',
      },
    );

    expect(response.isError).toBe(true);
    expect(response.structuredOutput?.result).toEqual(
      expect.objectContaining({
        kind: 'error',
        didError: true,
        code: 'SOCKET_PATH_MISSING',
      }),
    );
    expect(response.content[0].text).toContain('No socket path configured');
    expect(directHandler).not.toHaveBeenCalled();
    expect(daemonClientMock.invokeXcodeIdeTool).not.toHaveBeenCalled();
  });
});

describe('DefaultToolInvoker next steps post-processing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    daemonClientMock.isRunning.mockResolvedValue(true);
  });

  it('enriches canonical next-step tool names in CLI runtime', async () => {
    const directHandler = emitNextStepsHandler('ok', [
      {
        tool: 'screenshot',
        label: 'Take screenshot',
        params: { simulatorId: '123' },
      },
    ]);

    const catalog = createToolCatalog([
      makeTool({
        cliName: 'snapshot-ui',
        mcpName: 'snapshot_ui',
        workflow: 'ui-automation',
        stateful: false,
        handler: directHandler,
      }),
      makeTool({
        id: 'screenshot',
        cliName: 'screenshot',
        mcpName: 'screenshot',
        workflow: 'ui-automation',
        stateful: false,
        handler: emitHandler('screenshot'),
      }),
    ]);

    const invoker = new DefaultToolInvoker(catalog);
    const response = await invokeAndFinalize(invoker, 'snapshot-ui', {}, { runtime: 'cli' });

    expect(response.nextSteps).toBeUndefined();
    const text = response.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    expect(text).toContain('Next steps:');
    expect(text).toContain('Take screenshot');
    expect(text).toContain('mobilebuildmcp ui-automation screenshot --simulator-id 123');
  });

  it('prefers the current workflow when normalizing duplicate next-step tool names', async () => {
    const directHandler = emitNextStepsHandler('ok', [
      {
        tool: 'screenshot',
        label: 'Take screenshot',
        params: { simulatorId: '123' },
      },
    ]);

    const catalog = createToolCatalog([
      makeTool({
        id: 'snapshot_ui',
        cliName: 'snapshot-ui',
        mcpName: 'snapshot_ui',
        workflow: 'ui-automation',
        stateful: false,
        handler: directHandler,
      }),
      makeTool({
        id: 'screenshot',
        cliName: 'screenshot',
        mcpName: 'screenshot',
        workflow: 'simulator',
        stateful: false,
        handler: emitHandler('simulator screenshot'),
      }),
      makeTool({
        id: 'screenshot',
        cliName: 'screenshot',
        mcpName: 'screenshot',
        workflow: 'ui-automation',
        stateful: false,
        handler: emitHandler('ui screenshot'),
      }),
    ]);

    const invoker = new DefaultToolInvoker(catalog);
    const response = await invokeAndFinalize(invoker, 'snapshot-ui', {}, { runtime: 'cli' });

    const text = response.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    expect(text).toContain('mobilebuildmcp ui-automation screenshot --simulator-id 123');
    expect(text).not.toContain('mobilebuildmcp simulator screenshot --simulator-id 123');
  });

  it('injects manifest template next steps from dynamic nextStepParams when response omits nextSteps', async () => {
    const directHandler = emitNextStepsHandler('ok', undefined, {
      snapshot_ui: { simulatorId: '12345678-1234-4234-8234-123456789012' },
      tap: { simulatorId: '12345678-1234-4234-8234-123456789012', x: 0, y: 0 },
    });

    const catalog = createToolCatalog([
      makeTool({
        id: 'snapshot_ui',
        cliName: 'snapshot-ui',
        mcpName: 'snapshot_ui',
        workflow: 'ui-automation',
        stateful: false,
        nextStepTemplates: [
          {
            label: 'Refresh',
            toolId: 'snapshot_ui',
            params: { simulatorId: 'SIMULATOR_UUID' },
          },
          {
            label: 'Visually verify hierarchy output',
          },
          {
            label: 'Tap on element',
            toolId: 'tap',
            params: { simulatorId: 'SIMULATOR_UUID', x: 0, y: 0 },
          },
        ],
        handler: directHandler,
      }),
      makeTool({
        id: 'tap',
        cliName: 'tap',
        mcpName: 'tap',
        workflow: 'ui-automation',
        stateful: false,
        handler: emitHandler('tap'),
      }),
    ]);

    const invoker = new DefaultToolInvoker(catalog);
    const response = await invokeAndFinalize(invoker, 'snapshot-ui', {}, { runtime: 'cli' });

    expect(response.nextSteps).toBeUndefined();
    const text = response.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    expect(text).toContain('Refresh');
    expect(text).toContain('snapshot-ui');
    expect(text).toContain('Visually verify hierarchy output');
    expect(text).toContain('Tap on element');
    expect(text).toContain('tap');
  });

  it('does not inject manifest template next steps when the tool explicitly returns an empty list', async () => {
    const directHandler = emitNextStepsHandler('ok', []);

    const catalog = createToolCatalog([
      makeTool({
        id: 'list_devices',
        cliName: 'list',
        mcpName: 'list_devices',
        workflow: 'device',
        stateful: false,
        nextStepTemplates: [{ label: 'Build for device', toolId: 'build_device' }],
        handler: directHandler,
      }),
      makeTool({
        id: 'build_device',
        cliName: 'build',
        mcpName: 'build_device',
        workflow: 'device',
        stateful: false,
        handler: emitHandler('build'),
      }),
    ]);

    const invoker = new DefaultToolInvoker(catalog);
    const response = await invokeAndFinalize(invoker, 'list', {}, { runtime: 'cli' });

    expect(response.nextSteps).toBeUndefined();
    const text = response.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    expect(text).toContain('ok');
    expect(text).not.toContain('Next steps:');
  });

  it('prefers manifest templates over tool-provided next-step labels and tools', async () => {
    const directHandler = emitNextStepsHandler(
      'ok',
      [
        {
          tool: 'legacy_stop_sim_log_cap',
          label: 'Old label',
          params: { logSessionId: 'session-123' },
          priority: 99,
        },
      ],
      {
        stop_sim_log_cap: { logSessionId: 'session-123' },
      },
    );

    const catalog = createToolCatalog([
      makeTool({
        id: 'start_sim_log_cap',
        cliName: 'start-simulator-log-capture',
        mcpName: 'start_sim_log_cap',
        workflow: 'logging',
        stateful: false,
        nextStepTemplates: [
          {
            label: 'Stop capture and retrieve logs',
            toolId: 'stop_sim_log_cap',
            priority: 1,
          },
        ],
        handler: directHandler,
      }),
      makeTool({
        id: 'stop_sim_log_cap',
        cliName: 'stop-simulator-log-capture',
        mcpName: 'stop_sim_log_cap',
        workflow: 'logging',
        stateful: true,
        handler: emitHandler('stop'),
      }),
    ]);

    const invoker = new DefaultToolInvoker(catalog);
    const response = await invokeAndFinalize(
      invoker,
      'start-simulator-log-capture',
      {},
      { runtime: 'cli' },
    );

    expect(response.nextSteps).toBeUndefined();
    const text = response.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    expect(text).toContain('Stop capture and retrieve logs');
    expect(text).toContain('stop-simulator-log-capture');
    expect(text).toContain('session-123');
  });

  it('preserves daemon-provided next-step params when nextStepParams are already consumed', async () => {
    daemonClientMock.invokeTool.mockResolvedValue(
      streamedToolResult({
        nextSteps: [
          {
            tool: 'stop_sim_log_cap',
            label: 'Stop capture and retrieve logs',
            params: { logSessionId: 'session-123' },
            priority: 1,
          },
        ],
      }),
    );

    const catalog = createToolCatalog([
      makeTool({
        id: 'start_sim_log_cap',
        cliName: 'start-simulator-log-capture',
        mcpName: 'start_sim_log_cap',
        workflow: 'logging',
        stateful: true,
        nextStepTemplates: [
          {
            label: 'Stop capture and retrieve logs',
            toolId: 'stop_sim_log_cap',
            priority: 1,
          },
        ],
        handler: emitHandler('start'),
      }),
      makeTool({
        id: 'stop_sim_log_cap',
        cliName: 'stop-simulator-log-capture',
        mcpName: 'stop_sim_log_cap',
        workflow: 'logging',
        stateful: true,
        handler: emitHandler('stop'),
      }),
    ]);

    const invoker = new DefaultToolInvoker(catalog);
    const response = await invokeAndFinalize(
      invoker,
      'start-simulator-log-capture',
      {},
      {
        runtime: 'cli',
        socketPath: '/tmp/mobilebuildmcp.sock',
      },
    );

    expect(response.nextSteps).toBeUndefined();
    const text = response.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    expect(text).toContain('Stop capture and retrieve logs');
    expect(text).toContain('stop-simulator-log-capture');
    expect(text).toContain('session-123');
  });

  it('overrides unresolved template placeholders with dynamic next-step params', async () => {
    const directHandler = emitNextStepsHandler('ok', undefined, {
      boot_sim: { simulatorId: 'ABC-123' },
    });

    const catalog = createToolCatalog([
      makeTool({
        id: 'launch_app_sim',
        cliName: 'launch-app-sim',
        mcpName: 'launch_app_sim',
        workflow: 'simulator',
        stateful: false,
        nextStepTemplates: [
          {
            label: 'Boot simulator',
            toolId: 'boot_sim',
            params: { simulatorId: '${simulatorId}' },
          },
        ],
        handler: directHandler,
      }),
      makeTool({
        id: 'boot_sim',
        cliName: 'boot-sim',
        mcpName: 'boot_sim',
        workflow: 'simulator',
        stateful: false,
        handler: emitHandler('boot'),
      }),
    ]);

    const invoker = new DefaultToolInvoker(catalog);
    const response = await invokeAndFinalize(invoker, 'launch-app-sim', {}, { runtime: 'cli' });

    expect(response.nextSteps).toBeUndefined();
    const text = response.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    expect(text).toContain('Boot simulator');
    expect(text).toContain('boot-sim');
    expect(text).toContain('ABC-123');
  });

  it('maps dynamic params to the correct template tool after catalog filtering', async () => {
    const directHandler = emitNextStepsHandler('ok', undefined, {
      stop_sim_log_cap: { logSessionId: 'session-123' },
    });

    const catalog = createToolCatalog([
      makeTool({
        id: 'start_sim_log_cap',
        cliName: 'start-simulator-log-capture',
        mcpName: 'start_sim_log_cap',
        workflow: 'logging',
        stateful: false,
        nextStepTemplates: [
          {
            label: 'Unavailable step',
            toolId: 'missing_tool',
          },
          {
            label: 'Stop capture and retrieve logs',
            toolId: 'stop_sim_log_cap',
            priority: 1,
          },
        ],
        handler: directHandler,
      }),
      makeTool({
        id: 'stop_sim_log_cap',
        cliName: 'stop-simulator-log-capture',
        mcpName: 'stop_sim_log_cap',
        workflow: 'logging',
        stateful: true,
        handler: emitHandler('stop'),
      }),
    ]);

    const invoker = new DefaultToolInvoker(catalog);
    const response = await invokeAndFinalize(
      invoker,
      'start-simulator-log-capture',
      {},
      { runtime: 'cli' },
    );

    expect(response.nextSteps).toBeUndefined();
    const text = response.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    expect(text).toContain('Stop capture and retrieve logs');
    expect(text).toContain('stop-simulator-log-capture');
    expect(text).toContain('session-123');
  });

  it('does not render failure next steps for emitted error fragments alone', async () => {
    const directHandler = emitErrorEventsHandler([
      {
        kind: 'infrastructure',
        fragment: 'status',
        level: 'error',
        message: 'failed',
      },
    ]);

    const catalog = createToolCatalog([
      makeTool({
        id: 'list_devices',
        cliName: 'list',
        mcpName: 'list_devices',
        workflow: 'device',
        stateful: false,
        nextStepTemplates: [
          {
            label: 'Try building for device',
            toolId: 'build_device',
            when: 'failure',
          },
        ],
        handler: directHandler,
      }),
      makeTool({
        id: 'build_device',
        cliName: 'build-device',
        mcpName: 'build_device',
        workflow: 'device',
        stateful: false,
        handler: emitHandler('build'),
      }),
    ]);

    const invoker = new DefaultToolInvoker(catalog);
    const response = await invokeAndFinalize(invoker, 'list', {}, { runtime: 'cli' });

    expect(response.nextSteps).toBeUndefined();
    const text = response.content.map((item) => (item.type === 'text' ? item.text : '')).join('\n');
    expect(response.isError).toBeUndefined();
    expect(text).not.toContain('Try building for device');
    expect(text).not.toContain('build-device');
  });

  it('renders failure next steps for explicit structured error output', async () => {
    const directHandler: ToolDefinition['handler'] = vi.fn(async (_params, ctx) => {
      ctx.structuredOutput = createStructuredErrorOutput({
        category: 'runtime',
        code: 'ORDINARY_FAILURE',
        message: 'failed',
      });
    });

    const catalog = createToolCatalog([
      makeTool({
        id: 'list_devices',
        cliName: 'list',
        mcpName: 'list_devices',
        workflow: 'device',
        stateful: false,
        nextStepTemplates: [
          {
            label: 'Try building for device',
            toolId: 'build_device',
            when: 'failure',
          },
        ],
        handler: directHandler,
      }),
      makeTool({
        id: 'build_device',
        cliName: 'build-device',
        mcpName: 'build_device',
        workflow: 'device',
        stateful: false,
        handler: emitHandler('build'),
      }),
    ]);

    const invoker = new DefaultToolInvoker(catalog);
    const response = await invokeAndFinalize(invoker, 'list', {}, { runtime: 'cli' });

    expect(response.isError).toBe(true);
    const text = response.content.map((item) => (item.type === 'text' ? item.text : '')).join('\n');
    expect(text).toContain('Try building for device');
    expect(text).toContain('build-device');
  });

  it('suppresses failure next steps for structured xcodebuild failures emitted via handler context', async () => {
    const directHandler: ToolDefinition['handler'] = vi.fn(async (_params, ctx) => {
      const invocationFragment: DomainFragment = {
        kind: 'build-result',
        fragment: 'invocation',
        operation: 'BUILD',
        request: { scheme: 'MyApp' },
      };
      const diagnosticFragment: DomainFragment = {
        kind: 'build-result',
        fragment: 'compiler-diagnostic',
        operation: 'BUILD',
        severity: 'error',
        message: 'Build failed',
        rawLine: 'Build failed',
      };
      ctx.emit(invocationFragment);
      ctx.emit(diagnosticFragment);
      ctx.structuredOutput = {
        schema: 'mobilebuildmcp.output.build-result',
        schemaVersion: '1',
        result: {
          kind: 'build-result',
          didError: true,
          error: 'Build failed',
          summary: { status: 'FAILED', durationMs: 1000 },
          artifacts: {},
          diagnostics: { warnings: [], errors: [] },
        },
      };
    });

    const catalog = createToolCatalog([
      makeTool({
        id: 'build_device',
        cliName: 'build-device',
        mcpName: 'build_device',
        workflow: 'device',
        stateful: false,
        nextStepTemplates: [
          {
            label: 'Try building for device',
            toolId: 'list_devices',
            when: 'failure',
          },
        ],
        handler: directHandler,
      }),
      makeTool({
        id: 'list_devices',
        cliName: 'list-devices',
        mcpName: 'list_devices',
        workflow: 'device',
        stateful: false,
        handler: emitHandler('devices'),
      }),
    ]);

    const invoker = new DefaultToolInvoker(catalog);
    const response = await invokeAndFinalize(invoker, 'build-device', {}, { runtime: 'cli' });

    expect(response.nextSteps).toBeUndefined();
    const text = response.content.map((item) => (item.type === 'text' ? item.text : '')).join('\n');
    expect(text).not.toContain('Try building for device');
    expect(text).not.toContain('list-devices');
  });

  it('always uses manifest templates when they exist', async () => {
    const directHandler = emitNextStepsHandler('ok', [
      {
        tool: 'launch_app_sim',
        label: 'Launch app (platform-specific)',
        params: { simulatorId: '123', bundleId: 'com.example.app' },
        priority: 1,
      },
    ]);

    const catalog = createToolCatalog([
      makeTool({
        id: 'get_sim_app_path',
        cliName: 'get-app-path',
        mcpName: 'get_sim_app_path',
        workflow: 'simulator',
        stateful: false,
        nextStepTemplates: [
          { label: 'Get bundle ID', toolId: 'get_app_bundle_id', priority: 1 },
          { label: 'Boot simulator', toolId: 'boot_sim', priority: 2 },
        ],
        handler: directHandler,
      }),
      makeTool({
        id: 'launch_app_sim',
        cliName: 'launch-app',
        mcpName: 'launch_app_sim',
        workflow: 'simulator',
        stateful: false,
        handler: emitHandler('launch'),
      }),
      makeTool({
        id: 'get_app_bundle_id',
        cliName: 'get-app-bundle-id',
        mcpName: 'get_app_bundle_id',
        workflow: 'project-discovery',
        stateful: false,
        handler: emitHandler('bundle'),
      }),
      makeTool({
        id: 'boot_sim',
        cliName: 'boot',
        mcpName: 'boot_sim',
        workflow: 'simulator',
        stateful: false,
        handler: emitHandler('boot'),
      }),
    ]);

    const invoker = new DefaultToolInvoker(catalog);
    const response = await invokeAndFinalize(invoker, 'get-app-path', {}, { runtime: 'cli' });

    expect(response.nextSteps).toBeUndefined();
    const text = response.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    expect(text).toContain('Get bundle ID');
    expect(text).toContain('get-app-bundle-id');
    expect(text).toContain('Boot simulator');
    expect(text).toContain('boot');
  });
});
