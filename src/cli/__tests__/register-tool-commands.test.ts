import yargs from 'yargs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod';
import type { ToolCatalog, ToolDefinition } from '../../runtime/types.ts';
import type { ToolHandlerContext } from '../../rendering/types.ts';
import { DefaultToolInvoker } from '../../runtime/tool-invoker.ts';
import type { ResolvedRuntimeConfig } from '../../utils/config-store.ts';
import { registerToolCommands } from '../register-tool-commands.ts';
import * as simulatorResolver from '../../utils/simulator-resolver.ts';

function createTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    cliName: 'run-tool',
    mcpName: 'run_tool',
    workflow: 'simulator',
    description: 'Run test tool',
    annotations: { readOnlyHint: true },
    cliSchema: {
      workspacePath: z.string().describe('Workspace path'),
      scheme: z.string().optional(),
    },
    mcpSchema: {
      workspacePath: z.string().describe('Workspace path'),
      scheme: z.string().optional(),
    },
    stateful: false,
    handler: vi.fn(async () => {}) as ToolDefinition['handler'],
    ...overrides,
  };
}

function createCatalog(tools: ToolDefinition[]): ToolCatalog {
  return {
    tools,
    getByCliName: (name) => tools.find((tool) => tool.cliName === name) ?? null,
    getByMcpName: (name) => tools.find((tool) => tool.mcpName === name) ?? null,
    getByToolId: (toolId) => tools.find((tool) => tool.id === toolId) ?? null,
    resolve: (input) => {
      const tool = tools.find((candidate) => candidate.cliName === input);
      return tool ? { tool } : { notFound: true };
    },
  };
}

const baseRuntimeConfig: ResolvedRuntimeConfig = {
  enabledWorkflows: [],
  customWorkflows: {},
  debug: false,
  sentryDisabled: false,
  experimentalWorkflowDiscovery: false,
  disableSessionDefaults: true,
  disableXcodeAutoSync: false,
  showTestTiming: false,
  uiDebuggerGuardMode: 'error',
  incrementalBuildsEnabled: false,
  dapRequestTimeoutMs: 30_000,
  dapLogEvents: false,
  launchJsonWaitMs: 8_000,
  debuggerBackend: 'dap',
  sessionDefaults: {
    workspacePath: 'App.xcworkspace',
  },
  sessionDefaultsProfiles: {
    ios: {
      workspacePath: 'Profile.xcworkspace',
    },
  },
  activeSessionDefaultsProfile: 'ios',
};

function createApp(catalog: ToolCatalog, runtimeConfig: ResolvedRuntimeConfig = baseRuntimeConfig) {
  const app = yargs()
    .scriptName('mobilebuildmcp')
    .exitProcess(false)
    .fail((message, error) => {
      throw error ?? new Error(message);
    });

  registerToolCommands(app, catalog, {
    workspaceRoot: '/repo',
    runtimeConfig,
    cliExposedWorkflowIds: ['simulator'],
    workflowNames: ['simulator'],
  });

  return app;
}

function mockInvokeDirectThroughHandler() {
  return vi
    .spyOn(DefaultToolInvoker.prototype, 'invokeDirect')
    .mockImplementation(async (tool, args, opts) => {
      const handlerContext: ToolHandlerContext = opts.handlerContext ?? {
        emit: (fragment) => {
          opts.onProgress?.(fragment);
          opts.renderSession?.emit(fragment);
        },
        attach: (image) => {
          opts.renderSession?.attach(image);
        },
      };

      await tool.handler(args, handlerContext);

      if (handlerContext.structuredOutput && opts.onStructuredOutput) {
        opts.renderSession?.setStructuredOutput?.(handlerContext.structuredOutput);
        opts.onStructuredOutput(handlerContext.structuredOutput);
      }

      if (handlerContext.nextSteps) {
        opts.renderSession?.setNextSteps?.(handlerContext.nextSteps, 'cli');
      }
    });
}

function captureStdoutChunks(): string[] {
  const stdoutChunks: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdoutChunks.push(String(chunk));
    return true;
  });
  return stdoutChunks;
}

function createBuildResultTool(options: { emitStatus?: boolean; includeNextSteps?: boolean } = {}) {
  return createTool({
    handler: vi.fn(async (_args, ctx) => {
      if (!ctx) {
        return;
      }
      if (options.emitStatus) {
        ctx.emit({
          kind: 'presentation',
          fragment: 'status',
          level: 'info',
          message: 'Starting work',
        });
      }
      ctx.structuredOutput = {
        schema: 'mobilebuildmcp.output.build-result',
        schemaVersion: '2',
        result: {
          kind: 'build-result',
          didError: false,
          error: null,
          request: {
            scheme: 'CalculatorApp',
            workspacePath: 'CalculatorApp.xcworkspace',
          },
          summary: { status: 'SUCCEEDED', durationMs: 1234, target: 'simulator' },
          artifacts: { buildLogPath: '/tmp/build.log' },
          diagnostics: { warnings: [], errors: [] },
        },
      };
      if (options.includeNextSteps) {
        ctx.nextSteps = [
          {
            tool: 'get_sim_app_path',
            cliTool: 'get-app-path',
            workflow: 'simulator',
            label: 'Get app path',
            params: { scheme: 'CalculatorApp' },
            when: 'success',
          },
        ];
      }
    }) as ToolDefinition['handler'],
  });
}

