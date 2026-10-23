import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync } from 'node:fs';
import * as z from 'zod';
import {
  createMockCommandResponse,
  createMockExecutor,
  createMockFileSystemExecutor,
} from '../../../../test-utils/mock-executors.ts';
import {
  expectPendingBuildResponse,
  runToolLogic,
  callHandler,
} from '../../../../test-utils/test-helpers.ts';
import { sessionStore } from '../../../../utils/session-store.ts';
import { schema, handler, testMacosLogic } from '../test_macos.ts';

const mockFs = () =>
  createMockFileSystemExecutor({
    mkdtemp: async () => '/tmp/test-123',
    rm: async () => {},
    tmpdir: () => '/tmp',
    stat: async () => ({ isDirectory: () => false, mtimeMs: 0 }),
  });

const runTestMacosLogic = (
  params: Parameters<typeof testMacosLogic>[0],
  executor: Parameters<typeof testMacosLogic>[1],
  fileSystemExecutor: Parameters<typeof testMacosLogic>[2],
) => runToolLogic(() => testMacosLogic(params, executor, fileSystemExecutor));

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

describe('test_macos plugin (unified)', () => {
  beforeEach(() => {
    sessionStore.clear();
  });

  describe('Export Field Validation (Literal)', () => {
    it('should have handler function', () => {
      expect(typeof handler).toBe('function');
    });

    it('should validate schema correctly', () => {
      const zodSchema = z.strictObject(schema);

      expect(zodSchema.safeParse({}).success).toBe(true);
      expect(
        zodSchema.safeParse({
          extraArgs: ['--arg1', '--arg2'],
          testRunnerEnv: { FOO: 'BAR' },
        }).success,
      ).toBe(true);

      expect(zodSchema.safeParse({ derivedDataPath: '/path/to/derived-data' }).success).toBe(false);
      expect(zodSchema.safeParse({ extraArgs: ['--ok', 1] }).success).toBe(false);
      expect(zodSchema.safeParse({ preferXcodebuild: true }).success).toBe(false);
      expect(zodSchema.safeParse({ testRunnerEnv: { FOO: 123 } }).success).toBe(false);

      const schemaKeys = Object.keys(schema).sort();
      expect(schemaKeys).toEqual(
        ['extraArgs', 'progress', 'testProductsPath', 'testRunnerEnv', 'xctestrunPath'].sort(),
      );
    });
  });

  describe('Handler Requirements', () => {
    it('should require scheme before running', async () => {
      const result = await callHandler(handler, {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('scheme is required');
    });

    it('should require project or workspace when scheme default exists', async () => {
      sessionStore.setDefaults({ scheme: 'MyScheme' });

      const result = await callHandler(handler, {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Either projectPath or workspacePath is required');
    });

    it('should reject when both projectPath and workspacePath provided explicitly', async () => {
      sessionStore.setDefaults({ scheme: 'MyScheme' });

      const result = await callHandler(handler, {
        projectPath: '/path/to/project.xcodeproj',
        workspacePath: '/path/to/workspace.xcworkspace',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Mutually exclusive parameters provided');
    });
  });

  describe('XOR Parameter Validation', () => {
    it('should validate that either projectPath or workspacePath is provided', async () => {
      const result = await callHandler(handler, {
        scheme: 'MyScheme',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Either projectPath or workspacePath is required');
    });

    it('should validate that both projectPath and workspacePath cannot be provided', async () => {
      const result = await callHandler(handler, {
        projectPath: '/path/to/project.xcodeproj',
        workspacePath: '/path/to/workspace.xcworkspace',
        scheme: 'MyScheme',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Mutually exclusive parameters provided');
    });

    it('should allow only projectPath', async () => {
      const mockExecutor = createSuccessfulTestExecutor('Test Suite All Tests passed');

      const { result } = await runTestMacosLogic(
        {
          projectPath: '/path/to/project.xcodeproj',
          scheme: 'MyScheme',
        },
        mockExecutor,
        mockFs(),
      );

      expectPendingBuildResponse(result);
      expect(result.isError()).toBeFalsy();
    });

    it('should allow only workspacePath', async () => {
      const mockExecutor = createSuccessfulTestExecutor('Test Suite All Tests passed');

      const { result } = await runTestMacosLogic(
        {
          workspacePath: '/path/to/workspace.xcworkspace',
          scheme: 'MyScheme',
        },
        mockExecutor,
        mockFs(),
      );

      expectPendingBuildResponse(result);
      expect(result.isError()).toBeFalsy();
    });
  });

  describe('Handler Behavior (Complete Literal Returns)', () => {
    it('should return pending response with workspace when xcodebuild succeeds', async () => {
      const mockExecutor = createSuccessfulTestExecutor('Test Suite All Tests passed');

      const { result } = await runTestMacosLogic(
        {
          workspacePath: '/path/to/workspace.xcworkspace',
          scheme: 'MyScheme',
          configuration: 'Debug',
        },
        mockExecutor,
        mockFs(),
      );

      expectPendingBuildResponse(result);
      expect(result.isError()).toBeFalsy();
    });

    it('should return pending response with project when xcodebuild succeeds', async () => {
      const mockExecutor = createSuccessfulTestExecutor('Test Suite All Tests passed');

      const { result } = await runTestMacosLogic(
        {
          projectPath: '/path/to/project.xcodeproj',
          scheme: 'MyScheme',
          configuration: 'Debug',
        },
        mockExecutor,
        mockFs(),
      );

      expectPendingBuildResponse(result);
      expect(result.isError()).toBeFalsy();
    });

    it('should use default configuration when not provided', async () => {
      const mockExecutor = createSuccessfulTestExecutor('Test Suite All Tests passed');

      const { result } = await runTestMacosLogic(
        {
          workspacePath: '/path/to/workspace.xcworkspace',
          scheme: 'MyScheme',
        },
        mockExecutor,
        mockFs(),
      );

      expectPendingBuildResponse(result);
      expect(result.isError()).toBeFalsy();
    });

    it('should handle optional parameters correctly', async () => {
      const mockExecutor = createSuccessfulTestExecutor('Test Suite All Tests passed');

      const { result } = await runTestMacosLogic(
        {
          workspacePath: '/path/to/workspace.xcworkspace',
          scheme: 'MyScheme',
          configuration: 'Release',
          derivedDataPath: '/custom/derived',
          extraArgs: ['--verbose'],
          preferXcodebuild: true,
        },
        mockExecutor,
        mockFs(),
      );

      expectPendingBuildResponse(result);
      expect(result.isError()).toBeFalsy();
    });

    it('should handle successful test execution with minimal parameters', async () => {
      const mockExecutor = createSuccessfulTestExecutor('Test Suite All Tests passed');

      const { result } = await runTestMacosLogic(
        {
          workspacePath: '/path/to/MyProject.xcworkspace',
          scheme: 'MyApp',
        },
        mockExecutor,
        mockFs(),
      );

      expectPendingBuildResponse(result);
      expect(result.isError()).toBeFalsy();
    });

    it('should return pending response on successful test', async () => {
      const commandCalls: { command: string[]; logPrefix?: string; cwd?: string }[] = [];

      const mockExecutor = async (
        command: string[],
        logPrefix?: string,
        _useShell?: boolean,
        opts?: { env?: Record<string, string>; cwd?: string },
        _detached?: boolean,
      ) => {
        commandCalls.push({ command, logPrefix, cwd: opts?.cwd });
        createRequestedTestProducts(command);
        return createMockCommandResponse({
          success: true,
          output: 'Test Succeeded',
          error: undefined,
          exitCode: 0,
        });
      };

      const { result } = await runTestMacosLogic(
        {
          workspacePath: '/path/to/MyProject.xcworkspace',
          scheme: 'MyScheme',
        },
        mockExecutor,
        mockFs(),
      );

      expect(commandCalls).toHaveLength(2);
      expect(commandCalls[0].command).toContain('xcodebuild');
      expect(commandCalls[0].command).toContain('-workspace');
      expect(commandCalls[0].command).toContain('/path/to/MyProject.xcworkspace');
      expect(commandCalls[0].command).toContain('-scheme');
      expect(commandCalls[0].command).toContain('MyScheme');
      expect(commandCalls[0].command).toContain('build-for-testing');
      expect(commandCalls[0].logPrefix).toBe('Test Run');
      expect(commandCalls[1].command).toContain('-testProductsPath');
      expect(commandCalls[1].command).not.toContain('-workspace');
      expect(commandCalls[1].command).not.toContain('-scheme');
      expect(commandCalls[1].command).toContain('test-without-building');
      expect(commandCalls.map((call) => call.cwd)).toEqual(['/path/to', '/path/to']);

      expectPendingBuildResponse(result);
      expect(result.isError()).toBeFalsy();
    });

    it('should return pending response on test failure', async () => {
      let callCount = 0;
      const mockExecutor = async (
        _command: string[],
        _logPrefix?: string,
        _useShell?: boolean,
        _opts?: { env?: Record<string, string> },
        _detached?: boolean,
      ) => {
        callCount++;
        return createMockCommandResponse({
          success: false,
          output: '',
          error: 'error: Test failed',
          exitCode: 65,
        });
      };

      const { result } = await runTestMacosLogic(
        {
          workspacePath: '/path/to/MyProject.xcworkspace',
          scheme: 'MyScheme',
        },
        mockExecutor,
        mockFs(),
      );

      expect(callCount).toBe(1);
      expectPendingBuildResponse(result);
      expect(result.isError()).toBe(true);
    });

    it('should return pending response with optional parameters', async () => {
      const mockExecutor = async (
        command: string[],
        _logPrefix?: string,
        _useShell?: boolean,
        _opts?: { env?: Record<string, string> },
        _detached?: boolean,
      ) => {
        createRequestedTestProducts(command);
        return createMockCommandResponse({
          success: true,
          output: 'Test Succeeded',
          error: undefined,
          exitCode: 0,
        });
      };

      const { result } = await runTestMacosLogic(
        {
          workspacePath: '/path/to/MyProject.xcworkspace',
          scheme: 'MyScheme',
          configuration: 'Release',
          derivedDataPath: '/path/to/derived-data',
          extraArgs: ['--verbose'],
          preferXcodebuild: true,
        },
        mockExecutor,
        mockFs(),
      );

      expectPendingBuildResponse(result);
      expect(result.isError()).toBeFalsy();
    });

    it('should handle build failure with pending response', async () => {
      const mockExecutor = async (
        _command: string[],
        _logPrefix?: string,
        _useShell?: boolean,
        _opts?: { env?: Record<string, string> },
        _detached?: boolean,
      ) =>
        createMockCommandResponse({
          success: false,
          output: '',
          error: 'error: missing argument for parameter in call',
          exitCode: 65,
        });

      const { result } = await runTestMacosLogic(
        {
          workspacePath: '/path/to/MyProject.xcworkspace',
          scheme: 'MyScheme',
        },
        mockExecutor,
        mockFs(),
      );

      expectPendingBuildResponse(result);
      expect(result.isError()).toBe(true);
    });

    it('should propagate executor exceptions as runtime errors', async () => {
      const mockExecutor = createMockExecutor({
        success: false,
        error: '',
        shouldThrow: new Error('Network error'),
      });

      await expect(
        runTestMacosLogic(
          {
            workspacePath: '/path/to/MyProject.xcworkspace',
            scheme: 'MyScheme',
          },
          mockExecutor,
          mockFs(),
        ),
      ).rejects.toThrow('Network error');
    });
  });
});
