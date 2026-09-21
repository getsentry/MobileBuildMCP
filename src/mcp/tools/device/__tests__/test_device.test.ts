import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync } from 'node:fs';
import * as z from 'zod';
import { computeScopedDerivedDataPath } from '../../../../utils/derived-data-path.ts';
import {
  createMockExecutor,
  createMockFileSystemExecutor,
} from '../../../../test-utils/mock-executors.ts';
import {
  expectPendingBuildResponse,
  runToolLogic,
  callHandler,
} from '../../../../test-utils/test-helpers.ts';
import { schema, handler, testDeviceLogic } from '../test_device.ts';
import { sessionStore } from '../../../../utils/session-store.ts';

const mockFs = () =>
  createMockFileSystemExecutor({
    mkdtemp: async () => '/tmp/test-123',
    rm: async () => {},
    tmpdir: () => '/tmp',
    stat: async () => ({ isDirectory: () => false, mtimeMs: 0 }),
  });

const runTestDeviceLogic = (
  params: Parameters<typeof testDeviceLogic>[0],
  executor: Parameters<typeof testDeviceLogic>[1],
  fileSystemExecutor: Parameters<typeof testDeviceLogic>[2],
) => runToolLogic(() => testDeviceLogic(params, executor, fileSystemExecutor));

function createRequestedTestProducts(command: readonly string[]): void {
  if (command.at(-1) !== 'build-for-testing') return;
  const testProductsPath = command[command.indexOf('-testProductsPath') + 1];
  if (testProductsPath) {
    mkdirSync(testProductsPath, { recursive: true });
  }
}

function createSuccessfulTestExecutor(output: string): ReturnType<typeof createMockExecutor> {
  return createMockExecutor({
    success: true,
    output,
    onExecute: createRequestedTestProducts,
  });
}

function createSpyExecutor(): {
  commandCalls: Array<{ args: string[]; logPrefix?: string }>;
  executor: ReturnType<typeof createMockExecutor>;
} {
  const commandCalls: Array<{ args: string[]; logPrefix?: string }> = [];
  const executor = createMockExecutor({
    success: true,
    output: 'Test Succeeded',
    onExecute: (command, logPrefix) => {
      createRequestedTestProducts(command);
      commandCalls.push({ args: command, logPrefix });
    },
  });
  return { commandCalls, executor };
}