function createAppPathTool() {
  return createTool({
    handler: vi.fn(async (_args, ctx) => {
      if (ctx) {
        ctx.structuredOutput = {
          schema: 'mobilebuildmcp.output.app-path',
          schemaVersion: '2',
          result: {
            kind: 'app-path',
            didError: false,
            error: null,
            request: {
              scheme: 'CalculatorApp',
              workspacePath: 'CalculatorApp.xcworkspace',
            },
            artifacts: { appPath: '/tmp/MyApp.app' },
            diagnostics: { warnings: [], errors: [] },
          },
        };
      }
    }) as ToolDefinition['handler'],
  });
}

describe('registerToolCommands', () => {
  const originalArgv = process.argv;

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    process.argv = originalArgv;
  });

  it('hydrates required args from the active defaults profile', async () => {
    const invokeDirect = vi
      .spyOn(DefaultToolInvoker.prototype, 'invokeDirect')
      .mockResolvedValue(undefined);
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const tool = createTool();
    const app = createApp(createCatalog([tool]));

    await expect(app.parseAsync(['simulator', 'run-tool'])).resolves.toBeDefined();

    expect(invokeDirect).toHaveBeenCalledTimes(1);
    expect(invokeDirect).toHaveBeenCalledWith(
      tool,
      {
        workspacePath: 'Profile.xcworkspace',
      },
      expect.objectContaining({
        runtime: 'cli',
        workspaceRoot: '/repo',
      }),
    );

    stdoutWrite.mockRestore();
  });

  it('hydrates required args from the explicit --profile override', async () => {
    process.argv = ['node', 'mobilebuildmcp', 'simulator', 'run-tool', '--profile', 'qa'];

    const invokeDirect = vi
      .spyOn(DefaultToolInvoker.prototype, 'invokeDirect')
      .mockResolvedValue(undefined);
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const tool = createTool();
    const app = createApp(createCatalog([tool]), {
      ...baseRuntimeConfig,
      sessionDefaultsProfiles: {
        ...baseRuntimeConfig.sessionDefaultsProfiles,
        qa: {
          workspacePath: 'QA.xcworkspace',
        },
      },
    });

    await expect(
      app.parseAsync(['simulator', 'run-tool', '--profile', 'qa']),
    ).resolves.toBeDefined();

    expect(invokeDirect).toHaveBeenCalledWith(
      tool,
      {
        workspacePath: 'QA.xcworkspace',
      },
      expect.any(Object),
    );

    stdoutWrite.mockRestore();
  });

  it('resolves configured simulatorName for CLI tools that require simulatorId', async () => {
    const resolveSimulatorNameToId = vi
      .spyOn(simulatorResolver, 'resolveSimulatorNameToId')
      .mockResolvedValue({
        success: true,
        simulatorId: 'SIM-RESOLVED',
        simulatorName: 'iPhone 17 Pro',
      });
    const invokeDirect = vi
      .spyOn(DefaultToolInvoker.prototype, 'invokeDirect')
      .mockResolvedValue(undefined);
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const tool = createTool({
      cliSchema: {
        simulatorId: z.string().describe('Simulator ID'),
      },
      mcpSchema: {
        simulatorId: z.string().describe('Simulator ID'),
      },
    });
    const app = createApp(createCatalog([tool]), {
      ...baseRuntimeConfig,
      sessionDefaults: {
        simulatorName: 'iPhone 17 Pro',
      },
      sessionDefaultsProfiles: undefined,
      activeSessionDefaultsProfile: undefined,
    });

    await expect(app.parseAsync(['simulator', 'run-tool'])).resolves.toBeDefined();

    expect(resolveSimulatorNameToId).toHaveBeenCalledWith(expect.any(Function), 'iPhone 17 Pro');
    expect(invokeDirect).toHaveBeenCalledWith(
      tool,
      {
        simulatorId: 'SIM-RESOLVED',
      },
      expect.any(Object),
    );

    stdoutWrite.mockRestore();
  });

  it('emits structured JSON when configured simulatorName resolution fails', async () => {
    vi.spyOn(simulatorResolver, 'resolveSimulatorNameToId').mockResolvedValue({
      success: false,
      error: 'Simulator named "Missing Phone" not found.',
    });
    const invokeDirect = vi
      .spyOn(DefaultToolInvoker.prototype, 'invokeDirect')
      .mockResolvedValue(undefined);
    const stdoutChunks = captureStdoutChunks();

    const tool = createTool({
      cliSchema: {
        simulatorId: z.string().describe('Simulator ID'),
      },
      mcpSchema: {
        simulatorId: z.string().describe('Simulator ID'),
      },
    });
    const app = createApp(createCatalog([tool]), {
      ...baseRuntimeConfig,
      sessionDefaults: {
        simulatorName: 'Missing Phone',
      },
      sessionDefaultsProfiles: undefined,
      activeSessionDefaultsProfile: undefined,
    });

    await expect(
      app.parseAsync(['simulator', 'run-tool', '--output', 'json']),
    ).resolves.toBeDefined();

    expect(invokeDirect).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(stdoutChunks.join(''))).toEqual({
      schema: 'mobilebuildmcp.output.error',
      schemaVersion: '1',
      didError: true,
      error: 'Simulator named "Missing Phone" not found.',
      data: {
        category: 'runtime',
        code: 'SIMULATOR_RESOLUTION_FAILED',
      },
    });
  });

  it('does not synthesize simulatorId for tools that already accept simulatorName', async () => {
    const resolveSimulatorNameToId = vi.spyOn(simulatorResolver, 'resolveSimulatorNameToId');
    const invokeDirect = vi
      .spyOn(DefaultToolInvoker.prototype, 'invokeDirect')
      .mockResolvedValue(undefined);
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const tool = createTool({
      cliSchema: {
        simulatorId: z.string().optional().describe('Simulator ID'),
        simulatorName: z.string().optional().describe('Simulator name'),
      },
      mcpSchema: {
        simulatorId: z.string().optional().describe('Simulator ID'),
        simulatorName: z.string().optional().describe('Simulator name'),
      },
    });
    const app = createApp(createCatalog([tool]), {
      ...baseRuntimeConfig,
      sessionDefaults: {
        simulatorName: 'iPhone 17 Pro',
      },
      sessionDefaultsProfiles: undefined,
      activeSessionDefaultsProfile: undefined,
    });

    await expect(app.parseAsync(['simulator', 'run-tool'])).resolves.toBeDefined();

    expect(resolveSimulatorNameToId).not.toHaveBeenCalled();
    expect(invokeDirect).toHaveBeenCalledWith(
      tool,
      {
        simulatorName: 'iPhone 17 Pro',
      },
      expect.any(Object),
    );

    stdoutWrite.mockRestore();
  });

  it('keeps the normal missing-argument error when no hydrated default exists', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const tool = createTool();
    const app = createApp(createCatalog([tool]), {
      ...baseRuntimeConfig,
      sessionDefaults: undefined,
      sessionDefaultsProfiles: undefined,
      activeSessionDefaultsProfile: undefined,
    });

    await expect(app.parseAsync(['simulator', 'run-tool'])).resolves.toBeDefined();

    expect(consoleError).toHaveBeenCalledWith('Missing required argument: workspace-path');
    expect(process.exitCode).toBe(1);
  });

  it('hydrates args before daemon-routed invocation', async () => {
    const invokeDirect = vi
      .spyOn(DefaultToolInvoker.prototype, 'invokeDirect')
      .mockResolvedValue(undefined);
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const tool = createTool({ stateful: true });
    const app = createApp(createCatalog([tool]));

    await expect(app.parseAsync(['simulator', 'run-tool'])).resolves.toBeDefined();

    expect(invokeDirect).toHaveBeenCalledWith(
      tool,
      {
        workspacePath: 'Profile.xcworkspace',
      },
      expect.any(Object),
    );

    stdoutWrite.mockRestore();
  });

  it('lets explicit args override conflicting defaults before invocation', async () => {
    const invokeDirect = vi
      .spyOn(DefaultToolInvoker.prototype, 'invokeDirect')
      .mockResolvedValue(undefined);
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const tool = createTool({
      cliSchema: {
        projectPath: z.string().describe('Project path'),
        workspacePath: z.string().optional(),
      },
      mcpSchema: {
        projectPath: z.string().describe('Project path'),
        workspacePath: z.string().optional(),
      },
    });
    const app = createApp(createCatalog([tool]));

    await expect(
      app.parseAsync(['simulator', 'run-tool', '--project-path', 'App.xcodeproj']),
    ).resolves.toBeDefined();

    expect(invokeDirect).toHaveBeenCalledWith(
      tool,
      {
        projectPath: 'App.xcodeproj',
      },
      expect.any(Object),
    );

    stdoutWrite.mockRestore();
  });

  it('errors clearly when --profile references an unknown profile', async () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const tool = createTool();
    const app = createApp(createCatalog([tool]));

    await expect(
      app.parseAsync(['simulator', 'run-tool', '--profile', 'missing']),
    ).resolves.toBeDefined();

    expect(consoleError).toHaveBeenCalledWith("Error: Unknown defaults profile 'missing'");
    expect(process.exitCode).toBe(1);

    stderrWrite.mockRestore();
  });

  it('lets --json override configured defaults', async () => {
    const invokeDirect = vi
      .spyOn(DefaultToolInvoker.prototype, 'invokeDirect')
      .mockResolvedValue(undefined);
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const tool = createTool();
    const app = createApp(createCatalog([tool]));

    await expect(
      app.parseAsync([
        'simulator',
        'run-tool',
        '--json',
        JSON.stringify({ workspacePath: 'Json.xcworkspace' }),
      ]),
    ).resolves.toBeDefined();

    expect(invokeDirect).toHaveBeenCalledWith(
      tool,
      {
        workspacePath: 'Json.xcworkspace',
      },
      expect.any(Object),
    );

    stdoutWrite.mockRestore();
  });

  it('allows --json to satisfy required arguments', async () => {
    const invokeDirect = vi
      .spyOn(DefaultToolInvoker.prototype, 'invokeDirect')
      .mockResolvedValue(undefined);
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const tool = createTool();
    const app = createApp(createCatalog([tool]), {
      ...baseRuntimeConfig,
      sessionDefaults: undefined,
      sessionDefaultsProfiles: undefined,
      activeSessionDefaultsProfile: undefined,
    });

    await expect(
      app.parseAsync([
        'simulator',
        'run-tool',
        '--json',
        JSON.stringify({ workspacePath: 'FromJson.xcworkspace' }),
      ]),
    ).resolves.toBeDefined();

    expect(invokeDirect).toHaveBeenCalledWith(
      tool,
      {
        workspacePath: 'FromJson.xcworkspace',
      },
      expect.any(Object),
    );

    stdoutWrite.mockRestore();
  });

  it('allows array args that begin with a dash', async () => {
    const invokeDirect = vi
      .spyOn(DefaultToolInvoker.prototype, 'invokeDirect')
      .mockResolvedValue(undefined);
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const tool = createTool({
      cliSchema: {
        workspacePath: z.string().describe('Workspace path'),
        extraArgs: z.array(z.string()).optional().describe('Extra args'),
      },
      mcpSchema: {
        workspacePath: z.string().describe('Workspace path'),
        extraArgs: z.array(z.string()).optional().describe('Extra args'),
      },
    });
    const app = createApp(createCatalog([tool]), {
      ...baseRuntimeConfig,
      sessionDefaults: undefined,
      sessionDefaultsProfiles: undefined,
      activeSessionDefaultsProfile: undefined,
    });

    await expect(
      app.parseAsync([
        'simulator',
        'run-tool',
        '--workspace-path',
        'App.xcworkspace',
        '--extra-args',
        '-only-testing:AppTests',
      ]),
    ).resolves.toBeDefined();

    expect(invokeDirect).toHaveBeenCalledWith(
      tool,
      {
        workspacePath: 'App.xcworkspace',
        extraArgs: ['-only-testing:AppTests'],
      },
      expect.any(Object),
    );

    stdoutWrite.mockRestore();
  });

  it('parses comma-separated numeric array args', async () => {
    const invokeDirect = vi
      .spyOn(DefaultToolInvoker.prototype, 'invokeDirect')
      .mockResolvedValue(undefined);
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const tool = createTool({
      cliSchema: {
        workspacePath: z.string().describe('Workspace path'),
        keyCodes: z.array(z.number()).describe('Key codes'),
      },
      mcpSchema: {
        workspacePath: z.string().describe('Workspace path'),
        keyCodes: z.array(z.number()).describe('Key codes'),
      },
    });
    const app = createApp(createCatalog([tool]), {
      ...baseRuntimeConfig,
      sessionDefaults: undefined,
      sessionDefaultsProfiles: undefined,
      activeSessionDefaultsProfile: undefined,
    });

    await expect(
      app.parseAsync([
        'simulator',
        'run-tool',
        '--workspace-path',
        'App.xcworkspace',
        '--key-codes',
        '23,18,14',
      ]),
    ).resolves.toBeDefined();

    expect(invokeDirect).toHaveBeenCalledWith(
      tool,
      {
        workspacePath: 'App.xcworkspace',
        keyCodes: [23, 18, 14],
      },
      expect.any(Object),
    );

    stdoutWrite.mockRestore();
  });

  it('honors --style minimal by hiding next steps', async () => {
    vi.spyOn(DefaultToolInvoker.prototype, 'invokeDirect').mockImplementation(
      async (_tool, _args, opts) => {
        opts.renderSession?.setStructuredOutput?.({
          schema: 'mobilebuildmcp.output.app-path',
          schemaVersion: '1',
          result: {
            kind: 'app-path',
            didError: false,
            error: null,
            artifacts: { appPath: '/tmp/MyApp.app' },
          },
        });
        opts.renderSession?.setNextSteps?.(
          [
            {
              label: 'Run again',
              tool: 'run_tool',
              workflow: 'simulator',
              cliTool: 'run-tool',
            },
          ],
          'cli',
        );
      },
    );
    const stdoutChunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    });

    const tool = createTool();
    const app = createApp(createCatalog([tool]));

    await expect(
      app.parseAsync(['simulator', 'run-tool', '--style', 'minimal']),
    ).resolves.toBeDefined();

    const output = stdoutChunks.join('');
    expect(output).toContain('Get App Path');
    expect(output).not.toContain('Next steps:');
    expect(output).not.toContain('Run again');
  });

  it('applies --file-path-render-style to text output without forwarding it to tool args', async () => {
    vi.spyOn(DefaultToolInvoker.prototype, 'invokeDirect').mockImplementation(
      async (tool, args, opts) => {
        const handlerContext: ToolHandlerContext = opts.handlerContext ?? {
          emit: (fragment) => {
            opts.renderSession?.emit(fragment);
          },
          attach: (image) => {
            opts.renderSession?.attach(image);
          },
        };

        await tool.handler(args, handlerContext);

        if (handlerContext.structuredOutput) {
          opts.renderSession?.setStructuredOutput?.(handlerContext.structuredOutput);
          opts.onStructuredOutput?.(handlerContext.structuredOutput);
        }
      },
    );
    const stdoutChunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    });

    const tool = createTool({
      handler: vi.fn(async (_args, ctx) => {
        if (ctx) {
          ctx.structuredOutput = {
            schema: 'mobilebuildmcp.output.app-path',
            schemaVersion: '1',
            result: {
              kind: 'app-path',
              didError: false,
              error: null,
              artifacts: { appPath: '/tmp/MyApp.app' },
            },
          };
        }
      }) as ToolDefinition['handler'],
    });
    const app = createApp(createCatalog([tool]));

    await expect(
      app.parseAsync(['simulator', 'run-tool', '--file-path-render-style', 'tree']),
    ).resolves.toBeDefined();

    expect(tool.handler).toHaveBeenCalledWith(
      { workspacePath: 'Profile.xcworkspace' },
      expect.any(Object),
    );
    expect(stdoutChunks.join('')).toContain('└── /tmp/MyApp.app — App Path');
    expect(stdoutChunks.join('')).not.toContain('└ App Path: /tmp/MyApp.app');
  });

  it('keeps full request payloads in default json output', async () => {
    mockInvokeDirectThroughHandler();
    const stdoutChunks = captureStdoutChunks();
    const app = createApp(createCatalog([createBuildResultTool()]));

    await expect(
      app.parseAsync(['simulator', 'run-tool', '--output', 'json']),
    ).resolves.toBeDefined();

    expect(JSON.parse(stdoutChunks.join(''))).toEqual({
      schema: 'mobilebuildmcp.output.build-result',
      schemaVersion: '2',
      didError: false,
      error: null,
      data: {
        request: {
          scheme: 'CalculatorApp',
          workspacePath: 'CalculatorApp.xcworkspace',
        },
        summary: { status: 'SUCCEEDED', durationMs: 1234, target: 'simulator' },
        artifacts: { buildLogPath: '/tmp/build.log' },
        diagnostics: { warnings: [], errors: [] },
      },
    });
  });

  it('prunes request payloads but preserves CLI next steps for minimal json output', async () => {
    mockInvokeDirectThroughHandler();
    const stdoutChunks = captureStdoutChunks();
    const app = createApp(createCatalog([createBuildResultTool({ includeNextSteps: true })]));

    await expect(
      app.parseAsync(['simulator', 'run-tool', '--style', 'minimal', '--output', 'json']),
    ).resolves.toBeDefined();

    expect(JSON.parse(stdoutChunks.join(''))).toEqual({
      schema: 'mobilebuildmcp.output.build-result',
      schemaVersion: '2',
      didError: false,
      error: null,
      data: {
        summary: { status: 'SUCCEEDED', durationMs: 1234, target: 'simulator' },
        artifacts: { buildLogPath: '/tmp/build.log' },
        diagnostics: { warnings: [], errors: [] },
      },
      nextSteps: ['Get app path: mobilebuildmcp simulator get-app-path --scheme CalculatorApp'],
    });
  });

  it('uses compact headerless tree artifact formatting for minimal text output', async () => {
    mockInvokeDirectThroughHandler();
    const stdoutChunks = captureStdoutChunks();
    const app = createApp(createCatalog([createAppPathTool()]));

    await expect(
      app.parseAsync(['simulator', 'run-tool', '--style', 'minimal']),
    ).resolves.toBeDefined();

    const output = stdoutChunks.join('');
    expect(output).not.toContain('Scheme: CalculatorApp');
    expect(output).not.toContain('Workspace: CalculatorApp.xcworkspace');
    expect(output).toContain('└── /tmp/MyApp.app — App Path');
    expect(output).not.toContain('└ App Path: /tmp/MyApp.app');
  });

  it('lets explicit file path render style override minimal text defaults', async () => {
    mockInvokeDirectThroughHandler();
    const stdoutChunks = captureStdoutChunks();
    const app = createApp(createCatalog([createAppPathTool()]));

    await expect(
      app.parseAsync([
        'simulator',
        'run-tool',
        '--style',
        'minimal',
        '--file-path-render-style',
        'list',
      ]),
    ).resolves.toBeDefined();

    const output = stdoutChunks.join('');
    expect(output).toContain('└ App Path: /tmp/MyApp.app');
    expect(output).not.toContain('└── /tmp/MyApp.app — App Path');
  });

  it('writes a structured envelope for tools that provide structured output', async () => {
    mockInvokeDirectThroughHandler();
    const stdoutChunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    });

    const tool = createTool({
      handler: vi.fn(async (_args, ctx) => {
        ctx?.emit({
          kind: 'presentation',
          fragment: 'status',
          level: 'info',
          message: 'legacy event',
        });

        if (ctx) {
          ctx.structuredOutput = {
            schema: 'mobilebuildmcp.output.simulator-list',
            schemaVersion: '1',
            result: {
              kind: 'simulator-list',
              didError: false,
              error: null,
              simulators: [
                {
                  name: 'iPhone 15',
                  simulatorId: 'test-uuid-123',
                  state: 'Shutdown',
                  isAvailable: true,
                  runtime: 'iOS 17.0',
                },
              ],
            },
          };
          ctx.nextSteps = [
            {
              tool: 'boot_sim',
              cliTool: 'boot',
              workflow: 'simulator',
              label: 'Boot this simulator',
              params: { simulatorId: 'test-uuid-123' },
              when: 'success',
            },
          ];
        }
      }) as ToolDefinition['handler'],
    });
    const app = createApp(createCatalog([tool]));

    await expect(
      app.parseAsync(['simulator', 'run-tool', '--output', 'json']),
    ).resolves.toBeDefined();

    expect(stdoutChunks.join('')).toBe(
      `${JSON.stringify(
        {
          schema: 'mobilebuildmcp.output.simulator-list',
          schemaVersion: '1',
          didError: false,
          error: null,
          data: {
            simulators: [
              {
                name: 'iPhone 15',
                simulatorId: 'test-uuid-123',
                state: 'Shutdown',
                isAvailable: true,
                runtime: 'iOS 17.0',
              },
            ],
          },
          nextSteps: [
            'Boot this simulator: mobilebuildmcp simulator boot --simulator-id test-uuid-123',
          ],
        },
        null,
        2,
      )}\n`,
    );
  });

  it('writes compact rs/1 capture JSON for runtime snapshots by default', async () => {
    mockInvokeDirectThroughHandler();
    const stdoutChunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    });

    const tool = createTool({
      handler: vi.fn(async (_args, ctx) => {
        if (ctx) {
          ctx.structuredOutput = {
            schema: 'mobilebuildmcp.output.capture-result',
            schemaVersion: '2',
            result: {
              kind: 'capture-result',
              didError: false,
              error: null,
              summary: { status: 'SUCCEEDED' },
              artifacts: { simulatorId: 'SIMULATOR-1' },
              capture: {
                type: 'runtime-snapshot',
                protocol: 'rs/1',
                simulatorId: 'SIMULATOR-1',
                screenHash: 'screen-hash',
                seq: 1,
                capturedAtMs: 1_000,
                expiresAtMs: 61_000,
                elements: [
                  {
                    ref: 'e1',
                    role: 'application',
                    label: 'Weather',
                    frame: { x: 0, y: 0, width: 390, height: 844 },
                    actions: ['swipeWithin'],
                  },
                  {
                    ref: 'e2',
                    role: 'button',
                    label: 'San Francisco',
                    value: 'selected',
                    identifier: 'weather.locationButton',
                    frame: { x: 12, y: 81.33, width: 178, height: 33.33 },
                    actions: ['tap', 'longPress', 'touch'],
                  },
                  {
                    ref: 'e3',
                    role: 'button',
                    label: 'Sheet Grabber',
                    value: 'Half screen',
                    frame: { x: 150, y: 10, width: 80, height: 20 },
                    actions: ['tap'],
                  },
                ],
                actions: [
                  { action: 'swipeWithin', elementRef: 'e1', label: 'Weather' },
                  { action: 'tap', elementRef: 'e2', label: 'San Francisco' },
                  { action: 'tap', elementRef: 'e3', label: 'Sheet Grabber' },
                ],
              },
            },
          };
        }
      }) as ToolDefinition['handler'],
    });
    const app = createApp(createCatalog([tool]));

    await expect(
      app.parseAsync(['simulator', 'run-tool', '--output', 'json']),
    ).resolves.toBeDefined();

    expect(stdoutChunks.join('')).toBe(
      `${JSON.stringify(
        {
          schema: 'mobilebuildmcp.output.capture-result',
          schemaVersion: '2',
          didError: false,
          error: null,
          data: {
            summary: { status: 'SUCCEEDED' },
            artifacts: { simulatorId: 'SIMULATOR-1' },
            capture: {
              type: 'runtime-snapshot',
              rs: '1',
              screenHash: 'screen-hash',
              seq: 1,
              count: 3,
              targets: ['e2|tap|button|San Francisco|selected|weather.locationButton'],
              scroll: ['e1|swipe|application|Weather||'],
              udid: 'SIMULATOR-1',
            },
          },
        },
        null,
        2,
      )}\n`,
    );
  });

  it('writes compact wait matches with no primary action for static text', async () => {
    mockInvokeDirectThroughHandler();
    const stdoutChunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    });

    const tool = createTool({
      handler: vi.fn(async (_args, ctx) => {
        if (ctx) {
          ctx.structuredOutput = {
            schema: 'mobilebuildmcp.output.capture-result',
            schemaVersion: '2',
            result: {
              kind: 'capture-result',
              didError: false,
              error: null,
              artifacts: { simulatorId: 'SIMULATOR-1' },
              waitMatch: {
                predicate: 'textContains',
                matches: [
                  {
                    ref: 'e11',
                    role: 'text',
                    label: 'No matches',
                    frame: { x: 20, y: 240, width: 120, height: 24 },
                    actions: ['longPress', 'touch'],
                  },
                ],
              },
              capture: {
                type: 'runtime-snapshot',
                protocol: 'rs/1',
                simulatorId: 'SIMULATOR-1',
                screenHash: 'screen-hash',
                seq: 1,
                capturedAtMs: 1_000,
                expiresAtMs: 61_000,
                elements: [
                  {
                    ref: 'e11',
                    role: 'text',
                    label: 'No matches',
                    frame: { x: 20, y: 240, width: 120, height: 24 },
                    actions: ['longPress', 'touch'],
                  },
                ],
                actions: [
                  { action: 'longPress', elementRef: 'e11', label: 'No matches' },
                  { action: 'touch', elementRef: 'e11', label: 'No matches' },
                ],
              },
            },
          };
        }
      }) as ToolDefinition['handler'],
    });
    const app = createApp(createCatalog([tool]));

    await expect(
      app.parseAsync(['simulator', 'run-tool', '--output', 'json']),
    ).resolves.toBeDefined();

    const output = JSON.parse(stdoutChunks.join('')) as {
      data: { waitMatch: { matches: string[] } };
    };
    expect(output.data.waitMatch.matches).toEqual(['e11|none|text|No matches||']);
  });

  it('emits compact UI action runtime snapshots by default and full snapshots for verbose JSON output', async () => {
    mockInvokeDirectThroughHandler();
    const stdoutChunks = captureStdoutChunks();

    const tool = createTool({
      handler: vi.fn(async (_args, ctx) => {
        if (ctx) {
          ctx.structuredOutput = {
            schema: 'mobilebuildmcp.output.ui-action-result',
            schemaVersion: '2',
            result: {
              kind: 'ui-action-result',
              didError: false,
              error: null,
              summary: { status: 'SUCCEEDED' },
              action: { type: 'tap', elementRef: 'e2' },
              artifacts: { simulatorId: 'SIMULATOR-1' },
              capture: {
                type: 'runtime-snapshot',
                protocol: 'rs/1',
                simulatorId: 'SIMULATOR-1',
                screenHash: 'screen-hash',
                seq: 1,
                capturedAtMs: 1_000,
                expiresAtMs: 61_000,
                elements: [
                  {
                    ref: 'e1',
                    role: 'application',
                    label: 'Weather',
                    frame: { x: 0, y: 0, width: 390, height: 844 },
                    actions: ['swipeWithin'],
                  },
                  {
                    ref: 'e2',
                    role: 'button',
                    label: 'Continue',
                    frame: { x: 20, y: 80, width: 120, height: 44 },
                    actions: ['tap'],
                  },
                ],
                actions: [
                  { action: 'swipeWithin', elementRef: 'e1', label: 'Weather' },
                  { action: 'tap', elementRef: 'e2', label: 'Continue' },
                ],
              },
            },
          };
        }
      }) as ToolDefinition['handler'],
    });
    const app = createApp(createCatalog([tool]));

    await expect(
      app.parseAsync(['simulator', 'run-tool', '--output', 'json']),
    ).resolves.toBeDefined();

    const output = JSON.parse(stdoutChunks.join('')) as {
      schema: string;
      schemaVersion: string;
      data: { capture: { targets: string[]; elements?: unknown[] } };
    };
    expect(output.schema).toBe('mobilebuildmcp.output.ui-action-result');
    expect(output.schemaVersion).toBe('2');
    expect(output.data.capture).toEqual(
      expect.objectContaining({
        type: 'runtime-snapshot',
        rs: '1',
        targets: ['e2|tap|button|Continue||'],
        scroll: ['e1|swipe|application|Weather||'],
      }),
    );
    expect(output.data.capture.elements).toBeUndefined();

    stdoutChunks.length = 0;

    await expect(
      app.parseAsync(['simulator', 'run-tool', '--output', 'json', '--verbose']),
    ).resolves.toBeDefined();

    const verboseOutput = JSON.parse(stdoutChunks.join('')) as {
      schema: string;
      schemaVersion: string;
      data: {
        capture: { rs?: string; protocol?: string; elements?: unknown[]; actions?: unknown[] };
      };
    };
    expect(verboseOutput.schema).toBe('mobilebuildmcp.output.ui-action-result');
    expect(verboseOutput.schemaVersion).toBe('3');
    expect(verboseOutput.data.capture).toEqual(
      expect.objectContaining({
        type: 'runtime-snapshot',
        protocol: 'rs/1',
        simulatorId: 'SIMULATOR-1',
        screenHash: 'screen-hash',
        seq: 1,
        capturedAtMs: 1_000,
        expiresAtMs: 61_000,
      }),
    );
    expect(verboseOutput.data.capture.rs).toBeUndefined();
    expect(verboseOutput.data.capture.elements).toEqual([
      expect.objectContaining({ ref: 'e1', role: 'application', label: 'Weather' }),
      expect.objectContaining({ ref: 'e2', role: 'button', label: 'Continue' }),
    ]);
    expect(verboseOutput.data.capture.actions).toEqual([
      { action: 'swipeWithin', elementRef: 'e1', label: 'Weather' },
      { action: 'tap', elementRef: 'e2', label: 'Continue' },
    ]);
  });

  it('emits full capture runtime snapshots for verbose JSON output', async () => {
    mockInvokeDirectThroughHandler();
    const stdoutChunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    });

    const tool = createTool({
      handler: vi.fn(async (_args, ctx) => {
        if (ctx) {
          ctx.structuredOutput = {
            schema: 'mobilebuildmcp.output.capture-result',
            schemaVersion: '2',
            result: {
              kind: 'capture-result',
              didError: false,
              error: null,
              summary: { status: 'SUCCEEDED' },
              artifacts: { simulatorId: 'SIMULATOR-1' },
              capture: {
                type: 'runtime-snapshot',
                protocol: 'rs/1',
                simulatorId: 'SIMULATOR-1',
                screenHash: 'screen-hash',
                seq: 1,
                capturedAtMs: 1_000,
                expiresAtMs: 61_000,
                elements: [
                  {
                    ref: 'e1',
                    role: 'application',
                    label: 'Weather',
                    frame: { x: 0, y: 0, width: 390, height: 844 },
                    actions: ['swipeWithin'],
                  },
                ],
                actions: [{ action: 'swipeWithin', elementRef: 'e1', label: 'Weather' }],
              },
            },
          };
        }
      }) as ToolDefinition['handler'],
    });
    const app = createApp(createCatalog([tool]));

    await expect(
      app.parseAsync(['simulator', 'run-tool', '--output', 'json', '--verbose']),
    ).resolves.toBeDefined();

    const output = JSON.parse(stdoutChunks.join('')) as {
      schema: string;
      schemaVersion: string;
      data: {
        capture: { rs?: string; protocol?: string; elements?: unknown[]; actions?: unknown[] };
      };
    };
    expect(output.schema).toBe('mobilebuildmcp.output.capture-result');
    expect(output.schemaVersion).toBe('2');
    expect(output.data.capture).toEqual(
      expect.objectContaining({
        type: 'runtime-snapshot',
        protocol: 'rs/1',
        simulatorId: 'SIMULATOR-1',
        screenHash: 'screen-hash',
        seq: 1,
        capturedAtMs: 1_000,
        expiresAtMs: 61_000,
      }),
    );
    expect(output.data.capture.rs).toBeUndefined();
    expect(output.data.capture.elements).toEqual([
      expect.objectContaining({ ref: 'e1', role: 'application', label: 'Weather' }),
    ]);
    expect(output.data.capture.actions).toEqual([
      { action: 'swipeWithin', elementRef: 'e1', label: 'Weather' },
    ]);
  });

  it('writes one NDJSON line per domain fragment for jsonl output and omits the final envelope', async () => {
    mockInvokeDirectThroughHandler();
    const stdoutChunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    });

    const tool = createTool({
      handler: vi.fn(async (_args, ctx) => {
        ctx?.emit({
          kind: 'presentation',
          fragment: 'status',
          level: 'info',
          message: 'Starting work',
        });
        ctx?.emit({
          kind: 'presentation',
          fragment: 'artifact',
          name: 'Build Log',
          path: '/tmp/build.log',
        });

        if (ctx) {
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
        }
      }) as ToolDefinition['handler'],
    });
    const app = createApp(createCatalog([tool]));

    await expect(
      app.parseAsync(['simulator', 'run-tool', '--output', 'jsonl']),
    ).resolves.toBeDefined();

    expect(stdoutChunks.join('')).toBe(
      `${JSON.stringify({ event: 'presentation.status', level: 'info', message: 'Starting work' })}\n` +
        `${JSON.stringify({ event: 'presentation.artifact', name: 'Build Log', path: '/tmp/build.log' })}\n`,
    );
  });

  it('emits the same fragment-only jsonl output for minimal style', async () => {
    mockInvokeDirectThroughHandler();
    const stdoutChunks = captureStdoutChunks();
    const app = createApp(createCatalog([createBuildResultTool({ emitStatus: true })]));

    await expect(
      app.parseAsync(['simulator', 'run-tool', '--output', 'jsonl']),
    ).resolves.toBeDefined();
    const normalOutput = stdoutChunks.join('');

    stdoutChunks.length = 0;

    await expect(
      app.parseAsync(['simulator', 'run-tool', '--style', 'minimal', '--output', 'jsonl']),
    ).resolves.toBeDefined();

    expect(stdoutChunks.join('')).toBe(normalOutput);
    expect(normalOutput).toBe(
      `${JSON.stringify({ event: 'presentation.status', level: 'info', message: 'Starting work' })}\n`,
    );
  });

  it('does not duplicate daemon-streamed fragments for jsonl output', async () => {
    const streamedFragment = {
      kind: 'transcript',
      fragment: 'process-line',
      stream: 'stderr',
      line: 'Build Log: /tmp/build.log\n',
    } as const;

    vi.spyOn(DefaultToolInvoker.prototype, 'invokeDirect').mockImplementation(
      async (_tool, _args, opts) => {
        opts.renderSession?.emit(streamedFragment);
        opts.onProgress?.(streamedFragment);
        opts.onStructuredOutput?.({
          schema: 'mobilebuildmcp.output.simulator-list',
          schemaVersion: '1',
          result: {
            kind: 'simulator-list',
            didError: false,
            error: null,
            simulators: [],
          },
        });
      },
    );

    const stdoutChunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    });

    const tool = createTool({ stateful: true });
    const app = createApp(createCatalog([tool]));

    await expect(
      app.parseAsync(['simulator', 'run-tool', '--output', 'jsonl']),
    ).resolves.toBeDefined();

    expect(stdoutChunks.join('')).toBe(
      `${JSON.stringify({
        event: 'transcript.process-line',
        stream: 'stderr',
        line: 'Build Log: /tmp/build.log\n',
      })}\n`,
    );
  });

  it('writes a JSON error envelope when no structured output is available for json mode', async () => {
    mockInvokeDirectThroughHandler();
    const stdoutChunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    });

    const tool = createTool({
      handler: vi.fn(async (_args, ctx) => {
        ctx?.emit({
          kind: 'presentation',
          fragment: 'status',
          level: 'info',
          message: 'legacy event',
        });
        if (ctx) {
          ctx.nextSteps = [
            {
              label: 'Should not be included without structured output',
            },
          ];
        }
      }) as ToolDefinition['handler'],
    });
    const app = createApp(createCatalog([tool]));

    await expect(
      app.parseAsync(['simulator', 'run-tool', '--output', 'json']),
    ).resolves.toBeDefined();

    expect(stdoutChunks.join('')).toBe(
      `${JSON.stringify(
        {
          schema: 'mobilebuildmcp.output.error',
          schemaVersion: '1',
          didError: true,
          error: 'Tool did not produce structured output for --output json',
          data: {
            category: 'runtime',
            code: 'STRUCTURED_OUTPUT_MISSING',
          },
        },
        null,
        2,
      )}\n`,
    );
    expect(process.exitCode).toBe(1);
  });

  it('supports json and jsonl output for xcode-ide tools through the generic output path', async () => {
    mockInvokeDirectThroughHandler();
    const stdoutChunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    });

    const tool = createTool({
      workflow: 'xcode-ide',
      cliSchema: {},
      mcpSchema: {},
      handler: vi.fn(async (_args, ctx) => {
        if (ctx) {
          ctx.structuredOutput = {
            schema: 'mobilebuildmcp.output.xcode-bridge-call-result',
            schemaVersion: '2',
            result: {
              kind: 'xcode-bridge-call-result',
              didError: false,
              error: null,
              remoteTool: 'DocumentationSearch',
              succeeded: true,
              content: [],
              artifacts: {
                rawResponseJsonPath: '/tmp/xcode-ide-response.json',
              },
            },
          };
        }
      }) as ToolDefinition['handler'],
    });
    const app = yargs()
      .scriptName('mobilebuildmcp')
      .exitProcess(false)
      .fail((message, error) => {
        throw error ?? new Error(message);
      });

    registerToolCommands(app, createCatalog([tool]), {
      workspaceRoot: '/repo',
      runtimeConfig: baseRuntimeConfig,
      cliExposedWorkflowIds: ['xcode-ide'],
      workflowNames: ['xcode-ide'],
    });

    await expect(
      app.parseAsync(['xcode-ide', 'run-tool', '--output', 'json']),
    ).resolves.toBeDefined();
    expect(stdoutChunks.join('')).toBe(
      `${JSON.stringify(
        {
          schema: 'mobilebuildmcp.output.xcode-bridge-call-result',
          schemaVersion: '2',
          didError: false,
          error: null,
          data: {
            remoteTool: 'DocumentationSearch',
            succeeded: true,
            content: [],
            artifacts: {
              rawResponseJsonPath: '/tmp/xcode-ide-response.json',
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    expect(process.exitCode).toBeUndefined();

    stdoutChunks.length = 0;

    await expect(
      app.parseAsync(['xcode-ide', 'run-tool', '--output', 'jsonl']),
    ).resolves.toBeDefined();
    expect(stdoutChunks.join('')).toBe('');
    expect(process.exitCode).toBeUndefined();
  });
});
