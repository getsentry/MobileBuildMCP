import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  createMockCommandResponse,
  createMockFileSystemExecutor,
} from '../../../test-utils/mock-executors.ts';
import type { CommandExecutor } from '../../../utils/CommandExecutor.ts';
import type { Prompter } from '../../interactive/prompts.ts';
import { runSetupWizard } from '../setup.ts';

const cwd = '/repo';
const configPath = path.join(cwd, '.mobilebuildmcp', 'config.yaml');

function mockDeviceListJson(): string {
  return JSON.stringify({
    result: {
      devices: [
        {
          identifier: 'DEVICE-1',
          visibilityClass: 'Default',
          connectionProperties: {
            pairingState: 'paired',
            tunnelState: 'connected',
          },
          deviceProperties: {
            name: 'Cam iPhone',
            platformIdentifier: 'com.apple.platform.iphoneos',
          },
        },
      ],
    },
  });
}

function createSetupFs(opts?: {
  storedConfig?: string;
  projectEntries?: Array<{
    name: string;
    isDirectory: () => boolean;
    isSymbolicLink: () => boolean;
  }>;
}) {
  let storedConfig = opts?.storedConfig ?? '';
  const tempFiles = new Map<string, string>();

  const fs = createMockFileSystemExecutor({
    existsSync: (targetPath) => targetPath === configPath && storedConfig.length > 0,
    stat: async () => ({ isDirectory: () => true, mtimeMs: 0 }),
    readdir: async (targetPath) => {
      if (targetPath === cwd) {
        return (
          opts?.projectEntries ?? [
            {
              name: 'App.xcworkspace',
              isDirectory: () => true,
              isSymbolicLink: () => false,
            },
          ]
        );
      }

      return [];
    },
    readFile: async (targetPath) => {
      if (targetPath === configPath) {
        return storedConfig;
      }

      const tempContent = tempFiles.get(targetPath);
      if (tempContent != null) {
        return tempContent;
      }

      throw new Error(`Unexpected read path: ${targetPath}`);
    },
    writeFile: async (targetPath, content) => {
      if (targetPath === configPath) {
        storedConfig = content;
        return;
      }

      tempFiles.set(targetPath, content);
    },
    rm: async (targetPath) => {
      tempFiles.delete(targetPath);
    },
  });

  return {
    fs,
    getStoredConfig: () => storedConfig,
    setTempFile: (targetPath: string, content: string) => {
      tempFiles.set(targetPath, content);
    },
  };
}

function createTestPrompter(): Prompter {
  return {
    selectOne: async <T>(opts: { options: Array<{ value: T }> }) => {
      const preferredOption = opts.options.find((option) => option.value != null);
      return (preferredOption ?? opts.options[0]).value;
    },
    selectMany: async <T>(opts: { options: Array<{ value: T }> }) =>
      opts.options.map((option) => option.value),
    confirm: async (opts: { defaultValue: boolean }) => opts.defaultValue,
  };
}

function createPlatformPrompter(platforms: string[]): Prompter {
  let selectManyCalls = 0;
  return {
    selectOne: async <T>(opts: { options: Array<{ value: T }> }) => {
      const preferredOption = opts.options.find((option) => option.value != null);
      return (preferredOption ?? opts.options[0]).value;
    },
    selectMany: async <T>(opts: { options: Array<{ value: T }> }) => {
      selectManyCalls++;
      if (selectManyCalls === 1) {
        return opts.options
          .filter((option) => platforms.includes(String(option.value)))
          .map((option) => option.value);
      }
      return opts.options.map((option) => option.value);
    },
    confirm: async (opts: { defaultValue: boolean }) => opts.defaultValue,
  };
}

