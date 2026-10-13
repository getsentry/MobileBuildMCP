import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockExecutor } from '../../test-utils/mock-executors.ts';
import { runToolLogic } from '../../test-utils/test-helpers.ts';
import { buildMacOSLogic, createBuildMacOSExecutor } from '../../mcp/tools/macos/build_macos.ts';
import {
  buildDeviceLogic,
  createBuildDeviceExecutor,
} from '../../mcp/tools/device/build_device.ts';
import { build_simLogic, createBuildSimExecutor } from '../../mcp/tools/simulator/build_sim.ts';
import type { CommandExecutor } from '../command.ts';
import { DefaultStreamingExecutionContext } from '../execution/index.ts';
import { setMobileBuildMCPAppDirOverrideForTests } from '../log-paths.ts';
import { setRuntimeInstanceForTests } from '../runtime-instance.ts';
import { resetWorkspaceFilesystemLifecycleStateForTests } from '../workspace-filesystem-lifecycle.ts';
import { getTestProductsCompletionMarkerPath } from '../test-products-path.ts';
import * as testProductsPaths from '../test-products-path.ts';

vi.mock('../infer-platform.ts', () => ({
  inferPlatform: vi.fn(async () => ({ platform: 'iOS Simulator' })),
}));

const params = {
  projectPath: '/tmp/Weather/Weather.xcodeproj',
  scheme: 'Weather',
  buildForTesting: true,
};
const simulatorParams = { ...params, simulatorId: 'SIMULATOR-123' };
const deviceParams = { ...params, platform: 'iOS' as const, deviceId: 'DEVICE-123' };
const entryPoints: Array<{ name: string; run(executor: CommandExecutor): Promise<unknown> }> = [
  {
    name: 'macOS executor',
    run: (executor) =>
      createBuildMacOSExecutor(executor)(params, new DefaultStreamingExecutionContext()),
  },
  {
    name: 'macOS handler logic',
    run: (executor) => runToolLogic(() => buildMacOSLogic(params, executor)),
  },
  {
    name: 'device executor',
    run: (executor) =>
      createBuildDeviceExecutor(executor)(deviceParams, new DefaultStreamingExecutionContext()),
  },
  {
    name: 'device handler logic',
    run: (executor) => runToolLogic(() => buildDeviceLogic(deviceParams, executor)),
  },
  {
    name: 'simulator executor',
    run: (executor) =>
      createBuildSimExecutor(executor)(simulatorParams, new DefaultStreamingExecutionContext()),
  },
  {
    name: 'simulator handler logic',
    run: (executor) => runToolLogic(() => build_simLogic(simulatorParams, executor)),
  },
];

describe('managed build-for-testing products', () => {
  let tempAppDir: string;

  beforeEach(() => {
    tempAppDir = mkdtempSync(join(tmpdir(), 'mobilebuildmcp-managed-build-'));
    setMobileBuildMCPAppDirOverrideForTests(tempAppDir);
    setRuntimeInstanceForTests({
      instanceId: 'managed-build',
      pid: process.pid,
      workspaceKey: 'workspace-a',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetWorkspaceFilesystemLifecycleStateForTests();
    setMobileBuildMCPAppDirOverrideForTests(null);
    setRuntimeInstanceForTests(null);
    rmSync(tempAppDir, { recursive: true, force: true });
  });

  it.each(entryPoints)(
    'retains completed products after metadata errors: $name',
    async ({ run }) => {
      let outputPath = '';
      const metadataError = new Error('Unable to read test products metadata');
      vi.spyOn(testProductsPaths, 'findXctestrunPaths').mockRejectedValue(metadataError);
      const executor = createMockExecutor({
        success: true,
        output: 'BUILD SUCCEEDED',
        onExecute: (command) => {
          if (command.at(-1) !== 'build-for-testing') return;
          outputPath = command[command.indexOf('-testProductsPath') + 1] ?? '';
          mkdirSync(outputPath, { recursive: true });
        },
      });

      await expect(run(executor)).rejects.toBe(metadataError);

      expect(outputPath).not.toBe('');
      expect(existsSync(outputPath)).toBe(true);
      expect(existsSync(getTestProductsCompletionMarkerPath(outputPath))).toBe(true);
    },
  );
});
