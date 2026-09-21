import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandExecutor } from '../command.ts';
import { createMockCommandResponse } from '../../test-utils/mock-executors.ts';
import { DefaultStreamingExecutionContext } from '../execution/index.ts';
import { setXcodeBuildMCPAppDirOverrideForTests } from '../log-paths.ts';
import { setRuntimeInstanceForTests } from '../runtime-instance.ts';
import { createTestExecutor } from '../test-common.ts';
import { resetWorkspaceFilesystemLifecycleStateForTests } from '../workspace-filesystem-lifecycle.ts';
import { XcodePlatform } from '../xcode.ts';

function createRequestedTestProducts(command: readonly string[]): void {
  if (command.at(-1) !== 'build-for-testing') return;
  const testProductsPath = command[command.indexOf('-testProductsPath') + 1];
  if (testProductsPath) {
    mkdirSync(testProductsPath, { recursive: true });
  }
}

describe('prepared test execution', () => {
  let tempAppDir: string;

  beforeEach(() => {
    tempAppDir = mkdtempSync(join(tmpdir(), 'xcodebuildmcp-prepared-test-'));
    setXcodeBuildMCPAppDirOverrideForTests(tempAppDir);
    setRuntimeInstanceForTests({
      instanceId: 'prepared-test',
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

  it('runs prepared test products without source or DerivedData arguments', async () => {
    const commands: string[][] = [];
    const workingDirectories: Array<string | undefined> = [];
    const executor: CommandExecutor = async (command, _logPrefix, _useShell, options) => {
      commands.push(command);
      workingDirectories.push(options?.cwd);
      return createMockCommandResponse({ success: true, output: '', exitCode: 0 });
    };
    const executeTest = createTestExecutor(executor, {
      toolName: 'test_sim',
      target: 'simulator',
      request: {
        platform: XcodePlatform.iOSSimulator,
        simulatorId: 'A2C64636-37E9-4B68-B872-E7F0A82A5670',
      },
    });

    const result = await executeTest(
      {
        testProductsPath: '/tmp/Prepared Tests.xctestproducts',
        simulatorId: 'A2C64636-37E9-4B68-B872-E7F0A82A5670',
        platform: XcodePlatform.iOSSimulator,
        extraArgs: ['-only-testing:WeatherTests/testWeather'],
      },
      new DefaultStreamingExecutionContext(),
    );

    expect(commands).toHaveLength(1);
    expect(commands[0]).toEqual([
      'xcodebuild',
      '-testProductsPath',
      '/tmp/Prepared Tests.xctestproducts',
      '-destination',
      'platform=iOS Simulator,id=A2C64636-37E9-4B68-B872-E7F0A82A5670',
      '-collect-test-diagnostics',
      'never',
      '-only-testing:WeatherTests/testWeather',
      '-resultBundlePath',
      expect.stringContaining('/result-bundles/test_sim_'),
      'test-without-building',
    ]);
    expect(result.artifacts.testProductsPath).toBe('/tmp/Prepared Tests.xctestproducts');
    expect(result.artifacts.xcresultPath).toEqual(expect.stringMatching(/\.xcresult$/u));
    expect(workingDirectories).toEqual([undefined]);
  });

  it('runs an xctestrun artifact directly for a physical device', async () => {
    const commands: string[][] = [];
    const executor: CommandExecutor = async (command) => {
      commands.push(command);
      createRequestedTestProducts(command);
      return createMockCommandResponse({ success: true, output: '', exitCode: 0 });
    };
    const executeTest = createTestExecutor(executor, {
      toolName: 'test_device',
      target: 'device',
      request: { platform: XcodePlatform.iOS, deviceId: 'DEVICE-123' },
    });

    const result = await executeTest(
      {
        xctestrunPath: '/tmp/Weather.xctestrun',
        deviceId: 'DEVICE-123',
        platform: XcodePlatform.iOS,
      },
      new DefaultStreamingExecutionContext(),
    );

    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain('-xctestrun');
    expect(commands[0]).toContain('/tmp/Weather.xctestrun');
    expect(commands[0]).toContain('platform=iOS,id=DEVICE-123');
    expect(commands[0]).not.toContain('-scheme');
    expect(commands[0]).not.toContain('-derivedDataPath');
    expect(commands[0]!.at(-1)).toBe('test-without-building');
    expect(result.artifacts.xctestrunPath).toBe('/tmp/Weather.xctestrun');
  });

  it('does not forward source-only arguments to the prepared test phase', async () => {
    const commands: string[][] = [];
    const executor: CommandExecutor = async (command) => {
      commands.push(command);
      createRequestedTestProducts(command);
      return createMockCommandResponse({ success: true, output: '', exitCode: 0 });
    };
    const executeTest = createTestExecutor(executor, {
      toolName: 'test_macos',
      target: 'macos',
      request: {
        scheme: 'Weather',
        projectPath: 'Weather.xcodeproj',
        platform: XcodePlatform.macOS,
      },
    });

    await executeTest(
      {
        scheme: 'Weather',
        projectPath: 'Weather.xcodeproj',
        platform: XcodePlatform.macOS,
        extraArgs: [
          '-destination',
          'platform=macOS,arch=arm64',
          '-scheme=Injected',
          '-derivedDataPath',
          '/tmp/OtherDerivedData',
          '-quiet',
          '-only-testing:WeatherTests/testWeather',
        ],
      },
      new DefaultStreamingExecutionContext(),
    );

    expect(commands).toHaveLength(2);
    expect(commands[0]).toContain('-destination');
    expect(commands[0]).toContain('-scheme=Injected');
    expect(commands[0]).toContain('-derivedDataPath');
    expect(commands[1]).toContain('platform=macOS,arch=arm64');
    expect(commands[1].filter((argument) => argument === '-destination')).toHaveLength(1);
    expect(commands[1]).not.toContain('-scheme=Injected');
    expect(commands[1]).not.toContain('/tmp/OtherDerivedData');
    expect(commands[1]).toContain('-quiet');
    expect(commands[1]).toContain('-only-testing:WeatherTests/testWeather');
  });
});