describe('test_device plugin', () => {
  beforeEach(() => {
    sessionStore.clear();
  });

  describe('Export Field Validation (Literal)', () => {
    it('should have handler function', () => {
      expect(typeof handler).toBe('function');
    });

    it('should expose only session-free fields in public schema', () => {
      const schemaObj = z.strictObject(schema);
      expect(
        schemaObj.safeParse({
          extraArgs: ['--arg1'],
          testRunnerEnv: { FOO: 'bar' },
        }).success,
      ).toBe(true);
      expect(schemaObj.safeParse({}).success).toBe(true);
      expect(schemaObj.safeParse({ derivedDataPath: '/path/to/derived-data' }).success).toBe(false);
      expect(schemaObj.safeParse({ preferXcodebuild: true }).success).toBe(false);
      expect(schemaObj.safeParse({ platform: 'iOS' }).success).toBe(true);
      expect(schemaObj.safeParse({ platform: 'tvOS Simulator' }).success).toBe(true);
      expect(schemaObj.safeParse({ platform: 'macOS' }).success).toBe(false);
      expect(schemaObj.safeParse({ projectPath: '/path/to/project.xcodeproj' }).success).toBe(
        false,
      );

      const schemaKeys = Object.keys(schema).sort();
      expect(schemaKeys).toEqual([
        'extraArgs',
        'platform',
        'progress',
        'testProductsPath',
        'testRunnerEnv',
        'xctestrunPath',
      ]);
    });

    it('should validate XOR between projectPath and workspacePath', async () => {
      const mockExecutor = createSuccessfulTestExecutor('Test Succeeded');

      const { result: projectResult } = await runTestDeviceLogic(
        {
          projectPath: '/path/to/project.xcodeproj',
          scheme: 'MyScheme',
          deviceId: 'test-device-123',
        },
        mockExecutor,
        mockFs(),
      );
      expectPendingBuildResponse(projectResult);
      expect(projectResult.isError()).toBeFalsy();

      const { result: workspaceResult } = await runTestDeviceLogic(
        {
          workspacePath: '/path/to/workspace.xcworkspace',
          scheme: 'MyScheme',
          deviceId: 'test-device-123',
        },
        mockExecutor,
        mockFs(),
      );
      expectPendingBuildResponse(workspaceResult);
      expect(workspaceResult.isError()).toBeFalsy();
    });
  });

  describe('Handler Requirements', () => {
    it('should require scheme and device defaults', async () => {
      const result = await callHandler(handler, {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Missing required session defaults');
      expect(result.content[0].text).toContain('Provide deviceId');
    });

    it('should require project or workspace when defaults provide scheme and device', async () => {
      sessionStore.setDefaults({ scheme: 'MyScheme', deviceId: 'test-device-123' });

      const result = await callHandler(handler, {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Either projectPath or workspacePath is required');
    });

    it('should reject mutually exclusive project inputs when defaults satisfy requirements', async () => {
      sessionStore.setDefaults({ scheme: 'MyScheme', deviceId: 'test-device-123' });

      const result = await callHandler(handler, {
        projectPath: '/path/to/project.xcodeproj',
        workspacePath: '/path/to/workspace.xcworkspace',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Parameter validation failed');
      expect(result.content[0].text).toContain('Mutually exclusive parameters provided');
    });
  });

  describe('Command generation', () => {
    it('adds -collect-test-diagnostics never to device test commands', async () => {
      const spy = createSpyExecutor();

      await runTestDeviceLogic(
        {
          projectPath: '/path/to/project.xcodeproj',
          scheme: 'MyScheme',
          deviceId: 'test-device-123',
          configuration: 'Debug',
          preferXcodebuild: false,
          platform: 'iOS',
        },
        spy.executor,
        mockFs(),
      );

      expect(spy.commandCalls).toHaveLength(2);
      expect(spy.commandCalls[0].args).toEqual([
        'xcodebuild',
        '-project',
        '/path/to/project.xcodeproj',
        '-scheme',
        'MyScheme',
        '-configuration',
        'Debug',
        '-skipMacroValidation',
        '-destination',
        'platform=iOS,id=test-device-123',
        '-collect-test-diagnostics',
        'never',
        '-derivedDataPath',
        computeScopedDerivedDataPath('/path/to/project.xcodeproj'),
        '-testProductsPath',
        expect.stringContaining('/test-products/test_device_'),
        'build-for-testing',
      ]);
      expect(spy.commandCalls[1].args).toEqual([
        'xcodebuild',
        '-testProductsPath',
        expect.stringContaining('/test-products/test_device_'),
        '-destination',
        'platform=iOS,id=test-device-123',
        '-collect-test-diagnostics',
        'never',
        '-resultBundlePath',
        expect.stringContaining('/result-bundles/test_device_'),
        'test-without-building',
      ]);
    });
  });

  describe('Handler Behavior (Complete Literal Returns)', () => {
    it('should return pending response for successful tests', async () => {
      const mockExecutor = createSuccessfulTestExecutor('Test Succeeded');

      const { result } = await runTestDeviceLogic(
        {
          projectPath: '/path/to/project.xcodeproj',
          scheme: 'MyScheme',
          deviceId: 'test-device-123',
          configuration: 'Debug',
          preferXcodebuild: false,
          platform: 'iOS',
        },
        mockExecutor,
        mockFs(),
      );

      expectPendingBuildResponse(result);
      expect(result.isError()).toBeFalsy();
    });

    it('should return pending response for test failures', async () => {
      const mockExecutor = createMockExecutor({
        success: false,
        output: '',
        error: 'error: Test failed',
      });

      const { result } = await runTestDeviceLogic(
        {
          projectPath: '/path/to/project.xcodeproj',
          scheme: 'MyScheme',
          deviceId: 'test-device-123',
          configuration: 'Debug',
          preferXcodebuild: false,
          platform: 'iOS',
        },
        mockExecutor,
        mockFs(),
      );

      expectPendingBuildResponse(result);
      expect(result.isError()).toBe(true);
    });

    it('should handle build failure with pending response', async () => {
      const mockExecutor = createMockExecutor({
        success: false,
        output: '',
        error: 'error: missing argument for parameter in call',
      });

      const { result } = await runTestDeviceLogic(
        {
          projectPath: '/path/to/project.xcodeproj',
          scheme: 'MyScheme',
          deviceId: 'test-device-123',
          configuration: 'Debug',
          preferXcodebuild: false,
          platform: 'iOS',
        },
        mockExecutor,
        mockFs(),
      );

      expectPendingBuildResponse(result);
      expect(result.isError()).toBe(true);
    });

    it('should support different platforms', async () => {
      const mockExecutor = createSuccessfulTestExecutor('Test Succeeded');

      const { result } = await runTestDeviceLogic(
        {
          projectPath: '/path/to/project.xcodeproj',
          scheme: 'WatchApp',
          deviceId: 'watch-device-456',
          configuration: 'Debug',
          preferXcodebuild: false,
          platform: 'watchOS',
        },
        mockExecutor,
        mockFs(),
      );

      expectPendingBuildResponse(result);
      expect(result.isError()).toBeFalsy();
    });

    it('should handle optional parameters', async () => {
      const mockExecutor = createSuccessfulTestExecutor('Test Succeeded');

      const { result } = await runTestDeviceLogic(
        {
          projectPath: '/path/to/project.xcodeproj',
          scheme: 'MyScheme',
          deviceId: 'test-device-123',
          configuration: 'Release',
          derivedDataPath: '/tmp/derived-data',
          extraArgs: ['--verbose'],
          preferXcodebuild: false,
          platform: 'iOS',
        },
        mockExecutor,
        mockFs(),
      );

      expectPendingBuildResponse(result);
      expect(result.isError()).toBeFalsy();
    });

    it('should expose user-provided result bundle paths in test output', async () => {
      const mockExecutor = createSuccessfulTestExecutor('Test Succeeded');

      const { result } = await runTestDeviceLogic(
        {
          projectPath: '/path/to/project.xcodeproj',
          scheme: 'MyScheme',
          deviceId: 'test-device-123',
          configuration: 'Debug',
          extraArgs: [
            '-resultBundlePath',
            '/tmp/Stale Device Tests.xcresult',
            '-resultBundlePath=/tmp/Device Tests.xcresult',
          ],
          preferXcodebuild: false,
          platform: 'iOS',
        },
        mockExecutor,
        mockFs(),
      );

      expectPendingBuildResponse(result);
      expect(result.text()).toContain('Result Bundle: /tmp/Device Tests.xcresult');
    });

    it('should handle workspace testing successfully', async () => {
      const mockExecutor = createSuccessfulTestExecutor('Test Succeeded');

      const { result } = await runTestDeviceLogic(
        {
          workspacePath: '/path/to/workspace.xcworkspace',
          scheme: 'WorkspaceScheme',
          deviceId: 'test-device-456',
          configuration: 'Debug',
          preferXcodebuild: false,
          platform: 'iOS',
        },
        mockExecutor,
        mockFs(),
      );

      expectPendingBuildResponse(result);
      expect(result.isError()).toBeFalsy();
    });
  });
});
