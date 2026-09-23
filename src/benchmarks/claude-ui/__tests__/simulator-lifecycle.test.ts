import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { readConfig } from '../config.ts';
import {
  claudeBenchmarkEnv,
  requireFirstRunPreflightSimulatorId,
  resolveBenchmarkSimulatorId,
  writeMcpConfig,
} from '../mcp-config.ts';
import { deleteTemporarySimulator } from '../simulator-deletion.ts';
import {
  prepareTemporarySimulator,
  resolveTemporarySimulatorPlan,
  type CreatedTemporarySimulator,
  type LifecycleCommandExecutor,
  type LifecycleCommandOptions,
} from '../simulator-lifecycle.ts';
import type { BenchmarkConfig } from '../types.ts';

const HEADLESS_ENV_VAR = 'MOBILEBUILDMCP_HEADLESS_LAUNCH';

interface ClaudeMcpConfig {
  mcpServers: {
    'mobilebuildmcp-dev': {
      env: Record<string, string>;
    };
  };
}

interface IsolatedMcpWorkspaceConfig {
  schemaVersion: number;
  enabledWorkflows: string[];
  debug: boolean;
  sentryDisabled: boolean;
  sessionDefaults: Record<string, string | boolean>;
}

function config(overrides: Partial<BenchmarkConfig> = {}): BenchmarkConfig {
  return {
    name: 'weather',
    prompt: '../prompts/weather.md',
    sessionDefaults: {
      simulatorName: 'iPhone 17 Pro Max',
      bundleId: 'com.example.App',
    },
    ...overrides,
  };
}

function inMemoryLifecycleLog() {
  const messages: string[] = [];
  return {
    messages,
    writer: async (_logPath: string, message: string) => {
      messages.push(message);
    },
  };
}

