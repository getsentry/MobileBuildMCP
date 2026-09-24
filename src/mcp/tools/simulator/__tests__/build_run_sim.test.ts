import { describe, it, expect, beforeEach } from 'vitest';
import { computeScopedDerivedDataPath } from '../../../../utils/derived-data-path.ts';
import * as z from 'zod';
import {
  createMockExecutor,
  createMockCommandResponse,
  mockProcess,
} from '../../../../test-utils/mock-executors.ts';
import {
  runToolLogic,
  type MockToolHandlerResult,
  callHandler,
} from '../../../../test-utils/test-helpers.ts';
import type { CommandExecutor } from '../../../../utils/execution/index.ts';
import { sessionStore } from '../../../../utils/session-store.ts';
import { schema, handler, build_run_simLogic, type SimulatorLauncher } from '../build_run_sim.ts';
import type { LaunchWithLoggingResult } from '../../../../utils/simulator-steps.ts';

const mockLauncher: SimulatorLauncher = async (
  _uuid,
  _bundleId,
  _executor,
  _opts?,
): Promise<LaunchWithLoggingResult> => ({
  success: true,
  processId: 99999,
  logFilePath: '/tmp/mock-logs/test.log',
});

const runBuildRunSimLogic = (
  params: Parameters<typeof build_run_simLogic>[0],
  executor: Parameters<typeof build_run_simLogic>[1],
  launcher?: Parameters<typeof build_run_simLogic>[2],
) => runToolLogic(() => build_run_simLogic(params, executor, launcher));

function expectPendingBuildRunResponse(result: MockToolHandlerResult, isError: boolean): void {
  expect(result.isError()).toBe(isError);
  expect(result.text()).not.toBe('');
}

