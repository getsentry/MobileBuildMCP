import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestExecutor, resolveTestProgressEnabled } from '../test-common.ts';
import type { CommandExecutor, CommandResponse } from '../command.ts';
import { DefaultStreamingExecutionContext } from '../execution/index.ts';
import type { AnyFragment } from '../../types/domain-fragments.ts';
import type { TestPreflightResult } from '../test-preflight.ts';
import { XcodePlatform } from '../xcode.ts';
import {
  getWorkspaceFilesystemLayout,
  setXcodeBuildMCPAppDirOverrideForTests,
} from '../log-paths.ts';
import { setRuntimeInstanceForTests } from '../runtime-instance.ts';
import { resetWorkspaceFilesystemLifecycleStateForTests } from '../workspace-filesystem-lifecycle.ts';
import { getTestProductsCompletionMarkerPath } from '../test-products-path.ts';
import { extractTestFailuresFromXcresult } from '../xcresult-test-failures.ts';

vi.mock('../xcresult-test-failures.ts', () => ({
  extractTestFailuresFromXcresult: vi.fn(() => []),
  extractTestSummaryCountsFromXcresult: vi.fn(() => null),
}));

function createSuccessfulCommandResponse(): CommandResponse {
  return {
    success: true,
    output: '',
    process: { pid: 12345 } as ChildProcess,
    exitCode: 0,
  };
}

function createPreflight(): TestPreflightResult {
  return {
    scheme: 'Weather',
    configuration: 'Debug',
    projectPath: 'Weather.xcodeproj',
    destinationName: 'iPhone 17 Pro',
    selectors: {
      onlyTesting: [],
      skipTesting: [],
    },
    targets: [
      {
        name: 'WeatherTests',
        files: [
          {
            path: 'WeatherTests/WeatherTests.swift',
            tests: [
              {
                framework: 'swift-testing',
                targetName: 'WeatherTests',
                typeName: 'WeatherTests',
                methodName: 'emptySearchReturnsNoResults',
                displayName: 'WeatherTests/WeatherTests/emptySearchReturnsNoResults',
                line: 12,
                parameterized: false,
              },
            ],
          },
        ],
        warnings: [],
      },
    ],
    warnings: [],
    totalTests: 1,
    completeness: 'complete',
  };
}

describe('resolveTestProgressEnabled', () => {
  const originalRuntime = process.env.XCODEBUILDMCP_RUNTIME;

  afterEach(() => {
    vi.restoreAllMocks();

    if (originalRuntime === undefined) {
      delete process.env.XCODEBUILDMCP_RUNTIME;
    } else {
      process.env.XCODEBUILDMCP_RUNTIME = originalRuntime;
    }
  });

  it('defaults to true in MCP runtime when progress is not provided', () => {
    process.env.XCODEBUILDMCP_RUNTIME = 'mcp';
    expect(resolveTestProgressEnabled(undefined)).toBe(true);
  });

  it('defaults to false in CLI runtime when progress is not provided', () => {
    process.env.XCODEBUILDMCP_RUNTIME = 'cli';
    expect(resolveTestProgressEnabled(undefined)).toBe(false);
  });

  it('defaults to false when runtime is unknown', () => {
    process.env.XCODEBUILDMCP_RUNTIME = 'unknown';
    expect(resolveTestProgressEnabled(undefined)).toBe(false);
  });

  it('honors explicit true override regardless of runtime', () => {
    process.env.XCODEBUILDMCP_RUNTIME = 'cli';
    expect(resolveTestProgressEnabled(true)).toBe(true);
  });

  it('honors explicit false override regardless of runtime', () => {
    process.env.XCODEBUILDMCP_RUNTIME = 'mcp';
    expect(resolveTestProgressEnabled(false)).toBe(false);
  });
});