describe('Claude UI temporary simulator lifecycle', () => {
  it('enables temporary simulators by default when no simulatorId is configured', () => {
    const plan = resolveTemporarySimulatorPlan(config());

    expect(plan).toEqual({ enabled: true, deviceTypeName: 'iPhone 17 Pro Max' });
  });

  it('does not manage or delete a suite-provided simulatorId', () => {
    const plan = resolveTemporarySimulatorPlan(
      config({
        sessionDefaults: { simulatorId: 'USER-SIM-1', simulatorName: 'iPhone 17 Pro Max' },
      }),
    );

    expect(plan).toEqual({
      enabled: false,
      reason: 'sessionDefaults.simulatorId is set',
      existingSimulatorId: 'USER-SIM-1',
    });
  });

  it('uses the configured simulatorId when no temporary simulator is created', () => {
    const parsed = config({
      sessionDefaults: { simulatorId: 'USER-SIM-1', bundleId: 'com.example.App' },
      temporarySimulator: false,
    });

    expect(resolveBenchmarkSimulatorId(parsed, undefined)).toBe('USER-SIM-1');
    expect(requireFirstRunPreflightSimulatorId(parsed, undefined)).toBe('USER-SIM-1');
  });

  it('fails first-run preflight config when no simulatorId can be resolved', () => {
    expect(() =>
      requireFirstRunPreflightSimulatorId(
        config({
          temporarySimulator: false,
          firstRunPromptDismissals: { labels: ['Continue'] },
        }),
        undefined,
      ),
    ).toThrow(
      'firstRunPromptDismissals requires a temporary simulator or sessionDefaults.simulatorId',
    );
  });

  it('rejects ambiguous config that both forces temp sim and provides simulatorId', () => {
    expect(() =>
      resolveTemporarySimulatorPlan(
        config({
          temporarySimulator: true,
          sessionDefaults: { simulatorId: 'USER-SIM-1', simulatorName: 'iPhone 17 Pro Max' },
        }),
      ),
    ).toThrow('temporarySimulator cannot be true when sessionDefaults.simulatorId is set');
  });

  it('parses the explicit temporarySimulator opt-out flag', () => {
    const parsed = readConfig(
      {
        name: 'contacts',
        prompt: '../prompts/contacts.md',
        temporarySimulator: false,
      },
      'contacts.yml',
    );

    expect(parsed.temporarySimulator).toBe(false);
    expect(resolveTemporarySimulatorPlan(parsed)).toEqual({
      enabled: false,
      reason: 'temporarySimulator is false',
      existingSimulatorId: undefined,
      existingSimulatorName: undefined,
    });
  });

  it('parses configured first-run prompt dismissals', () => {
    const parsed = readConfig(
      {
        name: 'reminders',
        prompt: '../prompts/reminders.md',
        firstRunPromptDismissals: {
          labels: ['Continue', 'Not Now'],
          timeoutSeconds: 12,
        },
      },
      'reminders.yml',
    );

    expect(parsed.firstRunPromptDismissals).toEqual({
      labels: ['Continue', 'Not Now'],
      timeoutSeconds: 12,
    });
  });

  it('creates, boots, opens, and deletes only the harness-created simulator', async () => {
    const logPath = '/tmp/simulator-lifecycle.log';
    const log = inMemoryLifecycleLog();
    const commands: LifecycleCommandOptions[] = [];
    const events: string[] = [];
    const executor: LifecycleCommandExecutor = async (opts) => {
      commands.push(opts);
      return {
        exitCode: 0,
        stdout: opts.args[1] === 'create' ? 'TEMP-SIM-123\n' : '',
        stderr: '',
        durationSeconds: 0.01,
      };
    };

    const simulator = await prepareTemporarySimulator({
      config: config(),
      suiteSlug: 'weather',
      timestamp: '20260522T120000Z',
      cwd: '/repo',
      logPath,
      executor,
      logWriter: log.writer,
      onEvent: (message) => events.push(message),
      readinessDelayMs: 0,
    });
    expect(simulator?.simulatorId).toBe('TEMP-SIM-123');
    expect(commands.map((item) => [item.command, ...item.args])).toEqual([
      ['xcrun', 'simctl', 'create', 'Claude UI weather 20260522T120000Z', 'iPhone 17 Pro Max'],
      ['xcrun', 'simctl', 'boot', 'TEMP-SIM-123'],
      ['xcrun', 'simctl', 'bootstatus', 'TEMP-SIM-123', '-b'],
      ['open', 'devices:///manage/select?id=TEMP-SIM-123'],
    ]);
    expect(events).toEqual([
      'creating simulator Claude UI weather 20260522T120000Z',
      'booting simulator TEMP-SIM-123',
      'waiting for simulator TEMP-SIM-123 bootstatus',
      'opening Device Hub for TEMP-SIM-123',
      'simulator ready TEMP-SIM-123',
    ]);

    const deletion = await deleteTemporarySimulator(simulator as CreatedTemporarySimulator, {
      cwd: '/repo',
      executor,
      logWriter: log.writer,
    });

    expect(deletion).toEqual({ attempted: true, succeeded: true, exitCode: 0 });
    expect(commands[4]?.args).toEqual(['simctl', 'delete', 'TEMP-SIM-123']);
    expect(log.messages.join('\n')).toContain('Created simulatorId: TEMP-SIM-123');
    expect(log.messages.join('\n')).toContain('Temporary simulator ready: TEMP-SIM-123');
  });

  it('does not open a simulator frontend when headless launch mode is enabled', async () => {
    const previousHeadlessValue = process.env[HEADLESS_ENV_VAR];
    process.env[HEADLESS_ENV_VAR] = '1';
    try {
      const logPath = '/tmp/simulator-lifecycle.log';
      const log = inMemoryLifecycleLog();
      const commands: LifecycleCommandOptions[] = [];
      const events: string[] = [];
      const executor: LifecycleCommandExecutor = async (opts) => {
        commands.push(opts);
        return {
          exitCode: 0,
          stdout: opts.args[1] === 'create' ? 'TEMP-SIM-123\n' : '',
          stderr: '',
          durationSeconds: 0.01,
        };
      };

      const simulator = await prepareTemporarySimulator({
        config: config(),
        suiteSlug: 'weather',
        timestamp: '20260522T120000Z',
        cwd: '/repo',
        logPath,
        executor,
        logWriter: log.writer,
        onEvent: (message) => events.push(message),
        readinessDelayMs: 0,
      });

      expect(simulator?.simulatorId).toBe('TEMP-SIM-123');
      expect(commands.map((item) => [item.command, ...item.args])).toEqual([
        ['xcrun', 'simctl', 'create', 'Claude UI weather 20260522T120000Z', 'iPhone 17 Pro Max'],
        ['xcrun', 'simctl', 'boot', 'TEMP-SIM-123'],
        ['xcrun', 'simctl', 'bootstatus', 'TEMP-SIM-123', '-b'],
      ]);
      expect(events).toEqual([
        'creating simulator Claude UI weather 20260522T120000Z',
        'booting simulator TEMP-SIM-123',
        'waiting for simulator TEMP-SIM-123 bootstatus',
        'simulator ready TEMP-SIM-123',
      ]);
      expect(log.messages.join('\n')).toContain(
        'Simulator frontend launch skipped by headless launch policy',
      );
    } finally {
      if (previousHeadlessValue === undefined) {
        delete process.env[HEADLESS_ENV_VAR];
      } else {
        process.env[HEADLESS_ENV_VAR] = previousHeadlessValue;
      }
    }
  });

  it('continues when the harness-created simulator is already booted before bootstatus', async () => {
    const logPath = '/tmp/simulator-lifecycle.log';
    const log = inMemoryLifecycleLog();
    const commands: LifecycleCommandOptions[] = [];
    const executor: LifecycleCommandExecutor = async (opts) => {
      commands.push(opts);
      if (opts.args[1] === 'create') {
        return { exitCode: 0, stdout: 'TEMP-SIM-BOOTED\n', stderr: '', durationSeconds: 0.01 };
      }
      if (opts.args[1] === 'boot') {
        return {
          exitCode: 149,
          stdout: '',
          stderr: 'Unable to boot device in current state: Booted',
          durationSeconds: 0.01,
        };
      }
      return { exitCode: 0, stdout: '', stderr: '', durationSeconds: 0.01 };
    };

    const simulator = await prepareTemporarySimulator({
      config: config(),
      suiteSlug: 'weather',
      timestamp: '20260522T120000Z',
      cwd: '/repo',
      logPath,
      executor,
      logWriter: log.writer,
      readinessDelayMs: 0,
    });

    expect(simulator?.simulatorId).toBe('TEMP-SIM-BOOTED');
    expect(
      commands.map((item) => (item.command === 'xcrun' ? item.args[1] : item.command)),
    ).toEqual(['create', 'boot', 'bootstatus', 'open']);
    expect(log.messages.join('\n')).toContain(
      'Boot command reported simulator was already booted; continuing',
    );
  });

  it('deletes the harness-created simulator when setup fails after creation', async () => {
    const logPath = '/tmp/simulator-lifecycle.log';
    const log = inMemoryLifecycleLog();
    const commands: LifecycleCommandOptions[] = [];
    const executor: LifecycleCommandExecutor = async (opts) => {
      commands.push(opts);
      if (opts.args[1] === 'create') {
        return { exitCode: 0, stdout: 'TEMP-SIM-SETUP-FAIL\n', stderr: '', durationSeconds: 0.01 };
      }
      if (opts.args[1] === 'bootstatus') {
        return { exitCode: 1, stdout: '', stderr: 'not ready', durationSeconds: 0.01 };
      }
      return { exitCode: 0, stdout: '', stderr: '', durationSeconds: 0.01 };
    };

    await expect(
      prepareTemporarySimulator({
        config: config(),
        suiteSlug: 'weather',
        timestamp: '20260522T120000Z',
        cwd: '/repo',
        logPath,
        executor,
        logWriter: log.writer,
        readinessDelayMs: 0,
      }),
    ).rejects.toThrow('temporary simulator did not reach bootstatus');

    expect(commands.map((item) => [item.command, ...item.args])).toEqual([
      ['xcrun', 'simctl', 'create', 'Claude UI weather 20260522T120000Z', 'iPhone 17 Pro Max'],
      ['xcrun', 'simctl', 'boot', 'TEMP-SIM-SETUP-FAIL'],
      ['xcrun', 'simctl', 'bootstatus', 'TEMP-SIM-SETUP-FAIL', '-b'],
      ['xcrun', 'simctl', 'delete', 'TEMP-SIM-SETUP-FAIL'],
    ]);
    expect(log.messages.join('\n')).toContain(
      'Setup failed, cleaning up simulator TEMP-SIM-SETUP-FAIL',
    );
  });

  it('logs deletion failures as best effort instead of throwing', async () => {
    const logPath = '/tmp/simulator-lifecycle.log';
    const log = inMemoryLifecycleLog();
    const simulator: CreatedTemporarySimulator = {
      createdByHarness: true,
      simulatorId: 'TEMP-SIM-DELETE-FAIL',
      name: 'Claude UI weather 20260522T120000Z',
      deviceTypeName: 'iPhone 17 Pro Max',
      logPath,
    };
    const executor: LifecycleCommandExecutor = async () => {
      throw new Error('simctl unavailable');
    };

    const deletion = await deleteTemporarySimulator(simulator, {
      cwd: '/repo',
      executor,
      logWriter: log.writer,
    });

    expect(deletion).toEqual({
      attempted: true,
      succeeded: false,
      exitCode: null,
      error: 'simctl unavailable',
    });
    expect(log.messages.join('\n')).toContain(
      'Delete failed for simulatorId: TEMP-SIM-DELETE-FAIL',
    );
    expect(log.messages.join('\n')).toContain('simctl unavailable');
  });

  it('still runs simctl delete when lifecycle logging fails', async () => {
    const logPath = '/tmp/simulator-lifecycle.log';
    const commands: LifecycleCommandOptions[] = [];
    const simulator: CreatedTemporarySimulator = {
      createdByHarness: true,
      simulatorId: 'TEMP-SIM-LOG-FAIL',
      name: 'Claude UI weather 20260522T120000Z',
      deviceTypeName: 'iPhone 17 Pro Max',
      logPath,
    };
    const executor: LifecycleCommandExecutor = async (opts) => {
      commands.push(opts);
      return { exitCode: 0, stdout: '', stderr: '', durationSeconds: 0.01 };
    };

    const deletion = await deleteTemporarySimulator(simulator, {
      cwd: '/repo',
      executor,
      logWriter: async () => {
        throw new Error('log unavailable');
      },
    });

    expect(commands[0]?.args).toEqual(['simctl', 'delete', 'TEMP-SIM-LOG-FAIL']);
    expect(deletion.attempted).toBe(true);
    expect(deletion.succeeded).toBe(true);
    expect(deletion.exitCode).toBe(0);
    expect(deletion.error).toBeDefined();
  });

  it('writes the temp simulatorId into an isolated MCP workspace config', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'claude-ui-mcp-config-'));
    const mcpConfigPath = path.join(directory, 'mcp-config.json');
    const mcpWorkspaceDirectory = path.join(directory, 'mcp-workspace');
    const mcpWorkspaceConfigPath = path.join(
      mcpWorkspaceDirectory,
      '.mobilebuildmcp',
      'config.yaml',
    );
    await writeMcpConfig({
      config: config(),
      mcpConfigPath,
      mcpWorkspaceDirectory,
      mcpWorkspaceConfigPath,
      workingDirectory: '/repo/example_projects/Weather',
      temporarySimulator: {
        createdByHarness: true,
        simulatorId: 'TEMP-SIM-123',
        name: 'Claude UI weather 20260522T120000Z',
        deviceTypeName: 'iPhone 17 Pro Max',
        logPath: path.join(directory, 'simulator-lifecycle.log'),
      },
    });

    const mcpConfig = JSON.parse(await readFile(mcpConfigPath, 'utf8')) as ClaudeMcpConfig;
    const isolatedConfig = parseYaml(
      await readFile(mcpWorkspaceConfigPath, 'utf8'),
    ) as IsolatedMcpWorkspaceConfig;

    expect(mcpConfig.mcpServers['mobilebuildmcp-dev'].env).toMatchObject({
      MOBILEBUILDMCP_CWD: mcpWorkspaceDirectory,
      MOBILEBUILDMCP_DEBUG: 'true',
      MOBILEBUILDMCP_SENTRY_DISABLED: 'true',
    });
    expect(mcpConfig.mcpServers['mobilebuildmcp-dev'].env).not.toHaveProperty(
      'MOBILEBUILDMCP_SIMULATOR_ID',
    );
    expect(mcpConfig.mcpServers['mobilebuildmcp-dev'].env).not.toHaveProperty(
      'MOBILEBUILDMCP_SIMULATOR_NAME',
    );
    expect(isolatedConfig).toMatchObject({
      schemaVersion: 1,
      enabledWorkflows: ['simulator', 'ui-automation'],
      debug: true,
      sentryDisabled: true,
      sessionDefaults: {
        simulatorId: 'TEMP-SIM-123',
        bundleId: 'com.example.App',
      },
    });
    expect(isolatedConfig.sessionDefaults).not.toHaveProperty('simulatorName');
  });

  it('removes ambient session-default env vars from the Claude process env', () => {
    const env = claudeBenchmarkEnv({
      PATH: '/usr/bin',
      CLAUDE_CODE_TOKEN: 'token',
      MOBILEBUILDMCP_CWD: '/repo/example_projects/Weather',
      MOBILEBUILDMCP_SIMULATOR_ID: 'STALE-SIM',
      MOBILEBUILDMCP_PROJECT_PATH: 'Stale.xcodeproj',
      MOBILEBUILDMCP_DEBUG: 'false',
    });

    expect(env.PATH).toBe('/usr/bin');
    expect(env.CLAUDE_CODE_TOKEN).toBe('token');
    expect(env.MOBILEBUILDMCP_DEBUG).toBe('false');
    expect(env).not.toHaveProperty('MOBILEBUILDMCP_CWD');
    expect(env).not.toHaveProperty('MOBILEBUILDMCP_SIMULATOR_ID');
    expect(env).not.toHaveProperty('MOBILEBUILDMCP_PROJECT_PATH');
  });

  it('resolves relative suite paths before writing the isolated MCP workspace config', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'claude-ui-mcp-config-'));
    const mcpWorkspaceDirectory = path.join(directory, 'mcp-workspace');
    const mcpWorkspaceConfigPath = path.join(
      mcpWorkspaceDirectory,
      '.mobilebuildmcp',
      'config.yaml',
    );

    await writeMcpConfig({
      config: config({
        sessionDefaults: {
          projectPath: 'Weather.xcodeproj',
          scheme: 'Weather',
          simulatorName: 'iPhone 17 Pro Max',
        },
      }),
      mcpConfigPath: path.join(directory, 'mcp-config.json'),
      mcpWorkspaceDirectory,
      mcpWorkspaceConfigPath,
      workingDirectory: '/repo/example_projects/Weather',
      temporarySimulator: {
        createdByHarness: true,
        simulatorId: 'TEMP-SIM-123',
        name: 'Claude UI weather 20260522T120000Z',
        deviceTypeName: 'iPhone 17 Pro Max',
        logPath: path.join(directory, 'simulator-lifecycle.log'),
      },
    });

    const isolatedConfig = parseYaml(
      await readFile(mcpWorkspaceConfigPath, 'utf8'),
    ) as IsolatedMcpWorkspaceConfig;

    expect(isolatedConfig.sessionDefaults.projectPath).toBe(
      '/repo/example_projects/Weather/Weather.xcodeproj',
    );
    expect(isolatedConfig.sessionDefaults.scheme).toBe('Weather');
    expect(isolatedConfig.sessionDefaults.simulatorId).toBe('TEMP-SIM-123');
  });
});