describe('build_run_sim tool', () => {
  beforeEach(() => {
    sessionStore.clear();
  });

  describe('Export Field Validation (Literal)', () => {
    it('should have handler function', () => {
      expect(typeof handler).toBe('function');
    });

    it('should expose optional session defaults for explicit overrides', () => {
      const schemaObj = z.strictObject(schema);

      expect(schemaObj.safeParse({}).success).toBe(true);

      expect(
        schemaObj.safeParse({
          extraArgs: ['--verbose'],
        }).success,
      ).toBe(true);
      expect(
        schemaObj.safeParse({
          launchArgs: ['--uitesting'],
        }).success,
      ).toBe(true);

      expect(
        schemaObj.safeParse({
          workspacePath: '/path/to/workspace.xcworkspace',
          scheme: 'ExplicitScheme',
          simulatorName: 'iPhone 17',
          configuration: 'Release',
          derivedDataPath: '/path/to/derived',
          preferXcodebuild: false,
        }).success,
      ).toBe(true);
      expect(schemaObj.safeParse({ extraArgs: [123] }).success).toBe(false);
      expect(schemaObj.safeParse({ launchArgs: [123] }).success).toBe(false);
      expect(schemaObj.safeParse({ preferXcodebuild: 'false' }).success).toBe(false);

      const schemaKeys = Object.keys(schema).sort();
      expect(schemaKeys).toEqual(
        [
          'configuration',
          'derivedDataPath',
          'extraArgs',
          'launchArgs',
          'preferXcodebuild',
          'projectPath',
          'scheme',
          'simulatorId',
          'simulatorName',
          'useLatestOS',
          'workspacePath',
        ].sort(),
      );
    });
  });

  describe('Handler Behavior (Pending Pipeline Contract)', () => {
    it('should fail fast for an invalid explicit simulator ID with structured sad-path output', async () => {
      const callHistory: string[][] = [];
      const mockExecutor: CommandExecutor = async (command) => {
        callHistory.push(command);

        if (command[0] === 'xcrun' && command[1] === 'simctl') {
          return createMockCommandResponse({
            success: true,
            output: JSON.stringify({
              devices: {
                'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
                  { udid: 'SOME-OTHER-UUID', name: 'iPhone 17', isAvailable: true },
                ],
              },
            }),
          });
        }

        return createMockCommandResponse({
          success: false,
          error: 'xcodebuild should not run',
        });
      };

      const { result } = await runBuildRunSimLogic(
        {
          workspacePath: '/path/to/workspace',
          scheme: 'MyScheme',
          simulatorId: 'INVALID-SIM-ID-123',
        },
        mockExecutor,
      );

      expectPendingBuildRunResponse(result, true);
      expect(
        callHistory.some((command) => command[0] === 'xcodebuild' && command.includes('build')),
      ).toBe(false);
    });

    it('should handle build settings failure as pending error', async () => {
      let callCount = 0;
      const mockExecutor: CommandExecutor = async (command) => {
        callCount++;
        if (callCount === 1) {
          return createMockCommandResponse({
            success: true,
            output: JSON.stringify({
              devices: {
                'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
                  { udid: 'SIM-UUID', name: 'iPhone 17', isAvailable: true },
                ],
              },
            }),
          });
        } else if (callCount === 2) {
          return createMockCommandResponse({
            success: true,
            output: 'BUILD SUCCEEDED',
          });
        } else if (callCount === 3) {
          return createMockCommandResponse({
            success: false,
            error: 'Could not get build settings',
          });
        }
        return createMockCommandResponse({
          success: false,
          error: 'Unexpected call',
        });
      };

      const { result } = await runBuildRunSimLogic(
        {
          workspacePath: '/path/to/workspace',
          scheme: 'MyScheme',
          simulatorName: 'iPhone 17',
        },
        mockExecutor,
      );

      expectPendingBuildRunResponse(result, true);
      expect(result.nextStepParams).toBeUndefined();
    });

    it('should handle build failure as pending error', async () => {
      const mockExecutor = createMockExecutor({
        success: false,
        error: 'Build failed with error',
      });

      const { result } = await runBuildRunSimLogic(
        {
          workspacePath: '/path/to/workspace',
          scheme: 'MyScheme',
          simulatorName: 'iPhone 17',
        },
        mockExecutor,
      );

      expectPendingBuildRunResponse(result, true);
      expect(result.nextStepParams).toBeUndefined();
    });

    it('should handle successful build and run', async () => {
      const mockExecutor: CommandExecutor = async (command) => {
        if (command.includes('xcodebuild') && command.includes('build')) {
          return createMockCommandResponse({
            success: true,
            output: 'BUILD SUCCEEDED',
          });
        } else if (command.includes('xcodebuild') && command.includes('-showBuildSettings')) {
          return createMockCommandResponse({
            success: true,
            output: 'BUILT_PRODUCTS_DIR = /path/to/build\nFULL_PRODUCT_NAME = MyApp.app\n',
          });
        } else if (command.includes('simctl') && command.includes('list')) {
          return createMockCommandResponse({
            success: true,
            output: JSON.stringify({
              devices: {
                'iOS 16.0': [
                  {
                    udid: 'test-uuid-123',
                    name: 'iPhone 17',
                    state: 'Booted',
                    isAvailable: true,
                  },
                  '-derivedDataPath',
                  computeScopedDerivedDataPath('/path/to/workspace'),
                ],
              },
            }),
          });
        } else if (
          command.some(
            (c) => c.includes('plutil') || c.includes('PlistBuddy') || c.includes('defaults'),
          )
        ) {
          return createMockCommandResponse({
            success: true,
            output: 'io.sentry.MyApp',
          });
        } else {
          return createMockCommandResponse({
            success: true,
            output: 'Success',
          });
        }
      };

      const { result } = await runBuildRunSimLogic(
        {
          workspacePath: '/path/to/workspace',
          scheme: 'MyScheme',
          simulatorName: 'iPhone 17',
        },
        mockExecutor,
        mockLauncher,
      );

      expectPendingBuildRunResponse(result, false);
      const text = result.text();
      expect(text).toContain('Build & Run complete');
      expect(text).toContain('/path/to/build/MyApp.app');
      expect(text).toContain('io.sentry.MyApp');
      expect(text).toContain('99999');
      expect(text).toContain('build_run_sim_');
    });

    it('should handle install failure as pending error', async () => {
      let callCount = 0;
      const mockExecutor: CommandExecutor = async (command) => {
        callCount++;

        if (command.includes('xcodebuild') && command.includes('build')) {
          return createMockCommandResponse({
            success: true,
            output: 'BUILD SUCCEEDED',
          });
        } else if (command.includes('xcodebuild') && command.includes('-showBuildSettings')) {
          return createMockCommandResponse({
            success: true,
            output: 'BUILT_PRODUCTS_DIR = /path/to/build\nFULL_PRODUCT_NAME = MyApp.app\n',
          });
        } else if (command.includes('simctl') && command.includes('list')) {
          return createMockCommandResponse({
            success: true,
            output: JSON.stringify({
              devices: {
                'iOS 16.0': [
                  {
                    udid: 'test-uuid-123',
                    name: 'iPhone 17',
                    state: 'Booted',
                    isAvailable: true,
                  },
                  '-derivedDataPath',
                  computeScopedDerivedDataPath('/path/to/workspace'),
                ],
              },
            }),
          });
        } else if (command.includes('simctl') && command.includes('install')) {
          return createMockCommandResponse({
            success: false,
            error: 'Failed to install',
          });
        } else {
          return createMockCommandResponse({
            success: true,
            output: 'Success',
          });
        }
      };

      const { result } = await runBuildRunSimLogic(
        {
          workspacePath: '/path/to/workspace',
          scheme: 'MyScheme',
          simulatorName: 'iPhone 17',
        },
        mockExecutor,
      );

      expectPendingBuildRunResponse(result, true);
      expect(result.nextStepParams).toBeUndefined();
    });

    it('should handle spawn error as text fallback', async () => {
      const mockExecutor = (
        command: string[],
        description?: string,
        logOutput?: boolean,
        opts?: { cwd?: string },
        detached?: boolean,
      ) => {
        void command;
        void description;
        void logOutput;
        void opts;
        void detached;
        return Promise.reject(new Error('spawn xcodebuild ENOENT'));
      };

      const { response, result } = await runBuildRunSimLogic(
        {
          workspacePath: '/path/to/workspace',
          scheme: 'MyScheme',
          simulatorName: 'iPhone 17',
        },
        mockExecutor,
      );

      expect(response).toBeUndefined();
      expect(result.isError()).toBe(true);
      const text = result.text();
      expect(text).toContain('Error during simulator build and run');
    });

    it('sets structured output error when executor rejects after preparation', async () => {
      let callCount = 0;
      const mockExecutor: CommandExecutor = async (command) => {
        callCount++;

        if (callCount === 1 && command[0] === 'xcrun' && command[1] === 'simctl') {
          return createMockCommandResponse({
            success: true,
            output: JSON.stringify({
              devices: {
                'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
                  { udid: 'SIM-UUID', name: 'iPhone 17', isAvailable: true },
                ],
              },
            }),
          });
        }

        return Promise.reject(new Error('executor rejected after preparation'));
      };

      const { response, result } = await runBuildRunSimLogic(
        {
          workspacePath: '/path/to/workspace',
          scheme: 'MyScheme',
          simulatorName: 'iPhone 17',
        },
        mockExecutor,
      );

      expect(response).toBeUndefined();
      expect(result.isError()).toBe(true);
      expect(result.nextStepParams).toBeUndefined();
    });
  });

  describe('Command Generation', () => {
    const SIMCTL_LIST_COMMAND = ['xcrun', 'simctl', 'list', 'devices', 'available', '--json'];

    function createTrackingExecutor(callHistory: Array<{ command: string[]; logPrefix?: string }>) {
      return async (command: string[], logPrefix?: string) => {
        callHistory.push({ command, logPrefix });
        return createMockCommandResponse({
          success: false,
          output: '',
          error: 'Test error to stop execution early',
        });
      };
    }

    it('should generate correct simctl list command with minimal parameters', async () => {
      const callHistory: Array<{ command: string[]; logPrefix?: string }> = [];

      await runBuildRunSimLogic(
        {
          workspacePath: '/path/to/MyProject.xcworkspace',
          scheme: 'MyScheme',
          simulatorName: 'iPhone 17',
        },
        createTrackingExecutor(callHistory),
      );

      expect(callHistory).toHaveLength(2);
      expect(callHistory[0].command).toEqual(SIMCTL_LIST_COMMAND);
      expect(callHistory[1].command).toEqual([
        'xcodebuild',
        '-workspace',
        '/path/to/MyProject.xcworkspace',
        '-scheme',
        'MyScheme',
        '-skipMacroValidation',
        '-destination',
        'platform=iOS Simulator,name=iPhone 17,OS=latest',
        '-collect-test-diagnostics',
        'never',
        '-derivedDataPath',
        computeScopedDerivedDataPath('/path/to/MyProject.xcworkspace'),
        'build',
      ]);
      expect(callHistory[1].logPrefix).toBe('iOS Simulator Build');
    });

    it('should generate correct build command after finding simulator', async () => {
      const callHistory: Array<{ command: string[]; logPrefix?: string }> = [];

      let callCount = 0;
      const trackingExecutor: CommandExecutor = async (command, logPrefix) => {
        callHistory.push({ command, logPrefix });
        callCount++;

        if (callCount === 1) {
          return createMockCommandResponse({
            success: true,
            output: JSON.stringify({
              devices: {
                'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
                  { udid: 'test-uuid-123', name: 'iPhone 17', isAvailable: true },
                ],
              },
            }),
          });
        }

        return createMockCommandResponse({
          success: false,
          output: '',
          error: 'Test error to stop execution',
        });
      };

      await runBuildRunSimLogic(
        {
          workspacePath: '/path/to/MyProject.xcworkspace',
          scheme: 'MyScheme',
          simulatorName: 'iPhone 17',
        },
        trackingExecutor,
      );

      expect(callHistory).toHaveLength(2);
      expect(callHistory[0].command).toEqual(SIMCTL_LIST_COMMAND);
      expect(callHistory[1].command).toEqual([
        'xcodebuild',
        '-workspace',
        '/path/to/MyProject.xcworkspace',
        '-scheme',
        'MyScheme',
        '-skipMacroValidation',
        '-destination',
        'platform=iOS Simulator,name=iPhone 17,OS=latest',
        '-collect-test-diagnostics',
        'never',
        '-derivedDataPath',
        computeScopedDerivedDataPath('/path/to/MyProject.xcworkspace'),
        'build',
      ]);
      expect(callHistory[1].logPrefix).toBe('iOS Simulator Build');
    });

    it('should pass launchArgs only to launcher and keep extraArgs on xcodebuild commands', async () => {
      const callHistory: Array<{ command: string[]; logPrefix?: string }> = [];
      let launchArgs: string[] | undefined;

      const trackingLauncher: SimulatorLauncher = async (_uuid, _bundleId, _executor, opts) => {
        launchArgs = opts?.args;
        return {
          success: true,
          processId: 11111,
          logFilePath: '/tmp/mock-logs/test.log',
        };
      };

      const trackingExecutor: CommandExecutor = async (command, logPrefix) => {
        callHistory.push({ command, logPrefix });

        if (command[0] === 'xcrun' && command[1] === 'simctl' && command[2] === 'list') {
          return createMockCommandResponse({
            success: true,
            output: JSON.stringify({
              devices: {
                'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
                  { udid: 'test-uuid-123', name: 'iPhone 17', isAvailable: true, state: 'Booted' },
                ],
              },
            }),
          });
        }
        if (command[0] === 'xcodebuild' && command.includes('build')) {
          return createMockCommandResponse({
            success: true,
            output: 'BUILD SUCCEEDED',
          });
        }
        if (command[0] === 'xcodebuild' && command.includes('-showBuildSettings')) {
          return createMockCommandResponse({
            success: true,
            output: 'BUILT_PRODUCTS_DIR = /path/to/build\nFULL_PRODUCT_NAME = MyApp.app\n',
          });
        }
        if (
          command.some(
            (c) => c.includes('plutil') || c.includes('PlistBuddy') || c.includes('defaults'),
          )
        ) {
          return createMockCommandResponse({
            success: true,
            output: 'io.sentry.MyApp',
          });
        }

        return createMockCommandResponse({
          success: true,
          output: 'Success',
        });
      };

      const { result } = await runBuildRunSimLogic(
        {
          workspacePath: '/path/to/MyProject.xcworkspace',
          scheme: 'MyScheme',
          simulatorName: 'iPhone 17',
          extraArgs: ['-quiet'],
          launchArgs: ['--uitesting', '--reset-state'],
        },
        trackingExecutor,
        trackingLauncher,
      );

      expectPendingBuildRunResponse(result, false);
      expect(launchArgs).toEqual(['--uitesting', '--reset-state']);

      const xcodebuildCommands = callHistory
        .map(({ command }) => command)
        .filter((command) => command[0] === 'xcodebuild');
      expect(xcodebuildCommands.length).toBeGreaterThan(0);
      for (const command of xcodebuildCommands) {
        expect(command).toContain('-quiet');
        expect(command).not.toContain('--uitesting');
        expect(command).not.toContain('--reset-state');
      }
    });

    it('should generate correct build settings command after successful build', async () => {
      const callHistory: Array<{ command: string[]; logPrefix?: string }> = [];

      let callCount = 0;
      const trackingExecutor: CommandExecutor = async (command, logPrefix) => {
        callHistory.push({ command, logPrefix });
        callCount++;

        if (callCount === 1) {
          return createMockCommandResponse({
            success: true,
            output: JSON.stringify({
              devices: {
                'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
                  { udid: 'test-uuid-123', name: 'iPhone 17', isAvailable: true },
                ],
              },
            }),
          });
        }
        if (callCount === 2) {
          return createMockCommandResponse({
            success: true,
            output: 'BUILD SUCCEEDED',
          });
        }

        return createMockCommandResponse({
          success: false,
          output: '',
          error: 'Test error to stop execution',
        });
      };

      await runBuildRunSimLogic(
        {
          workspacePath: '/path/to/MyProject.xcworkspace',
          scheme: 'MyScheme',
          simulatorName: 'iPhone 17',
          configuration: 'Release',
          useLatestOS: false,
        },
        trackingExecutor,
      );

      expect(callHistory).toHaveLength(3);
      expect(callHistory[0].command).toEqual(SIMCTL_LIST_COMMAND);
      expect(callHistory[1].command).toEqual([
        'xcodebuild',
        '-workspace',
        '/path/to/MyProject.xcworkspace',
        '-scheme',
        'MyScheme',
        '-configuration',
        'Release',
        '-skipMacroValidation',
        '-destination',
        'platform=iOS Simulator,name=iPhone 17',
        '-collect-test-diagnostics',
        'never',
        '-derivedDataPath',
        computeScopedDerivedDataPath('/path/to/MyProject.xcworkspace'),
        'build',
      ]);
      expect(callHistory[1].logPrefix).toBe('iOS Simulator Build');
      expect(callHistory[2].command).toEqual([
        'xcodebuild',
        '-showBuildSettings',
        '-workspace',
        '/path/to/MyProject.xcworkspace',
        '-scheme',
        'MyScheme',
        '-configuration',
        'Release',
        '-destination',
        'platform=iOS Simulator,name=iPhone 17',
        '-derivedDataPath',
        computeScopedDerivedDataPath('/path/to/MyProject.xcworkspace'),
      ]);
      expect(callHistory[2].logPrefix).toBe('Get App Path');
    });

    it('should handle paths with spaces in command generation', async () => {
      const callHistory: Array<{ command: string[]; logPrefix?: string }> = [];

      await runBuildRunSimLogic(
        {
          workspacePath: '/Users/dev/My Project/MyProject.xcworkspace',
          scheme: 'My Scheme',
          simulatorName: 'iPhone 17 Pro',
        },
        createTrackingExecutor(callHistory),
      );

      expect(callHistory).toHaveLength(2);
      expect(callHistory[0].command).toEqual(SIMCTL_LIST_COMMAND);
      expect(callHistory[1].command).toEqual([
        'xcodebuild',
        '-workspace',
        '/Users/dev/My Project/MyProject.xcworkspace',
        '-scheme',
        'My Scheme',
        '-skipMacroValidation',
        '-destination',
        'platform=iOS Simulator,name=iPhone 17 Pro,OS=latest',
        '-collect-test-diagnostics',
        'never',
        '-derivedDataPath',
        computeScopedDerivedDataPath('/Users/dev/My Project/MyProject.xcworkspace'),
        'build',
      ]);
      expect(callHistory[1].logPrefix).toBe('iOS Simulator Build');
    });

    it('should infer tvOS platform from simulator name for build command', async () => {
      const callHistory: Array<{ command: string[]; logPrefix?: string }> = [];

      await runBuildRunSimLogic(
        {
          workspacePath: '/path/to/MyProject.xcworkspace',
          scheme: 'MyTVScheme',
          simulatorName: 'Apple TV 4K',
        },
        createTrackingExecutor(callHistory),
      );

      expect(callHistory).toHaveLength(2);
      expect(callHistory[0].command).toEqual(SIMCTL_LIST_COMMAND);
      expect(callHistory[1].command).toEqual([
        'xcodebuild',
        '-workspace',
        '/path/to/MyProject.xcworkspace',
        '-scheme',
        'MyTVScheme',
        '-skipMacroValidation',
        '-destination',
        'platform=tvOS Simulator,name=Apple TV 4K,OS=latest',
        '-collect-test-diagnostics',
        'never',
        '-derivedDataPath',
        computeScopedDerivedDataPath('/path/to/MyProject.xcworkspace'),
        'build',
      ]);
      expect(callHistory[1].logPrefix).toBe('tvOS Simulator Build');
    });
  });

  describe('XOR Validation', () => {
    it('should error when neither projectPath nor workspacePath provided', async () => {
      const result = await callHandler(handler, {
        scheme: 'MyScheme',
        simulatorName: 'iPhone 17',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Missing required session defaults');
      expect(result.content[0].text).toContain('Provide a project or workspace');
    });

    it('should error when both projectPath and workspacePath provided', async () => {
      const result = await callHandler(handler, {
        projectPath: '/path/project.xcodeproj',
        workspacePath: '/path/workspace.xcworkspace',
        scheme: 'MyScheme',
        simulatorName: 'iPhone 17',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Parameter validation failed');
      expect(result.content[0].text).toContain('Mutually exclusive parameters provided');
      expect(result.content[0].text).toContain('projectPath');
      expect(result.content[0].text).toContain('workspacePath');
    });

    it('should succeed with only projectPath', async () => {
      const mockExecutor = createMockExecutor({
        success: false,
        error: 'Build failed',
      });

      const { result } = await runBuildRunSimLogic(
        {
          projectPath: '/path/project.xcodeproj',
          scheme: 'MyScheme',
          simulatorName: 'iPhone 17',
        },
        mockExecutor,
      );
      expectPendingBuildRunResponse(result, true);
    });

    it('should succeed with only workspacePath', async () => {
      const mockExecutor = createMockExecutor({
        success: false,
        error: 'Build failed',
      });

      const { result } = await runBuildRunSimLogic(
        {
          workspacePath: '/path/workspace.xcworkspace',
          scheme: 'MyScheme',
          simulatorName: 'iPhone 17',
        },
        mockExecutor,
      );
      expectPendingBuildRunResponse(result, true);
    });
  });
});