describe('createTestExecutor', () => {
  let tempAppDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tempAppDir = mkdtempSync(join(tmpdir(), 'xcodebuildmcp-result-bundles-'));
    setXcodeBuildMCPAppDirOverrideForTests(tempAppDir);
    setRuntimeInstanceForTests({
      instanceId: 'result-bundle-test',
      pid: process.pid,
      workspaceKey: 'workspace-a',
    });
  });

  afterEach(() => {
    resetWorkspaceFilesystemLifecycleStateForTests();
    setXcodeBuildMCPAppDirOverrideForTests(null);
    setRuntimeInstanceForTests(null);
    rmSync(tempAppDir, { recursive: true, force: true });
  });

  function expectDefaultResultBundlePath(command: readonly string[], toolName: string): string {
    const resultBundleArgIndex = command.indexOf('-resultBundlePath');
    expect(resultBundleArgIndex).toBeGreaterThan(-1);
    const resultBundlePath = command[resultBundleArgIndex + 1];
    expect(resultBundlePath).toEqual(
      expect.stringContaining(getWorkspaceFilesystemLayout('workspace-a').resultBundles),
    );
    expect(resultBundlePath).toEqual(expect.stringContaining(`${toolName}_`));
    expect(resultBundlePath).toEqual(expect.stringMatching(/\.xcresult$/u));
    return resultBundlePath!;
  }

  it('emits RUN_TESTS before test-without-building starts in two-phase simulator execution', async () => {
    const emitted: AnyFragment[] = [];
    const actions: string[] = [];
    const executor: CommandExecutor = async (command, _logPrefix, _useShell, opts) => {
      const action = command.at(-1);
      if (action) {
        actions.push(action);
      }

      if (action === 'build-for-testing') {
        opts?.onStdout?.('Ld /tmp/Weather.build/Weather normal arm64\n');
      }

      return createSuccessfulCommandResponse();
    };

    const executeTest = createTestExecutor(executor, {
      preflight: createPreflight(),
      toolName: 'test_sim',
      target: 'simulator',
      request: {
        scheme: 'Weather',
        projectPath: 'Weather.xcodeproj',
        configuration: 'Debug',
        platform: XcodePlatform.iOSSimulator,
      },
    });

    await executeTest(
      {
        projectPath: 'Weather.xcodeproj',
        scheme: 'Weather',
        configuration: 'Debug',
        simulatorId: 'A2C64636-37E9-4B68-B872-E7F0A82A5670',
        platform: XcodePlatform.iOSSimulator,
        extraArgs: ['-testProductsPath', '/tmp/caller.xctestproducts'],
      },
      new DefaultStreamingExecutionContext({
        onFragment: (fragment) => emitted.push(fragment),
      }),
    );

    expect(actions).toEqual(['build-for-testing', 'test-without-building']);

    const stageEvents = emitted.filter((event) => event.fragment === 'build-stage');
    expect(stageEvents.map((event) => event.stage)).toEqual(['LINKING', 'RUN_TESTS']);

    const runTestsIndex = emitted.findIndex(
      (event) => event.fragment === 'build-stage' && event.stage === 'RUN_TESTS',
    );
    const finalSummaryIndex = emitted.findIndex((event) => event.fragment === 'build-summary');

    expect(runTestsIndex).toBeGreaterThan(-1);
    expect(finalSummaryIndex).toBeGreaterThan(runTestsIndex);
  });
  it('uses the source test phase for prepared products containing multiple simulator platforms', async () => {
    const commands: string[][] = [];
    const executor: CommandExecutor = async (command) => {
      commands.push(command);
      if (command.at(-1) === 'build-for-testing') {
        const testProductsIndex = command.indexOf('-testProductsPath');
        const testProductsPath = command[testProductsIndex + 1]!;
        mkdirSync(join(testProductsPath, 'Tests', '0'), { recursive: true });
        writeFileSync(
          join(testProductsPath, 'Tests', '0', 'Weather.xctestrun'),
          `<?xml version="1.0"?><plist><dict><key>TestConfigurations</key><array><dict><key>TestTargets</key><array><dict><key>DependentProductPaths</key><array><string>__TESTROOT__/Debug-iphonesimulator/Weather.app</string><string>__TESTROOT__/Debug-watchsimulator/WatchTests.xctest</string></array></dict></array></dict></array></dict></plist>`,
        );
      }
      return createSuccessfulCommandResponse();
    };

    const executeTest = createTestExecutor(executor, {
      preflight: createPreflight(),
      toolName: 'test_sim',
      target: 'simulator',
      request: {
        scheme: 'Weather',
        projectPath: 'Weather.xcodeproj',
        configuration: 'Debug',
        platform: XcodePlatform.iOSSimulator,
      },
    });

    await executeTest(
      {
        projectPath: 'Weather.xcodeproj',
        scheme: 'Weather',
        configuration: 'Debug',
        simulatorId: 'A2C64636-37E9-4B68-B872-E7F0A82A5670',
        platform: XcodePlatform.iOSSimulator,
      },
      new DefaultStreamingExecutionContext(),
    );

    expect(commands).toHaveLength(2);
    expect(commands[1]).toContain('-project');
    expect(commands[1]).toContain('-scheme');
    expect(commands[1]).toContain('-derivedDataPath');
    expect(commands[1]).not.toContain('-testProductsPath');
  });

  it('injects a workspace-scoped default result bundle path for macOS test commands', async () => {
    const commands: string[][] = [];
    const executor: CommandExecutor = async (command) => {
      commands.push(command);
      return createSuccessfulCommandResponse();
    };

    const executeTest = createTestExecutor(executor, {
      toolName: 'test_macos',
      target: 'macos',
      request: {
        scheme: 'Weather',
        projectPath: 'Weather.xcodeproj',
        configuration: 'Debug',
        platform: XcodePlatform.macOS,
      },
    });

    const result = await executeTest(
      {
        projectPath: 'Weather.xcodeproj',
        scheme: 'Weather',
        configuration: 'Debug',
        platform: XcodePlatform.macOS,
      },
      new DefaultStreamingExecutionContext(),
    );

    expect(commands).toHaveLength(2);
    expect(commands[0]!.at(-1)).toBe('build-for-testing');
    expect(commands[0]).toContain('-testProductsPath');
    const resultBundlePath = expectDefaultResultBundlePath(commands[1]!, 'test_macos');
    expect(commands[1]!.at(-1)).toBe('test-without-building');
    expect(commands[1]).not.toContain('-project');
    expect(commands[1]).not.toContain('-scheme');
    expect(commands[1]).not.toContain('-derivedDataPath');
    expect(extractTestFailuresFromXcresult).toHaveBeenCalledWith(resultBundlePath);
    expect(result.artifacts.xcresultPath).toBe(resultBundlePath);
    expect(result.artifacts.testProductsPath).toEqual(
      expect.stringContaining(getWorkspaceFilesystemLayout('workspace-a').testProducts),
    );
  });

  it('propagates default result bundle setup failures as runtime errors', async () => {
    const layout = getWorkspaceFilesystemLayout('workspace-a');
    mkdirSync(layout.root, { recursive: true });
    writeFileSync(layout.resultBundles, 'not a directory');
    const executor = vi.fn<CommandExecutor>();

    const executeTest = createTestExecutor(executor, {
      toolName: 'test_macos',
      target: 'macos',
      request: {
        scheme: 'Weather',
        projectPath: 'Weather.xcodeproj',
        configuration: 'Debug',
        platform: XcodePlatform.macOS,
      },
    });

    await expect(
      executeTest(
        {
          projectPath: 'Weather.xcodeproj',
          scheme: 'Weather',
          configuration: 'Debug',
          platform: XcodePlatform.macOS,
        },
        new DefaultStreamingExecutionContext(),
      ),
    ).rejects.toThrow('Unable to create writable result bundle directory');

    expect(executor).not.toHaveBeenCalled();
  });

  it('injects a workspace-scoped default result bundle path for device test commands', async () => {
    const commands: string[][] = [];
    const executor: CommandExecutor = async (command) => {
      commands.push(command);
      return createSuccessfulCommandResponse();
    };

    const executeTest = createTestExecutor(executor, {
      toolName: 'test_device',
      target: 'device',
      request: {
        scheme: 'Weather',
        projectPath: 'Weather.xcodeproj',
        configuration: 'Debug',
        platform: XcodePlatform.iOS,
        deviceId: 'DEVICE-123',
      },
    });

    const result = await executeTest(
      {
        projectPath: 'Weather.xcodeproj',
        scheme: 'Weather',
        configuration: 'Debug',
        platform: XcodePlatform.iOS,
        deviceId: 'DEVICE-123',
      },
      new DefaultStreamingExecutionContext(),
    );

    expect(commands).toHaveLength(2);
    expect(commands[0]!.at(-1)).toBe('build-for-testing');
    const resultBundlePath = expectDefaultResultBundlePath(commands[1]!, 'test_device');
    expect(commands[1]!.at(-1)).toBe('test-without-building');
    expect(result.artifacts.xcresultPath).toBe(resultBundlePath);
  });

  it('does not surface a result bundle when simulator build-for-testing fails before tests run', async () => {
    const commands: string[][] = [];
    let testProductsPath: string | undefined;
    const executor: CommandExecutor = async (command, _logPrefix, _useShell, opts) => {
      commands.push(command);
      const testProductsIndex = command.indexOf('-testProductsPath');
      testProductsPath = command[testProductsIndex + 1];
      mkdirSync(testProductsPath!);
      opts?.onStderr?.(
        'Writing error result bundle to /var/folders/test/ResultBundle_2026-05-07_09-38-0016.xcresult\n',
      );
      return {
        success: false,
        output: '',
        process: { pid: 12345 } as ChildProcess,
        exitCode: 65,
      };
    };

    const executeTest = createTestExecutor(executor, {
      preflight: createPreflight(),
      toolName: 'test_sim',
      target: 'simulator',
      request: {
        scheme: 'Weather',
        projectPath: 'Weather.xcodeproj',
        configuration: 'Debug',
        platform: XcodePlatform.iOSSimulator,
      },
    });

    const result = await executeTest(
      {
        projectPath: 'Weather.xcodeproj',
        scheme: 'Weather',
        configuration: 'Debug',
        simulatorId: 'A2C64636-37E9-4B68-B872-E7F0A82A5670',
        platform: XcodePlatform.iOSSimulator,
      },
      new DefaultStreamingExecutionContext(),
    );

    expect(commands).toHaveLength(1);
    expect(commands[0]).not.toContain('-resultBundlePath');
    expect(result.artifacts.xcresultPath).toBeUndefined();
    expect(existsSync(getTestProductsCompletionMarkerPath(testProductsPath!))).toBe(true);
  });

  it('injects the default result bundle only into the simulator test execution phase', async () => {
    const commands: string[][] = [];
    const executor: CommandExecutor = async (command) => {
      commands.push(command);
      return createSuccessfulCommandResponse();
    };

    const executeTest = createTestExecutor(executor, {
      preflight: createPreflight(),
      toolName: 'test_sim',
      target: 'simulator',
      request: {
        scheme: 'Weather',
        projectPath: 'Weather.xcodeproj',
        configuration: 'Debug',
        platform: XcodePlatform.iOSSimulator,
      },
    });

    const result = await executeTest(
      {
        projectPath: 'Weather.xcodeproj',
        scheme: 'Weather',
        configuration: 'Debug',
        simulatorId: 'A2C64636-37E9-4B68-B872-E7F0A82A5670',
        platform: XcodePlatform.iOSSimulator,
      },
      new DefaultStreamingExecutionContext(),
    );

    expect(commands).toHaveLength(2);
    expect(commands[0]).not.toContain('-resultBundlePath');
    expect(commands[0]).toContain('-testProductsPath');
    expect(commands[0]).not.toContain('/tmp/caller.xctestproducts');
    expect(commands[0]!.at(-1)).toBe('build-for-testing');
    const testResultBundlePath = expectDefaultResultBundlePath(commands[1]!, 'test_sim');
    expect(commands[1]!.at(-1)).toBe('test-without-building');
    expect(commands[1]).toContain('-testProductsPath');
    expect(commands[1]).not.toContain('/tmp/caller.xctestproducts');
    expect(commands[1]).not.toContain('-project');
    expect(commands[1]).not.toContain('-scheme');
    expect(commands[1]).not.toContain('-derivedDataPath');
    expect(result.artifacts.xcresultPath).toBe(testResultBundlePath);
  });

  it('preserves a user-supplied result bundle path instead of injecting a default', async () => {
    const commands: string[][] = [];
    const executor: CommandExecutor = async (command) => {
      commands.push(command);
      return createSuccessfulCommandResponse();
    };

    const executeTest = createTestExecutor(executor, {
      toolName: 'test_macos',
      target: 'macos',
      request: {
        scheme: 'Weather',
        projectPath: 'Weather.xcodeproj',
        configuration: 'Debug',
        platform: XcodePlatform.macOS,
      },
    });

    const result = await executeTest(
      {
        projectPath: 'Weather.xcodeproj',
        scheme: 'Weather',
        configuration: 'Debug',
        platform: XcodePlatform.macOS,
        extraArgs: ['-quiet', '-resultBundlePath=/tmp/User Provided.xcresult'],
      },
      new DefaultStreamingExecutionContext(),
    );

    expect(commands).toHaveLength(2);
    expect(commands[1]).toContain('-quiet');
    expect(commands[1]).toContain('-resultBundlePath');
    expect(commands[1]).toContain('/tmp/User Provided.xcresult');
    expect(commands[1].filter((argument) => argument === '-resultBundlePath')).toHaveLength(1);
    expect(
      commands[1].filter((argument) => argument === '/tmp/User Provided.xcresult'),
    ).toHaveLength(1);
    expect(commands[0]).not.toContain('/tmp/User Provided.xcresult');
    expect(commands[1]).not.toContain(getWorkspaceFilesystemLayout('workspace-a').resultBundles);
    expect(result.artifacts.xcresultPath).toBe('/tmp/User Provided.xcresult');
  });

  it('keeps managed test products active until a failed test run settles', async () => {
    let testProductsPath: string | undefined;
    const executor: CommandExecutor = async (command) => {
      if (command.at(-1) === 'build-for-testing') {
        const testProductsIndex = command.indexOf('-testProductsPath');
        testProductsPath = command[testProductsIndex + 1];
        mkdirSync(testProductsPath!);
        return createSuccessfulCommandResponse();
      }

      expect(existsSync(getTestProductsCompletionMarkerPath(testProductsPath!))).toBe(false);
      return {
        ...createSuccessfulCommandResponse(),
        success: false,
        error: 'Tests failed',
        exitCode: 65,
      };
    };
    const executeTest = createTestExecutor(executor, {
      toolName: 'test_macos',
      target: 'macos',
      request: {
        scheme: 'Weather',
        projectPath: '/tmp/Weather/Weather.xcodeproj',
        platform: XcodePlatform.macOS,
      },
    });

    const result = await executeTest(
      {
        projectPath: '/tmp/Weather/Weather.xcodeproj',
        scheme: 'Weather',
        platform: XcodePlatform.macOS,
      },
      new DefaultStreamingExecutionContext(),
    );

    expect(result.didError).toBe(true);
    expect(existsSync(getTestProductsCompletionMarkerPath(testProductsPath!))).toBe(true);
  });
});