describe('setup command', () => {
  const originalStdinIsTTY = process.stdin.isTTY;
  const originalStdoutIsTTY = process.stdout.isTTY;

  beforeEach(() => {
    process.argv = ['node', 'script', 'setup'];
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: originalStdinIsTTY,
      configurable: true,
    });
    Object.defineProperty(process.stdout, 'isTTY', {
      value: originalStdoutIsTTY,
      configurable: true,
    });
  });

  it('exports a setup wizard that writes config selections', async () => {
    const { fs, getStoredConfig, setTempFile } = createSetupFs();

    const executor: CommandExecutor = async (command) => {
      if (command[0] === 'xcrun' && command[1] === 'devicectl') {
        setTempFile(command[5], mockDeviceListJson());
        return createMockCommandResponse({
          success: true,
          output: '',
        });
      }

      if (command.includes('--json')) {
        return createMockCommandResponse({
          success: true,
          output: JSON.stringify({
            devices: {
              'iOS 17.0': [
                {
                  name: 'iPhone 15',
                  udid: 'SIM-1',
                  state: 'Shutdown',
                  isAvailable: true,
                },
              ],
            },
          }),
        });
      }

      if (command[0] === 'xcrun') {
        return createMockCommandResponse({
          success: true,
          output: `== Devices ==\n-- iOS 17.0 --\n    iPhone 15 (SIM-1) (Shutdown)`,
        });
      }

      return createMockCommandResponse({
        success: true,
        output: `Information about workspace "App":\n    Schemes:\n        App`,
      });
    };

    const result = await runSetupWizard({
      cwd,
      fs,
      executor,
      prompter: createTestPrompter(),
      quietOutput: true,
    });
    expect(result.configPath).toBe(configPath);

    const parsed = parseYaml(getStoredConfig()) as {
      debug?: boolean;
      sentryDisabled?: boolean;
      enabledWorkflows?: string[];
      sessionDefaults?: Record<string, unknown>;
    };

    expect(parsed.enabledWorkflows?.length).toBeGreaterThan(0);
    expect(parsed.enabledWorkflows).not.toContain('doctor');
    expect(parsed.debug).toBe(false);
    expect(parsed.sentryDisabled).toBe(false);
    expect(parsed.sessionDefaults?.workspacePath).toBe('App.xcworkspace');
    expect(parsed.sessionDefaults?.scheme).toBe('App');
    expect(parsed.sessionDefaults?.deviceId).toBe('DEVICE-1');
    expect(parsed.sessionDefaults?.simulatorId).toBe('SIM-1');
    expect(parsed.sessionDefaults?.simulatorPlatform).toBe('iOS Simulator');
    expect(result.changedFields).toContainEqual(
      expect.stringContaining('sessionDefaults.simulatorPlatform'),
    );
  });

  it('does not offer simulators whose runtime is unavailable', async () => {
    const { fs, getStoredConfig, setTempFile } = createSetupFs();

    const executor: CommandExecutor = async (command) => {
      if (command[0] === 'xcrun' && command[1] === 'devicectl') {
        setTempFile(command[5], mockDeviceListJson());
        return createMockCommandResponse({ success: true, output: '' });
      }

      if (command.includes('--json')) {
        // Unavailable device is listed first: without filtering the picker would
        // select it. The available device must be chosen instead.
        return createMockCommandResponse({
          success: true,
          output: JSON.stringify({
            devices: {
              'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
                {
                  name: 'iPhone 17 Pro',
                  udid: 'SIM-UNAVAILABLE',
                  state: 'Shutdown',
                  isAvailable: false,
                },
              ],
              'com.apple.CoreSimulator.SimRuntime.iOS-17-0': [
                {
                  name: 'iPhone 15',
                  udid: 'SIM-AVAILABLE',
                  state: 'Shutdown',
                  isAvailable: true,
                },
              ],
            },
          }),
        });
      }

      if (command[0] === 'xcrun') {
        return createMockCommandResponse({
          success: true,
          output: `== Devices ==\n-- iOS 17.0 --\n    iPhone 15 (SIM-AVAILABLE) (Shutdown)`,
        });
      }

      return createMockCommandResponse({
        success: true,
        output: `Information about workspace "App":\n    Schemes:\n        App`,
      });
    };

    await runSetupWizard({
      cwd,
      fs,
      executor,
      prompter: createTestPrompter(),
      quietOutput: true,
    });

    const parsed = parseYaml(getStoredConfig()) as {
      sessionDefaults?: Record<string, unknown>;
    };

    expect(parsed.sessionDefaults?.simulatorId).toBe('SIM-AVAILABLE');
    expect(parsed.sessionDefaults?.simulatorName).toBe('iPhone 15');
    expect(parsed.sessionDefaults?.simulatorPlatform).toBe('iOS Simulator');
  });

  it('shows debug-gated workflows when existing config enables debug', async () => {
    const { fs, getStoredConfig, setTempFile } = createSetupFs({
      storedConfig: 'schemaVersion: 1\ndebug: true\n',
    });
    let offeredWorkflowIds: string[] = [];

    const executor: CommandExecutor = async (command) => {
      if (command[0] === 'xcrun' && command[1] === 'devicectl') {
        setTempFile(command[5], mockDeviceListJson());
        return createMockCommandResponse({
          success: true,
          output: '',
        });
      }

      if (command.includes('--json')) {
        return createMockCommandResponse({
          success: true,
          output: JSON.stringify({
            devices: {
              'iOS 17.0': [
                {
                  name: 'iPhone 15',
                  udid: 'SIM-1',
                  state: 'Shutdown',
                  isAvailable: true,
                },
              ],
            },
          }),
        });
      }

      if (command[0] === 'xcrun') {
        return createMockCommandResponse({
          success: true,
          output: `== Devices ==\n-- iOS 17.0 --\n    iPhone 15 (SIM-1) (Shutdown)`,
        });
      }

      return createMockCommandResponse({
        success: true,
        output: `Information about workspace "App":\n    Schemes:\n        App`,
      });
    };

    const prompter: Prompter = {
      selectOne: async <T>(opts: { options: Array<{ value: T }> }) => {
        const preferredOption = opts.options.find((option) => option.value != null);
        return (preferredOption ?? opts.options[0]).value;
      },
      selectMany: async <T>(opts: { options: Array<{ value: T }> }) => {
        offeredWorkflowIds = opts.options.map((option) => String(option.value));
        return opts.options.map((option) => option.value);
      },
      confirm: async (opts: { defaultValue: boolean; message: string }) =>
        opts.message === 'Show additional workflows?' ? true : opts.defaultValue,
    };

    await runSetupWizard({
      cwd,
      fs,
      executor,
      prompter,
      quietOutput: true,
    });

    const parsed = parseYaml(getStoredConfig()) as {
      debug?: boolean;
      enabledWorkflows?: string[];
    };

    expect(parsed.debug).toBe(true);
    expect(offeredWorkflowIds).toContain('doctor');
  });

  async function getWorkflowPromptStateForPlatforms(
    selectedPlatforms: string[],
    opts?: { showAdditionalWorkflows?: boolean; storedConfig?: string },
  ): Promise<{
    additionalWorkflowIds: string[];
    flatWorkflowIds: string[];
    recommendedInitialKeys: string[];
    recommendedWorkflowIds: string[];
  }> {
    const { fs } = createSetupFs({ storedConfig: opts?.storedConfig });
    let additionalWorkflowIds: string[] = [];
    let flatWorkflowIds: string[] = [];
    let recommendedInitialKeys: string[] = [];
    let recommendedWorkflowIds: string[] = [];

    const executor: CommandExecutor = async (command) => {
      if (command.includes('--json')) {
        return createMockCommandResponse({
          success: true,
          output: JSON.stringify({
            devices: {
              'iOS 17.0': [
                {
                  name: 'iPhone 15',
                  udid: 'SIM-1',
                  state: 'Shutdown',
                  isAvailable: true,
                },
              ],
            },
          }),
        });
      }

      if (command[0] === 'xcrun') {
        return createMockCommandResponse({
          success: true,
          output: `== Devices ==\n-- iOS 17.0 --\n    iPhone 15 (SIM-1) (Shutdown)`,
        });
      }

      return createMockCommandResponse({
        success: true,
        output: `Information about workspace "App":\n    Schemes:\n        App`,
      });
    };

    let selectManyCalls = 0;
    const prompter: Prompter = {
      selectOne: async <T>(selectOpts: { options: Array<{ value: T }> }) => {
        const preferredOption = selectOpts.options.find((option) => option.value != null);
        return (preferredOption ?? selectOpts.options[0]).value;
      },
      selectMany: async <T>(selectOpts: {
        options: Array<{ value: T }>;
        initialSelectedKeys?: ReadonlySet<string>;
        getKey: (value: T) => string;
      }) => {
        selectManyCalls++;
        if (selectManyCalls === 1) {
          return selectOpts.options
            .filter((option) => selectedPlatforms.includes(String(option.value)))
            .map((option) => option.value);
        }

        const workflowIds = selectOpts.options
          .map((option) => selectOpts.getKey(option.value))
          .sort();

        if (opts?.storedConfig != null) {
          flatWorkflowIds = workflowIds;
          return selectOpts.options
            .filter((option) =>
              selectOpts.initialSelectedKeys?.has(selectOpts.getKey(option.value)),
            )
            .map((option) => option.value);
        }

        if (selectManyCalls === 2) {
          recommendedInitialKeys = [
            ...(selectOpts.initialSelectedKeys ?? new Set<string>()),
          ].sort();
          recommendedWorkflowIds = workflowIds;
          return selectOpts.options
            .filter((option) => recommendedInitialKeys.includes(selectOpts.getKey(option.value)))
            .map((option) => option.value);
        }

        additionalWorkflowIds = workflowIds;
        return [];
      },
      confirm: async (confirmOpts: { defaultValue: boolean; message: string }) => {
        if (confirmOpts.message === 'Show additional workflows?') {
          return opts?.showAdditionalWorkflows ?? false;
        }
        return confirmOpts.defaultValue;
      },
    };

    await runSetupWizard({
      cwd,
      fs,
      executor,
      prompter,
      quietOutput: true,
    });

    return {
      additionalWorkflowIds,
      flatWorkflowIds,
      recommendedInitialKeys,
      recommendedWorkflowIds,
    };
  }

  it('shows iOS workflows as recommended options with only simulator selected by default', async () => {
    const state = await getWorkflowPromptStateForPlatforms(['iOS']);

    expect(state.recommendedInitialKeys).toEqual(['simulator']);
    expect(state.recommendedWorkflowIds).toEqual([
      'coverage',
      'debugging',
      'device',
      'project-discovery',
      'project-scaffolding',
      'simulator',
      'simulator-management',
      'swift-package',
      'ui-automation',
      'utilities',
      'xcode-ide',
    ]);
    expect(state.recommendedWorkflowIds).not.toContain('macos');
    expect(state.recommendedWorkflowIds).not.toContain('doctor');
    expect(state.recommendedWorkflowIds).not.toContain('session-management');
    expect(state.recommendedWorkflowIds).not.toContain('workflow-discovery');
  });

  it('shows macOS workflows as recommended options with only macos selected by default', async () => {
    const state = await getWorkflowPromptStateForPlatforms(['macOS']);

    expect(state.recommendedInitialKeys).toEqual(['macos']);
    expect(state.recommendedWorkflowIds).toEqual([
      'coverage',
      'macos',
      'project-discovery',
      'project-scaffolding',
      'swift-package',
      'utilities',
      'xcode-ide',
    ]);
    expect(state.recommendedWorkflowIds).not.toContain('debugging');
    expect(state.recommendedWorkflowIds).not.toContain('device');
    expect(state.recommendedWorkflowIds).not.toContain('simulator');
    expect(state.recommendedWorkflowIds).not.toContain('simulator-management');
    expect(state.recommendedWorkflowIds).not.toContain('ui-automation');
  });

  it('shows tvOS workflows as recommended options with only simulator selected by default', async () => {
    const state = await getWorkflowPromptStateForPlatforms(['tvOS']);

    expect(state.recommendedInitialKeys).toEqual(['simulator']);
    expect(state.recommendedWorkflowIds).toEqual([
      'coverage',
      'debugging',
      'device',
      'project-discovery',
      'simulator',
      'simulator-management',
      'swift-package',
      'utilities',
      'xcode-ide',
    ]);
    expect(state.recommendedWorkflowIds).not.toContain('macos');
    expect(state.recommendedWorkflowIds).not.toContain('project-scaffolding');
    expect(state.recommendedWorkflowIds).not.toContain('ui-automation');
  });

  it('selects macos and simulator by default for mixed macOS and simulator platforms', async () => {
    const state = await getWorkflowPromptStateForPlatforms(['macOS', 'iOS']);

    expect(state.recommendedInitialKeys).toEqual(['macos', 'simulator']);
    expect(state.recommendedWorkflowIds).toContain('macos');
    expect(state.recommendedWorkflowIds).toContain('simulator');
  });

  it('does not recommend ui-automation for visionOS from manifest target platform metadata', async () => {
    const state = await getWorkflowPromptStateForPlatforms(['visionOS']);

    expect(state.recommendedInitialKeys).toEqual(['simulator']);
    expect(state.recommendedWorkflowIds).not.toContain('ui-automation');
  });

  it('shows non-recommended workflows only after the user asks for additional options', async () => {
    const state = await getWorkflowPromptStateForPlatforms(['iOS'], {
      showAdditionalWorkflows: true,
    });

    expect(state.recommendedWorkflowIds).toContain('simulator');
    expect(state.recommendedWorkflowIds).toContain('xcode-ide');
    expect(state.additionalWorkflowIds).toContain('macos');
    expect(state.additionalWorkflowIds).not.toContain('simulator');
    expect(state.additionalWorkflowIds).not.toContain('xcode-ide');
  });

  it('uses the normal flat workflow list when loading an existing config', async () => {
    const state = await getWorkflowPromptStateForPlatforms(['iOS'], {
      storedConfig: 'schemaVersion: 1\nenabledWorkflows:\n  - simulator\n',
    });

    expect(state.flatWorkflowIds).toContain('simulator');
    expect(state.flatWorkflowIds).toContain('macos');
    expect(state.flatWorkflowIds).toContain('xcode-ide');
    expect(state.recommendedWorkflowIds).toEqual([]);
    expect(state.additionalWorkflowIds).toEqual([]);
  });

  it('fails fast when Xcode command line tools are unavailable', async () => {
    const failingExecutor: CommandExecutor = async (command) => {
      if (command[0] === 'xcodebuild') {
        return createMockCommandResponse({
          success: false,
          output: '',
          error: 'xcodebuild: command not found',
        });
      }

      return createMockCommandResponse({ success: true, output: '' });
    };

    await expect(
      runSetupWizard({
        cwd,
        fs: createMockFileSystemExecutor(),
        executor: failingExecutor,
        prompter: createTestPrompter(),
        quietOutput: true,
      }),
    ).rejects.toThrow('Setup prerequisites failed');
  });

  it('outputs MCP config JSON when format is mcp-json', async () => {
    const { fs, setTempFile } = createSetupFs();

    const executor: CommandExecutor = async (command) => {
      if (command[0] === 'xcrun' && command[1] === 'devicectl') {
        setTempFile(command[5], mockDeviceListJson());
        return createMockCommandResponse({
          success: true,
          output: '',
        });
      }

      if (command.includes('--json')) {
        return createMockCommandResponse({
          success: true,
          output: JSON.stringify({
            devices: {
              'iOS 17.0': [
                {
                  name: 'iPhone 15',
                  udid: 'SIM-1',
                  state: 'Shutdown',
                  isAvailable: true,
                },
              ],
            },
          }),
        });
      }

      if (command[0] === 'xcrun') {
        return createMockCommandResponse({
          success: true,
          output: `== Devices ==\n-- iOS 17.0 --\n    iPhone 15 (SIM-1) (Shutdown)`,
        });
      }

      return createMockCommandResponse({
        success: true,
        output: `Information about workspace "App":\n    Schemes:\n        App`,
      });
    };

    const result = await runSetupWizard({
      cwd,
      fs,
      executor,
      prompter: createTestPrompter(),
      quietOutput: true,
      outputFormat: 'mcp-json',
    });

    expect(result.configPath).toBeUndefined();
    expect(result.mcpConfigJson).toBeDefined();

    const parsed = JSON.parse(result.mcpConfigJson!) as {
      mcpServers: {
        MobileBuildMCP: {
          command: string;
          args: string[];
          env: Record<string, string>;
        };
      };
    };

    const serverConfig = parsed.mcpServers.MobileBuildMCP;
    expect(serverConfig.command).toBe('npx');
    expect(serverConfig.args).toEqual(['-y', 'mobilebuildmcp@latest', 'mcp']);
    expect(serverConfig.env.MOBILEBUILDMCP_ENABLED_WORKFLOWS).toBeDefined();
    expect(serverConfig.env.MOBILEBUILDMCP_WORKSPACE_PATH).toBe(path.join(cwd, 'App.xcworkspace'));
    expect(serverConfig.env.MOBILEBUILDMCP_SCHEME).toBe('App');
    expect(serverConfig.env.MOBILEBUILDMCP_DEVICE_ID).toBe('DEVICE-1');
    expect(serverConfig.env.MOBILEBUILDMCP_SIMULATOR_ID).toBe('SIM-1');
    expect(serverConfig.env.MOBILEBUILDMCP_SIMULATOR_NAME).toBe('iPhone 15');
  });

  it('does not require simulator or device defaults when selected workflows do not depend on them', async () => {
    const { fs, getStoredConfig } = createSetupFs();

    const executor: CommandExecutor = async (command) => {
      if (command[0] === 'xcrun' && command.includes('simctl')) {
        throw new Error('simulator lookup should not run for workflows without simulator defaults');
      }

      if (command[0] === 'xcrun' && command[1] === 'devicectl') {
        throw new Error('device lookup should not run for workflows without device defaults');
      }

      return createMockCommandResponse({
        success: true,
        output: `Information about workspace "App":\n    Schemes:\n        App`,
      });
    };

    const prompter: Prompter = {
      selectOne: async <T>(opts: { options: Array<{ value: T }> }) => {
        const preferredOption = opts.options.find((option) => option.value != null);
        return (preferredOption ?? opts.options[0]).value;
      },
      selectMany: async <T>(opts: { options: Array<{ value: T }> }) => {
        const macosOption = opts.options.find((option) => option.value === ('macos' as T));
        return macosOption ? [macosOption.value] : opts.options.map((option) => option.value);
      },
      confirm: async (opts: { defaultValue: boolean }) => opts.defaultValue,
    };

    const result = await runSetupWizard({
      cwd,
      fs,
      executor,
      prompter,
      quietOutput: true,
    });

    expect(result.configPath).toBe(configPath);

    const parsed = parseYaml(getStoredConfig()) as {
      enabledWorkflows?: string[];
      sessionDefaults?: Record<string, unknown>;
    };

    expect(parsed.enabledWorkflows).toEqual(['macos']);
    expect(parsed.sessionDefaults?.workspacePath).toBe('App.xcworkspace');
    expect(parsed.sessionDefaults?.scheme).toBe('App');
    expect(parsed.sessionDefaults?.deviceId).toBeUndefined();
    expect(parsed.sessionDefaults?.simulatorId).toBeUndefined();
    expect(parsed.sessionDefaults?.simulatorName).toBeUndefined();
  });

  it('collects a device default without requiring simulator selection when only device-dependent workflows are enabled', async () => {
    const { fs, setTempFile } = createSetupFs();

    const executor: CommandExecutor = async (command) => {
      if (command[0] === 'xcrun' && command.includes('simctl')) {
        throw new Error('simulator lookup should not run for device-only workflows');
      }

      if (command[0] === 'xcrun' && command[1] === 'devicectl') {
        setTempFile(command[5], mockDeviceListJson());
        return createMockCommandResponse({
          success: true,
          output: '',
        });
      }

      return createMockCommandResponse({
        success: true,
        output: `Information about workspace "App":\n    Schemes:\n        App`,
      });
    };

    const prompter: Prompter = {
      selectOne: async <T>(opts: { options: Array<{ value: T }> }) => {
        const preferredOption = opts.options.find((option) => option.value != null);
        return (preferredOption ?? opts.options[0]).value;
      },
      selectMany: async <T>(opts: { options: Array<{ value: T }> }) => {
        const deviceOption = opts.options.find((option) => option.value === ('device' as T));
        return deviceOption ? [deviceOption.value] : opts.options.map((option) => option.value);
      },
      confirm: async (opts: { defaultValue: boolean }) => opts.defaultValue,
    };

    const result = await runSetupWizard({
      cwd,
      fs,
      executor,
      prompter,
      quietOutput: true,
      outputFormat: 'mcp-json',
    });

    const parsed = JSON.parse(result.mcpConfigJson!) as {
      mcpServers: {
        MobileBuildMCP: {
          env: Record<string, string>;
        };
      };
    };

    const env = parsed.mcpServers.MobileBuildMCP.env;
    expect(env.MOBILEBUILDMCP_ENABLED_WORKFLOWS).toBe('device');
    expect(env.MOBILEBUILDMCP_WORKSPACE_PATH).toBe(path.join(cwd, 'App.xcworkspace'));
    expect(env.MOBILEBUILDMCP_SCHEME).toBe('App');
    expect(env.MOBILEBUILDMCP_DEVICE_ID).toBe('DEVICE-1');
    expect(env.MOBILEBUILDMCP_SIMULATOR_ID).toBeUndefined();
    expect(env.MOBILEBUILDMCP_SIMULATOR_NAME).toBeUndefined();
  });

  it('allows clearing an existing simulator default when simulator workflows are enabled', async () => {
    const { fs, getStoredConfig } = createSetupFs({
      storedConfig: `schemaVersion: 1
enabledWorkflows:
  - simulator
sessionDefaults:
  workspacePath: App.xcworkspace
  scheme: App
  simulatorId: SIM-1
  simulatorName: iPhone 15
`,
    });

    const executor: CommandExecutor = async (command) => {
      if (command.includes('--json')) {
        return createMockCommandResponse({
          success: true,
          output: JSON.stringify({
            devices: {
              'iOS 17.0': [
                {
                  name: 'iPhone 15',
                  udid: 'SIM-1',
                  state: 'Shutdown',
                  isAvailable: true,
                },
              ],
            },
          }),
        });
      }

      if (command[0] === 'xcrun') {
        return createMockCommandResponse({
          success: true,
          output: `== Devices ==\n-- iOS 17.0 --\n    iPhone 15 (SIM-1) (Shutdown)`,
        });
      }

      return createMockCommandResponse({
        success: true,
        output: `Information about workspace "App":\n    Schemes:\n        App`,
      });
    };

    let selectCallCount = 0;
    const prompter: Prompter = {
      selectOne: async <T>(opts: { options: Array<{ value: T }> }) => {
        selectCallCount += 1;
        if (selectCallCount === 3) {
          return opts.options[0].value;
        }
        const preferredOption = opts.options.find((option) => option.value != null);
        return (preferredOption ?? opts.options[0]).value;
      },
      selectMany: async <T>(opts: { options: Array<{ value: T }> }) => {
        const simulatorOption = opts.options.find((option) => option.value === ('simulator' as T));
        return simulatorOption
          ? [simulatorOption.value]
          : opts.options.map((option) => option.value);
      },
      confirm: async (opts: { defaultValue: boolean }) => opts.defaultValue,
    };

    await runSetupWizard({
      cwd,
      fs,
      executor,
      prompter,
      quietOutput: true,
    });

    const parsed = parseYaml(getStoredConfig()) as {
      sessionDefaults?: Record<string, unknown>;
    };

    expect(parsed.sessionDefaults?.simulatorId).toBeUndefined();
    expect(parsed.sessionDefaults?.simulatorName).toBeUndefined();
  });

  it('continues setup with no default device when no devices are available', async () => {
    const { fs, getStoredConfig } = createSetupFs();

    const executor: CommandExecutor = async (command) => {
      if (command[0] === 'xcrun' && command[1] === 'devicectl') {
        return createMockCommandResponse({ success: true, output: '' });
      }

      if (command[0] === 'xcrun' && command[1] === 'xctrace') {
        return createMockCommandResponse({ success: true, output: '' });
      }

      if (command.includes('--json')) {
        return createMockCommandResponse({
          success: true,
          output: JSON.stringify({
            devices: {
              'iOS 17.0': [
                {
                  name: 'iPhone 15',
                  udid: 'SIM-1',
                  state: 'Shutdown',
                  isAvailable: true,
                },
              ],
            },
          }),
        });
      }

      return createMockCommandResponse({
        success: true,
        output: `Information about workspace "App":\n    Schemes:\n        App`,
      });
    };

    const prompter: Prompter = {
      selectOne: async <T>(opts: { options: Array<{ value: T }> }) => opts.options[0].value,
      selectMany: async <T>(opts: { options: Array<{ value: T }> }) => {
        const loggingOption = opts.options.find((option) => option.value === ('logging' as T));
        return loggingOption ? [loggingOption.value] : opts.options.map((option) => option.value);
      },
      confirm: async (opts: { defaultValue: boolean }) => opts.defaultValue,
    };

    await runSetupWizard({
      cwd,
      fs,
      executor,
      prompter,
      quietOutput: true,
    });

    const parsed = parseYaml(getStoredConfig()) as {
      sessionDefaults?: Record<string, unknown>;
    };

    expect(parsed.sessionDefaults?.deviceId).toBeUndefined();
    expect(parsed.sessionDefaults?.simulatorId).toBeUndefined();
    expect(parsed.sessionDefaults?.simulatorName).toBeUndefined();
  });

  it('continues setup with no default device when an existing device default no longer exists', async () => {
    const { fs, getStoredConfig } = createSetupFs({
      storedConfig: `schemaVersion: 1
enabledWorkflows:
  - device
sessionDefaults:
  workspacePath: App.xcworkspace
  scheme: App
  deviceId: DEVICE-OLD
`,
    });

    const executor: CommandExecutor = async (command) => {
      if (command[0] === 'xcrun' && command[1] === 'devicectl') {
        return createMockCommandResponse({ success: true, output: '' });
      }

      if (command[0] === 'xcrun' && command[1] === 'xctrace') {
        return createMockCommandResponse({ success: true, output: '' });
      }

      return createMockCommandResponse({
        success: true,
        output: `Information about workspace "App":\n    Schemes:\n        App`,
      });
    };

    const prompter: Prompter = {
      selectOne: async <T>(opts: { options: Array<{ value: T }> }) => opts.options[0].value,
      selectMany: async <T>(opts: { options: Array<{ value: T }> }) => {
        const deviceOption = opts.options.find((option) => option.value === ('device' as T));
        return deviceOption ? [deviceOption.value] : opts.options.map((option) => option.value);
      },
      confirm: async (opts: { defaultValue: boolean }) => opts.defaultValue,
    };

    await runSetupWizard({
      cwd,
      fs,
      executor,
      prompter,
      quietOutput: true,
    });

    const parsed = parseYaml(getStoredConfig()) as {
      sessionDefaults?: Record<string, unknown>;
    };

    expect(parsed.sessionDefaults?.deviceId).toBeUndefined();
  });

  it('continues setup with no default device when both discovery commands fail', async () => {
    const { fs, getStoredConfig } = createSetupFs();

    const executor: CommandExecutor = async (command) => {
      if (command[0] === 'xcrun' && command[1] === 'devicectl') {
        throw new Error('devicectl unavailable');
      }

      if (command[0] === 'xcrun' && command[1] === 'xctrace') {
        return createMockCommandResponse({ success: false, output: '', error: 'xctrace failed' });
      }

      if (command.includes('--json')) {
        return createMockCommandResponse({
          success: true,
          output: JSON.stringify({
            devices: {
              'iOS 17.0': [
                {
                  name: 'iPhone 15',
                  udid: 'SIM-1',
                  state: 'Shutdown',
                  isAvailable: true,
                },
              ],
            },
          }),
        });
      }

      return createMockCommandResponse({
        success: true,
        output: `Information about workspace "App":\n    Schemes:\n        App`,
      });
    };

    const prompter: Prompter = {
      selectOne: async <T>(opts: { options: Array<{ value: T }> }) => opts.options[0].value,
      selectMany: async <T>(opts: { options: Array<{ value: T }> }) => {
        const loggingOption = opts.options.find((option) => option.value === ('logging' as T));
        return loggingOption ? [loggingOption.value] : opts.options.map((option) => option.value);
      },
      confirm: async (opts: { defaultValue: boolean }) => opts.defaultValue,
    };

    await runSetupWizard({
      cwd,
      fs,
      executor,
      prompter,
      quietOutput: true,
    });

    const parsed = parseYaml(getStoredConfig()) as {
      sessionDefaults?: Record<string, unknown>;
    };

    expect(parsed.sessionDefaults?.deviceId).toBeUndefined();
    expect(parsed.sessionDefaults?.simulatorId).toBeUndefined();
    expect(parsed.sessionDefaults?.simulatorName).toBeUndefined();
  });

  it('continues setup with no default device when xctrace spawn fails', async () => {
    const { fs, getStoredConfig } = createSetupFs();

    const executor: CommandExecutor = async (command) => {
      if (command[0] === 'xcrun' && command[1] === 'devicectl') {
        throw new Error('devicectl unavailable');
      }

      if (command[0] === 'xcrun' && command[1] === 'xctrace') {
        throw new Error('xctrace spawn failed');
      }

      if (command.includes('--json')) {
        return createMockCommandResponse({
          success: true,
          output: JSON.stringify({
            devices: {
              'iOS 17.0': [
                {
                  name: 'iPhone 15',
                  udid: 'SIM-1',
                  state: 'Shutdown',
                  isAvailable: true,
                },
              ],
            },
          }),
        });
      }

      return createMockCommandResponse({
        success: true,
        output: `Information about workspace "App":\n    Schemes:\n        App`,
      });
    };

    const prompter: Prompter = {
      selectOne: async <T>(opts: { options: Array<{ value: T }> }) => opts.options[0].value,
      selectMany: async <T>(opts: { options: Array<{ value: T }> }) => {
        const loggingOption = opts.options.find((option) => option.value === ('logging' as T));
        return loggingOption ? [loggingOption.value] : opts.options.map((option) => option.value);
      },
      confirm: async (opts: { defaultValue: boolean }) => opts.defaultValue,
    };

    await runSetupWizard({
      cwd,
      fs,
      executor,
      prompter,
      quietOutput: true,
    });

    const parsed = parseYaml(getStoredConfig()) as {
      sessionDefaults?: Record<string, unknown>;
    };

    expect(parsed.sessionDefaults?.deviceId).toBeUndefined();
    expect(parsed.sessionDefaults?.simulatorId).toBeUndefined();
    expect(parsed.sessionDefaults?.simulatorName).toBeUndefined();
  });

  it('uses xctrace fallback when temp path creation fails', async () => {
    const { fs, getStoredConfig } = createSetupFs();
    fs.tmpdir = () => {
      throw new Error('tmpdir unavailable');
    };

    const executor: CommandExecutor = async (command) => {
      if (command[0] === 'xcrun' && command[1] === 'xctrace') {
        return createMockCommandResponse({
          success: true,
          output: 'Cam iPhone (12345678-1234-1234-1234-123456789ABC)',
        });
      }

      return createMockCommandResponse({
        success: true,
        output: `Information about workspace "App":\n    Schemes:\n        App`,
      });
    };

    const prompter: Prompter = {
      selectOne: async <T>(opts: { options: Array<{ value: T }> }) =>
        opts.options.find((option) => option.value != null)?.value ?? opts.options[0].value,
      selectMany: async <T>(opts: { options: Array<{ value: T }> }) => {
        const loggingOption = opts.options.find((option) => option.value === ('logging' as T));
        return loggingOption ? [loggingOption.value] : opts.options.map((option) => option.value);
      },
      confirm: async (opts: { defaultValue: boolean }) => opts.defaultValue,
    };

    await runSetupWizard({
      cwd,
      fs,
      executor,
      prompter,
      quietOutput: true,
    });

    const parsed = parseYaml(getStoredConfig()) as {
      sessionDefaults?: Record<string, unknown>;
    };

    expect(parsed.sessionDefaults?.deviceId).toBe('12345678-1234-1234-1234-123456789ABC');
  });

  it('continues setup with no default device when device json parsing fails', async () => {
    const { fs, getStoredConfig, setTempFile } = createSetupFs();

    const executor: CommandExecutor = async (command) => {
      if (command[0] === 'xcrun' && command[1] === 'devicectl') {
        const jsonPath = command[command.length - 1];
        setTempFile(jsonPath, 'not json');
        return createMockCommandResponse({ success: true, output: '' });
      }

      if (command[0] === 'xcrun' && command[1] === 'xctrace') {
        throw new Error('xctrace spawn failed');
      }

      return createMockCommandResponse({
        success: true,
        output: `Information about workspace "App":\n    Schemes:\n        App`,
      });
    };

    const prompter: Prompter = {
      selectOne: async <T>(opts: { options: Array<{ value: T }> }) => opts.options[0].value,
      selectMany: async <T>(opts: { options: Array<{ value: T }> }) => {
        const loggingOption = opts.options.find((option) => option.value === ('logging' as T));
        return loggingOption ? [loggingOption.value] : opts.options.map((option) => option.value);
      },
      confirm: async (opts: { defaultValue: boolean }) => opts.defaultValue,
    };

    await runSetupWizard({
      cwd,
      fs,
      executor,
      prompter,
      quietOutput: true,
    });

    const parsed = parseYaml(getStoredConfig()) as {
      sessionDefaults?: Record<string, unknown>;
    };

    expect(parsed.sessionDefaults?.deviceId).toBeUndefined();
  });

  it('continues setup with no default simulator when simctl text fallback fails', async () => {
    const { fs, getStoredConfig } = createSetupFs();

    const executor: CommandExecutor = async (command) => {
      if (command[0] === 'xcrun' && command[1] === 'devicectl') {
        throw new Error('device lookup should not run for simulator-only workflows');
      }

      if (command[0] === 'xcrun' && command[1] === 'simctl' && command.includes('--json')) {
        return createMockCommandResponse({
          success: true,
          output: JSON.stringify({
            devices: {
              'iOS 17.0': [
                {
                  name: 'iPhone 15',
                  udid: 'SIM-1',
                  state: 'Shutdown',
                  isAvailable: true,
                },
              ],
            },
          }),
        });
      }

      if (command[0] === 'xcrun' && command[1] === 'simctl') {
        throw new Error('simctl text fallback unavailable');
      }

      return createMockCommandResponse({
        success: true,
        output: `Information about workspace "App":\n    Schemes:\n        App`,
      });
    };

    const prompter: Prompter = {
      selectOne: async <T>(opts: { options: Array<{ value: T }> }) => opts.options[0].value,
      selectMany: async <T>(opts: { options: Array<{ value: T }> }) => {
        const simulatorOption = opts.options.find((option) => option.value === ('simulator' as T));
        return simulatorOption
          ? [simulatorOption.value]
          : opts.options.map((option) => option.value);
      },
      confirm: async (opts: { defaultValue: boolean }) => opts.defaultValue,
    };

    await runSetupWizard({
      cwd,
      fs,
      executor,
      prompter,
      quietOutput: true,
    });

    const parsed = parseYaml(getStoredConfig()) as {
      sessionDefaults?: Record<string, unknown>;
    };

    expect(parsed.sessionDefaults?.simulatorId).toBeUndefined();
    expect(parsed.sessionDefaults?.simulatorName).toBeUndefined();
  });

  it('continues setup with no default simulator when simulator discovery fails', async () => {
    const { fs, getStoredConfig } = createSetupFs();

    const executor: CommandExecutor = async (command) => {
      if (command[0] === 'xcrun' && command[1] === 'devicectl') {
        throw new Error('device lookup should not run for simulator-only workflows');
      }

      if (command[0] === 'xcrun' && command[1] === 'simctl') {
        throw new Error('simctl unavailable');
      }

      return createMockCommandResponse({
        success: true,
        output: `Information about workspace "App":\n    Schemes:\n        App`,
      });
    };

    const prompter: Prompter = {
      selectOne: async <T>(opts: { options: Array<{ value: T }> }) => opts.options[0].value,
      selectMany: async <T>(opts: { options: Array<{ value: T }> }) => {
        const simulatorOption = opts.options.find((option) => option.value === ('simulator' as T));
        return simulatorOption
          ? [simulatorOption.value]
          : opts.options.map((option) => option.value);
      },
      confirm: async (opts: { defaultValue: boolean }) => opts.defaultValue,
    };

    await runSetupWizard({
      cwd,
      fs,
      executor,
      prompter,
      quietOutput: true,
    });

    const parsed = parseYaml(getStoredConfig()) as {
      sessionDefaults?: Record<string, unknown>;
    };

    expect(parsed.sessionDefaults?.simulatorId).toBeUndefined();
    expect(parsed.sessionDefaults?.simulatorName).toBeUndefined();
  });

  it('continues setup with no default simulator when no simulators are available', async () => {
    const { fs, getStoredConfig } = createSetupFs();

    const executor: CommandExecutor = async (command) => {
      if (command[0] === 'xcrun' && command[1] === 'devicectl') {
        throw new Error('device lookup should not run for simulator-only workflows');
      }

      if (command.includes('--json')) {
        return createMockCommandResponse({
          success: true,
          output: JSON.stringify({ devices: {} }),
        });
      }

      return createMockCommandResponse({
        success: true,
        output: `Information about workspace "App":\n    Schemes:\n        App`,
      });
    };

    const prompter: Prompter = {
      selectOne: async <T>(opts: { options: Array<{ value: T }> }) => opts.options[0].value,
      selectMany: async <T>(opts: { options: Array<{ value: T }> }) => {
        const simulatorOption = opts.options.find((option) => option.value === ('simulator' as T));
        return simulatorOption
          ? [simulatorOption.value]
          : opts.options.map((option) => option.value);
      },
      confirm: async (opts: { defaultValue: boolean }) => opts.defaultValue,
    };

    await runSetupWizard({
      cwd,
      fs,
      executor,
      prompter,
      quietOutput: true,
    });

    const parsed = parseYaml(getStoredConfig()) as {
      sessionDefaults?: Record<string, unknown>;
    };

    expect(parsed.sessionDefaults?.simulatorId).toBeUndefined();
    expect(parsed.sessionDefaults?.simulatorName).toBeUndefined();
  });

  it('fails in non-interactive mode', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });

    await expect(runSetupWizard()).rejects.toThrow('requires an interactive TTY');
  });

  it('skips simulator and sets platform for macOS-only selection', async () => {
    let storedConfig = '';

    const fs = createMockFileSystemExecutor({
      existsSync: (targetPath) => targetPath === configPath && storedConfig.length > 0,
      stat: async () => ({ isDirectory: () => true, mtimeMs: 0 }),
      readdir: async (targetPath) => {
        if (targetPath === cwd) {
          return [
            {
              name: 'App.xcworkspace',
              isDirectory: () => true,
              isSymbolicLink: () => false,
            },
          ];
        }
        return [];
      },
      readFile: async (targetPath) => {
        if (targetPath !== configPath) throw new Error(`Unexpected read path: ${targetPath}`);
        return storedConfig;
      },
      writeFile: async (targetPath, content) => {
        if (targetPath !== configPath) throw new Error(`Unexpected write path: ${targetPath}`);
        storedConfig = content;
      },
    });

    const executor: CommandExecutor = async () =>
      createMockCommandResponse({
        success: true,
        output: `Information about workspace "App":\n    Schemes:\n        App`,
      });

    await runSetupWizard({
      cwd,
      fs,
      executor,
      prompter: createPlatformPrompter(['macOS']),
      quietOutput: true,
    });

    const parsed = parseYaml(storedConfig) as {
      sessionDefaults?: Record<string, unknown>;
      setupPreferences?: { platforms?: string[] };
    };

    expect(parsed.setupPreferences?.platforms).toEqual(['macOS']);
    expect(parsed.sessionDefaults?.platform).toBeUndefined();
    expect(parsed.sessionDefaults?.simulatorId).toBeUndefined();
    expect(parsed.sessionDefaults?.simulatorName).toBeUndefined();
  });

  it('outputs MOBILEBUILDMCP_PLATFORM=macOS and no simulator fields for macOS-only mcp-json', async () => {
    const fs = createMockFileSystemExecutor({
      existsSync: () => false,
      stat: async () => ({ isDirectory: () => true, mtimeMs: 0 }),
      readdir: async (targetPath) => {
        if (targetPath === cwd) {
          return [
            {
              name: 'App.xcworkspace',
              isDirectory: () => true,
              isSymbolicLink: () => false,
            },
          ];
        }
        return [];
      },
      readFile: async () => '',
      writeFile: async () => {},
    });

    const executor: CommandExecutor = async () =>
      createMockCommandResponse({
        success: true,
        output: `Information about workspace "App":\n    Schemes:\n        App`,
      });

    const result = await runSetupWizard({
      cwd,
      fs,
      executor,
      prompter: createPlatformPrompter(['macOS']),
      quietOutput: true,
      outputFormat: 'mcp-json',
    });

    expect(result.mcpConfigJson).toBeDefined();
    const parsed = JSON.parse(result.mcpConfigJson!) as {
      mcpServers: { MobileBuildMCP: { env: Record<string, string> } };
    };
    const env = parsed.mcpServers.MobileBuildMCP.env;

    expect(env.MOBILEBUILDMCP_PLATFORM).toBe('macOS');
    expect(env.MOBILEBUILDMCP_SIMULATOR_ID).toBeUndefined();
    expect(env.MOBILEBUILDMCP_SIMULATOR_NAME).toBeUndefined();
  });

  it('outputs MOBILEBUILDMCP_PLATFORM=iOS Simulator and simulator fields for iOS-only mcp-json', async () => {
    const fs = createMockFileSystemExecutor({
      existsSync: () => false,
      stat: async () => ({ isDirectory: () => true, mtimeMs: 0 }),
      readdir: async (targetPath) => {
        if (targetPath === cwd) {
          return [
            {
              name: 'App.xcworkspace',
              isDirectory: () => true,
              isSymbolicLink: () => false,
            },
          ];
        }
        return [];
      },
      readFile: async () => '',
      writeFile: async () => {},
    });

    const executor: CommandExecutor = async (command) => {
      if (command.includes('--json')) {
        return createMockCommandResponse({
          success: true,
          output: JSON.stringify({
            devices: {
              'iOS 17.0': [
                { name: 'iPhone 15', udid: 'SIM-1', state: 'Shutdown', isAvailable: true },
              ],
            },
          }),
        });
      }
      if (command[0] === 'xcrun') {
        return createMockCommandResponse({
          success: true,
          output: `== Devices ==\n-- iOS 17.0 --\n    iPhone 15 (SIM-1) (Shutdown)`,
        });
      }
      return createMockCommandResponse({
        success: true,
        output: `Information about workspace "App":\n    Schemes:\n        App`,
      });
    };

    const result = await runSetupWizard({
      cwd,
      fs,
      executor,
      prompter: createPlatformPrompter(['iOS']),
      quietOutput: true,
      outputFormat: 'mcp-json',
    });

    expect(result.mcpConfigJson).toBeDefined();
    const parsed = JSON.parse(result.mcpConfigJson!) as {
      mcpServers: { MobileBuildMCP: { env: Record<string, string> } };
    };
    const env = parsed.mcpServers.MobileBuildMCP.env;

    expect(env.MOBILEBUILDMCP_PLATFORM).toBe('iOS Simulator');
    expect(env.MOBILEBUILDMCP_SIMULATOR_ID).toBe('SIM-1');
    expect(env.MOBILEBUILDMCP_SIMULATOR_NAME).toBe('iPhone 15');
  });

  it('omits MOBILEBUILDMCP_PLATFORM for multi-platform mcp-json', async () => {
    const fs = createMockFileSystemExecutor({
      existsSync: () => false,
      stat: async () => ({ isDirectory: () => true, mtimeMs: 0 }),
      readdir: async (targetPath) => {
        if (targetPath === cwd) {
          return [
            {
              name: 'App.xcworkspace',
              isDirectory: () => true,
              isSymbolicLink: () => false,
            },
          ];
        }
        return [];
      },
      readFile: async () => '',
      writeFile: async () => {},
    });

    const executor: CommandExecutor = async (command) => {
      if (command.includes('--json')) {
        return createMockCommandResponse({
          success: true,
          output: JSON.stringify({
            devices: {
              'iOS 17.0': [
                { name: 'iPhone 15', udid: 'SIM-1', state: 'Shutdown', isAvailable: true },
              ],
            },
          }),
        });
      }
      if (command[0] === 'xcrun') {
        return createMockCommandResponse({
          success: true,
          output: `== Devices ==\n-- iOS 17.0 --\n    iPhone 15 (SIM-1) (Shutdown)`,
        });
      }
      return createMockCommandResponse({
        success: true,
        output: `Information about workspace "App":\n    Schemes:\n        App`,
      });
    };

    const result = await runSetupWizard({
      cwd,
      fs,
      executor,
      prompter: createPlatformPrompter(['macOS', 'iOS']),
      quietOutput: true,
      outputFormat: 'mcp-json',
    });

    expect(result.mcpConfigJson).toBeDefined();
    const parsed = JSON.parse(result.mcpConfigJson!) as {
      mcpServers: { MobileBuildMCP: { env: Record<string, string> } };
    };
    const env = parsed.mcpServers.MobileBuildMCP.env;

    expect(env.MOBILEBUILDMCP_PLATFORM).toBeUndefined();
    expect(env.MOBILEBUILDMCP_SIMULATOR_ID).toBe('SIM-1');
  });

  it('clears stale deviceId, simulatorId, and simulatorName for macOS-only re-runs', async () => {
    let storedConfig = [
      'enabledWorkflows:',
      '  - simulator',
      '  - logging',
      'sessionDefaults:',
      '  scheme: App',
      '  workspacePath: ./App.xcworkspace',
      '  deviceId: STALE-DEVICE',
      '  simulatorId: STALE-SIM',
      '  simulatorName: Old iPhone',
      '  platform: iOS Simulator',
      '',
    ].join('\n');

    const fs = createMockFileSystemExecutor({
      existsSync: (targetPath) => targetPath === configPath,
      stat: async () => ({ isDirectory: () => true, mtimeMs: 0 }),
      readdir: async (targetPath) => {
        if (targetPath === cwd) {
          return [
            {
              name: 'App.xcworkspace',
              isDirectory: () => true,
              isSymbolicLink: () => false,
            },
          ];
        }
        return [];
      },
      readFile: async (targetPath) => {
        if (targetPath !== configPath) throw new Error(`Unexpected read path: ${targetPath}`);
        return storedConfig;
      },
      writeFile: async (targetPath, content) => {
        if (targetPath !== configPath) throw new Error(`Unexpected write path: ${targetPath}`);
        storedConfig = content;
      },
    });

    const executor: CommandExecutor = async () =>
      createMockCommandResponse({
        success: true,
        output: `Information about workspace "App":\n    Schemes:\n        App`,
      });

    await runSetupWizard({
      cwd,
      fs,
      executor,
      prompter: createPlatformPrompter(['macOS']),
      quietOutput: true,
    });

    const parsed = parseYaml(storedConfig) as {
      sessionDefaults?: Record<string, unknown>;
    };

    expect(
      (parsed as { setupPreferences?: { platforms?: string[] } }).setupPreferences?.platforms,
    ).toEqual(['macOS']);
    // setup intentionally does not touch sessionDefaults.platform (agent-controlled field);
    // the pre-existing value from the fixture is preserved.
    expect(parsed.sessionDefaults?.platform).toBe('iOS Simulator');
    expect(parsed.sessionDefaults?.deviceId).toBeUndefined();
    expect(parsed.sessionDefaults?.simulatorId).toBeUndefined();
    expect(parsed.sessionDefaults?.simulatorName).toBeUndefined();
  });

  it('persists platform=tvOS Simulator and a tvOS-runtime simulator for tvOS-only YAML setup', async () => {
    let storedConfig = '';

    const fs = createMockFileSystemExecutor({
      existsSync: (targetPath) => targetPath === configPath && storedConfig.length > 0,
      stat: async () => ({ isDirectory: () => true, mtimeMs: 0 }),
      readdir: async (targetPath) => {
        if (targetPath === cwd) {
          return [
            {
              name: 'App.xcworkspace',
              isDirectory: () => true,
              isSymbolicLink: () => false,
            },
          ];
        }
        return [];
      },
      readFile: async (targetPath) => {
        if (targetPath !== configPath) throw new Error(`Unexpected read path: ${targetPath}`);
        return storedConfig;
      },
      writeFile: async (targetPath, content) => {
        if (targetPath !== configPath) throw new Error(`Unexpected write path: ${targetPath}`);
        storedConfig = content;
      },
    });

    const executor: CommandExecutor = async (command) => {
      if (command.includes('--json')) {
        return createMockCommandResponse({
          success: true,
          output: JSON.stringify({
            devices: {
              'iOS 17.0': [
                { name: 'iPhone 15', udid: 'IOS-1', state: 'Shutdown', isAvailable: true },
              ],
              'tvOS 17.0': [
                { name: 'Apple TV 4K', udid: 'TVOS-1', state: 'Shutdown', isAvailable: true },
              ],
            },
          }),
        });
      }
      if (command[0] === 'xcrun') {
        return createMockCommandResponse({ success: true, output: '' });
      }
      return createMockCommandResponse({
        success: true,
        output: `Information about workspace "App":\n    Schemes:\n        App`,
      });
    };

    await runSetupWizard({
      cwd,
      fs,
      executor,
      prompter: createPlatformPrompter(['tvOS']),
      quietOutput: true,
    });

    const parsed = parseYaml(storedConfig) as {
      sessionDefaults?: Record<string, unknown>;
    };

    expect(
      (parsed as { setupPreferences?: { platforms?: string[] } }).setupPreferences?.platforms,
    ).toEqual(['tvOS']);
    expect(parsed.sessionDefaults?.platform).toBeUndefined();
    expect(parsed.sessionDefaults?.simulatorId).toBe('TVOS-1');
    expect(parsed.sessionDefaults?.simulatorName).toBe('Apple TV 4K');
  });

  it('persists platform=watchOS Simulator and a watchOS-runtime simulator for watchOS-only YAML setup', async () => {
    let storedConfig = '';

    const fs = createMockFileSystemExecutor({
      existsSync: (targetPath) => targetPath === configPath && storedConfig.length > 0,
      stat: async () => ({ isDirectory: () => true, mtimeMs: 0 }),
      readdir: async (targetPath) => {
        if (targetPath === cwd) {
          return [
            {
              name: 'App.xcworkspace',
              isDirectory: () => true,
              isSymbolicLink: () => false,
            },
          ];
        }
        return [];
      },
      readFile: async (targetPath) => {
        if (targetPath !== configPath) throw new Error(`Unexpected read path: ${targetPath}`);
        return storedConfig;
      },
      writeFile: async (targetPath, content) => {
        if (targetPath !== configPath) throw new Error(`Unexpected write path: ${targetPath}`);
        storedConfig = content;
      },
    });

    const executor: CommandExecutor = async (command) => {
      if (command.includes('--json')) {
        return createMockCommandResponse({
          success: true,
          output: JSON.stringify({
            devices: {
              'iOS 17.0': [
                { name: 'iPhone 15', udid: 'IOS-1', state: 'Shutdown', isAvailable: true },
              ],
              'watchOS 10.0': [
                {
                  name: 'Apple Watch Series 9',
                  udid: 'WATCH-1',
                  state: 'Shutdown',
                  isAvailable: true,
                },
              ],
            },
          }),
        });
      }
      if (command[0] === 'xcrun') {
        return createMockCommandResponse({ success: true, output: '' });
      }
      return createMockCommandResponse({
        success: true,
        output: `Information about workspace "App":\n    Schemes:\n        App`,
      });
    };

    await runSetupWizard({
      cwd,
      fs,
      executor,
      prompter: createPlatformPrompter(['watchOS']),
      quietOutput: true,
    });

    const parsed = parseYaml(storedConfig) as {
      sessionDefaults?: Record<string, unknown>;
    };

    expect(
      (parsed as { setupPreferences?: { platforms?: string[] } }).setupPreferences?.platforms,
    ).toEqual(['watchOS']);
    expect(parsed.sessionDefaults?.platform).toBeUndefined();
    expect(parsed.sessionDefaults?.simulatorId).toBe('WATCH-1');
    expect(parsed.sessionDefaults?.simulatorName).toBe('Apple Watch Series 9');
  });

  it('persists platform=visionOS Simulator and an xrOS-runtime simulator for visionOS-only YAML setup', async () => {
    let storedConfig = '';

    const fs = createMockFileSystemExecutor({
      existsSync: (targetPath) => targetPath === configPath && storedConfig.length > 0,
      stat: async () => ({ isDirectory: () => true, mtimeMs: 0 }),
      readdir: async (targetPath) => {
        if (targetPath === cwd) {
          return [
            {
              name: 'App.xcworkspace',
              isDirectory: () => true,
              isSymbolicLink: () => false,
            },
          ];
        }
        return [];
      },
      readFile: async (targetPath) => {
        if (targetPath !== configPath) throw new Error(`Unexpected read path: ${targetPath}`);
        return storedConfig;
      },
      writeFile: async (targetPath, content) => {
        if (targetPath !== configPath) throw new Error(`Unexpected write path: ${targetPath}`);
        storedConfig = content;
      },
    });

    const executor: CommandExecutor = async (command) => {
      if (command.includes('--json')) {
        return createMockCommandResponse({
          success: true,
          output: JSON.stringify({
            devices: {
              'iOS 17.0': [
                { name: 'iPhone 15', udid: 'IOS-1', state: 'Shutdown', isAvailable: true },
              ],
              'xrOS 1.0': [
                { name: 'Apple Vision Pro', udid: 'XROS-1', state: 'Shutdown', isAvailable: true },
              ],
            },
          }),
        });
      }
      if (command[0] === 'xcrun') {
        return createMockCommandResponse({ success: true, output: '' });
      }
      return createMockCommandResponse({
        success: true,
        output: `Information about workspace "App":\n    Schemes:\n        App`,
      });
    };

    await runSetupWizard({
      cwd,
      fs,
      executor,
      prompter: createPlatformPrompter(['visionOS']),
      quietOutput: true,
    });

    const parsed = parseYaml(storedConfig) as {
      sessionDefaults?: Record<string, unknown>;
    };

    expect(
      (parsed as { setupPreferences?: { platforms?: string[] } }).setupPreferences?.platforms,
    ).toEqual(['visionOS']);
    expect(parsed.sessionDefaults?.platform).toBeUndefined();
    expect(parsed.sessionDefaults?.simulatorId).toBe('XROS-1');
    expect(parsed.sessionDefaults?.simulatorName).toBe('Apple Vision Pro');
  });

  it('matches a SimRuntime-style visionOS runtime via the xrOS keyword', async () => {
    let storedConfig = '';

    const fs = createMockFileSystemExecutor({
      existsSync: (targetPath) => targetPath === configPath && storedConfig.length > 0,
      stat: async () => ({ isDirectory: () => true, mtimeMs: 0 }),
      readdir: async (targetPath) => {
        if (targetPath === cwd) {
          return [
            {
              name: 'App.xcworkspace',
              isDirectory: () => true,
              isSymbolicLink: () => false,
            },
          ];
        }
        return [];
      },
      readFile: async (targetPath) => {
        if (targetPath !== configPath) throw new Error(`Unexpected read path: ${targetPath}`);
        return storedConfig;
      },
      writeFile: async (targetPath, content) => {
        if (targetPath !== configPath) throw new Error(`Unexpected write path: ${targetPath}`);
        storedConfig = content;
      },
    });

    const executor: CommandExecutor = async (command) => {
      if (command.includes('--json')) {
        return createMockCommandResponse({
          success: true,
          output: JSON.stringify({
            devices: {
              'com.apple.CoreSimulator.SimRuntime.iOS-17-0': [
                { name: 'iPhone 15', udid: 'IOS-1', state: 'Shutdown', isAvailable: true },
              ],
              'com.apple.CoreSimulator.SimRuntime.xrOS-1-0': [
                { name: 'Apple Vision Pro', udid: 'XROS-1', state: 'Shutdown', isAvailable: true },
              ],
            },
          }),
        });
      }
      if (command[0] === 'xcrun') {
        return createMockCommandResponse({ success: true, output: '' });
      }
      return createMockCommandResponse({
        success: true,
        output: `Information about workspace "App":\n    Schemes:\n        App`,
      });
    };

    await runSetupWizard({
      cwd,
      fs,
      executor,
      prompter: createPlatformPrompter(['visionOS']),
      quietOutput: true,
    });

    const parsed = parseYaml(storedConfig) as {
      sessionDefaults?: Record<string, unknown>;
    };

    expect(parsed.sessionDefaults?.simulatorId).toBe('XROS-1');
  });
});
