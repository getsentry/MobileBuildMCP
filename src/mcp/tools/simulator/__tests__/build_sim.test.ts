import { describe, it, expect, beforeEach } from 'vitest';
import { computeScopedDerivedDataPath } from '../../../../utils/derived-data-path.ts';
import * as z from 'zod';
import {
  createMockExecutor,
  createMockCommandResponse,
} from '../../../../test-utils/mock-executors.ts';
import {
  expectPendingBuildResponse,
  runToolLogic,
  callHandler,
} from '../../../../test-utils/test-helpers.ts';
import { sessionStore } from '../../../../utils/session-store.ts';

import { schema, handler, build_simLogic, buildSimulatorSchema } from '../build_sim.ts';

const runBuildSimLogic = (
  params: Parameters<typeof build_simLogic>[0],
  executor: Parameters<typeof build_simLogic>[1],
) => runToolLogic(() => build_simLogic(params, executor));

describe('build_sim tool', () => {
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
          projectPath: '/path/to/project.xcodeproj',
          scheme: 'ExplicitScheme',
          simulatorName: 'iPhone 17',
          configuration: 'Release',
          derivedDataPath: '/path/to/derived',
          preferXcodebuild: false,
        }).success,
      ).toBe(true);
      expect(schemaObj.safeParse({ extraArgs: [123] }).success).toBe(false);
      expect(schemaObj.safeParse({ preferXcodebuild: 'false' }).success).toBe(false);
      expect(
        schemaObj.safeParse({
          buildForTesting: true,
          testProductsPath: '/tmp/MyApp.xctestproducts',
        }).success,
      ).toBe(true);

      expect(Object.keys(schema).sort()).toEqual(
        [
          'buildForTesting',
          'configuration',
          'derivedDataPath',
          'extraArgs',
          'preferXcodebuild',
          'projectPath',
          'scheme',
          'simulatorId',
          'simulatorName',
          'testProductsPath',
          'useLatestOS',
          'workspacePath',
        ].sort(),
      );
    });

    it('should reject testProductsPath without buildForTesting', () => {
      const result = buildSimulatorSchema.safeParse({
        projectPath: '/path/to/MyProject.xcodeproj',
        scheme: 'MyScheme',
        simulatorName: 'iPhone 17',
        testProductsPath: '/tmp/MyApp.xctestproducts',
      });

      expect(result.success).toBe(false);
    });
  });

  describe('Parameter Validation', () => {
    it('should handle missing both projectPath and workspacePath', async () => {
      const result = await callHandler(handler, {
        scheme: 'MyScheme',
        simulatorName: 'iPhone 17',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Missing required session defaults');
      expect(result.content[0].text).toContain('Provide a project or workspace');
    });

    it('should handle both projectPath and workspacePath provided', async () => {
      const result = await callHandler(handler, {
        projectPath: '/path/to/project.xcodeproj',
        workspacePath: '/path/to/workspace',
        scheme: 'MyScheme',
        simulatorName: 'iPhone 17',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Parameter validation failed');
      expect(result.content[0].text).toContain('Mutually exclusive parameters provided');
      expect(result.content[0].text).toContain('projectPath');
      expect(result.content[0].text).toContain('workspacePath');
    });

    it('should handle empty workspacePath parameter', async () => {
      const mockExecutor = createMockExecutor({ success: true, output: 'BUILD SUCCEEDED' });

      const { result } = await runBuildSimLogic(
        {
          workspacePath: '',
          scheme: 'MyScheme',
          simulatorName: 'iPhone 17',
        },
        mockExecutor,
      );

      expectPendingBuildResponse(result, 'get_sim_app_path');
    });

    it('should handle missing scheme parameter', async () => {
      const result = await callHandler(handler, {
        workspacePath: '/path/to/workspace',
        simulatorName: 'iPhone 17',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Missing required session defaults');
      expect(result.content[0].text).toContain('scheme is required');
    });

    it('should handle empty scheme parameter', async () => {
      const mockExecutor = createMockExecutor({ success: true, output: 'BUILD SUCCEEDED' });

      const { result } = await runBuildSimLogic(
        {
          workspacePath: '/path/to/workspace',
          scheme: '',
          simulatorName: 'iPhone 17',
        },
        mockExecutor,
      );

      expectPendingBuildResponse(result, 'get_sim_app_path');
    });

    it('should handle missing both simulatorId and simulatorName', async () => {
      const result = await callHandler(handler, {
        workspacePath: '/path/to/workspace',
        scheme: 'MyScheme',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Missing required session defaults');
      expect(result.content[0].text).toContain('Provide simulatorId or simulatorName');
    });

    it('should handle both simulatorId and simulatorName provided', async () => {
      const mockExecutor = createMockExecutor({ success: true, output: 'Build succeeded' });

      const result = await callHandler(handler, {
        workspacePath: '/path/to/workspace',
        scheme: 'MyScheme',
        simulatorId: 'ABC-123',
        simulatorName: 'iPhone 17',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Parameter validation failed');
      expect(result.content[0].text).toContain('Mutually exclusive parameters provided');
      expect(result.content[0].text).toContain('simulatorId');
      expect(result.content[0].text).toContain('simulatorName');
    });

    it('should error when no resolvable simulator is provided (empty simulatorName)', async () => {
      const mockExecutor = createMockExecutor({
        success: false,
        output: '',
        error: 'For iOS Simulator platform, either simulatorId or simulatorName must be provided',
      });

      await expect(
        runBuildSimLogic(
          {
            workspacePath: '/path/to/workspace',
            scheme: 'MyScheme',
            simulatorName: '',
          },
          mockExecutor,
        ),
      ).rejects.toThrow(/Unable to determine the simulator platform/);
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

    function expectRuntimeLookupThenBuild(
      callHistory: Array<{ command: string[]; logPrefix?: string }>,
      expectedBuildCommand: string[],
      expectedLogPrefix: string,
    ) {
      expect(callHistory).toHaveLength(2);
      expect(callHistory[0].command).toEqual(SIMCTL_LIST_COMMAND);
      expect(callHistory[1].command).toEqual(expectedBuildCommand);
      expect(callHistory[1].logPrefix).toBe(expectedLogPrefix);
    }

    it('should generate correct build command with minimal parameters (workspace)', async () => {
      const callHistory: Array<{ command: string[]; logPrefix?: string }> = [];

      await runBuildSimLogic(
        {
          workspacePath: '/path/to/MyProject.xcworkspace',
          scheme: 'MyScheme',
          simulatorName: 'iPhone 17',
        },
        createTrackingExecutor(callHistory),
      );

      expectRuntimeLookupThenBuild(
        callHistory,
        [
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
        ],
        'iOS Simulator Build',
      );
    });

    it('should generate correct build command with minimal parameters (project)', async () => {
      const callHistory: Array<{ command: string[]; logPrefix?: string }> = [];

      await runBuildSimLogic(
        {
          projectPath: '/path/to/MyProject.xcodeproj',
          scheme: 'MyScheme',
          simulatorName: 'iPhone 17',
        },
        createTrackingExecutor(callHistory),
      );

      expectRuntimeLookupThenBuild(
        callHistory,
        [
          'xcodebuild',
          '-project',
          '/path/to/MyProject.xcodeproj',
          '-scheme',
          'MyScheme',
          '-skipMacroValidation',
          '-destination',
          'platform=iOS Simulator,name=iPhone 17,OS=latest',
          '-collect-test-diagnostics',
          'never',
          '-derivedDataPath',
          computeScopedDerivedDataPath('/path/to/MyProject.xcodeproj'),
          'build',
        ],
        'iOS Simulator Build',
      );
    });

    it('should generate correct build command with all optional parameters', async () => {
      const callHistory: Array<{ command: string[]; logPrefix?: string }> = [];

      await runBuildSimLogic(
        {
          workspacePath: '/path/to/MyProject.xcworkspace',
          scheme: 'MyScheme',
          simulatorName: 'iPhone 17',
          configuration: 'Release',
          derivedDataPath: '/custom/derived/path',
          extraArgs: ['--verbose'],
          useLatestOS: false,
        },
        createTrackingExecutor(callHistory),
      );

      expectRuntimeLookupThenBuild(
        callHistory,
        [
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
          '/custom/derived/path',
          '--verbose',
          'build',
        ],
        'iOS Simulator Build',
      );
    });

    it('should handle paths with spaces in command generation', async () => {
      const callHistory: Array<{ command: string[]; logPrefix?: string }> = [];

      await runBuildSimLogic(
        {
          workspacePath: '/Users/dev/My Project/MyProject.xcworkspace',
          scheme: 'My Scheme',
          simulatorName: 'iPhone 17 Pro',
        },
        createTrackingExecutor(callHistory),
      );

      expectRuntimeLookupThenBuild(
        callHistory,
        [
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
        ],
        'iOS Simulator Build',
      );
    });

    it('should generate correct build command with useLatestOS set to true', async () => {
      const callHistory: Array<{ command: string[]; logPrefix?: string }> = [];

      await runBuildSimLogic(
        {
          workspacePath: '/path/to/MyProject.xcworkspace',
          scheme: 'MyScheme',
          simulatorName: 'iPhone 17',
          useLatestOS: true,
        },
        createTrackingExecutor(callHistory),
      );

      expectRuntimeLookupThenBuild(
        callHistory,
        [
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
        ],
        'iOS Simulator Build',
      );
    });

    it('should infer watchOS platform from simulator name', async () => {
      const callHistory: Array<{ command: string[]; logPrefix?: string }> = [];

      await runBuildSimLogic(
        {
          workspacePath: '/path/to/MyProject.xcworkspace',
          scheme: 'MyWatchScheme',
          simulatorName: 'Apple Watch Ultra 2',
        },
        createTrackingExecutor(callHistory),
      );

      expectRuntimeLookupThenBuild(
        callHistory,
        [
          'xcodebuild',
          '-workspace',
          '/path/to/MyProject.xcworkspace',
          '-scheme',
          'MyWatchScheme',
          '-skipMacroValidation',
          '-destination',
          'platform=watchOS Simulator,name=Apple Watch Ultra 2,OS=latest',
          '-collect-test-diagnostics',
          'never',
          '-derivedDataPath',
          computeScopedDerivedDataPath('/path/to/MyProject.xcworkspace'),
          'build',
        ],
        'watchOS Simulator Build',
      );
    });

    it('should prepare reusable simulator test products', async () => {
      const callHistory: Array<{ command: string[]; logPrefix?: string }> = [];
      const testProductsPath = '/tmp/MyApp Tests.xctestproducts';

      const { result } = await runBuildSimLogic(
        {
          projectPath: '/path/to/MyProject.xcodeproj',
          scheme: 'MyScheme',
          simulatorName: 'iPhone 17',
          buildForTesting: true,
          testProductsPath,
        },
        createTrackingExecutor(callHistory),
      );

      expect(callHistory).toHaveLength(2);
      expect(callHistory[1].command.slice(-3)).toEqual([
        '-testProductsPath',
        testProductsPath,
        'build-for-testing',
      ]);
      expect(callHistory[1].logPrefix).toBe('iOS Simulator Build for Testing');
      expect(result.nextStepParams).toBeUndefined();
    });
  });

  describe('Response Processing', () => {
    it('should handle successful build', async () => {
      const mockExecutor = createMockExecutor({ success: true, output: 'BUILD SUCCEEDED' });

      const { result } = await runBuildSimLogic(
        {
          workspacePath: '/path/to/workspace',
          scheme: 'MyScheme',
          simulatorName: 'iPhone 17',
        },
        mockExecutor,
      );

      expect(result.isError()).toBeFalsy();
      expectPendingBuildResponse(result, 'get_sim_app_path');
    });

    it('should handle successful build with all optional parameters', async () => {
      const mockExecutor = createMockExecutor({ success: true, output: 'BUILD SUCCEEDED' });

      const { result } = await runBuildSimLogic(
        {
          workspacePath: '/path/to/workspace',
          scheme: 'MyScheme',
          simulatorName: 'iPhone 17',
          configuration: 'Release',
          derivedDataPath: '/path/to/derived',
          extraArgs: ['--verbose'],
          useLatestOS: false,
          preferXcodebuild: true,
        },
        mockExecutor,
      );

      expect(result.isError()).toBeFalsy();
      expectPendingBuildResponse(result, 'get_sim_app_path');
      expect(result.nextStepParams?.get_sim_app_path).toMatchObject({
        derivedDataPath: '/path/to/derived',
      });
      expect(result.nextStepConditionKeys).toEqual(['app_build_succeeded']);
    });

    it('should handle build failure', async () => {
      const mockExecutor = createMockExecutor({
        success: false,
        output: '',
        error: 'Build failed: Compilation error',
      });

      const { result } = await runBuildSimLogic(
        {
          workspacePath: '/path/to/workspace',
          scheme: 'MyScheme',
          simulatorName: 'iPhone 17',
        },
        mockExecutor,
      );

      expect(result.isError()).toBe(true);
      expectPendingBuildResponse(result);
    });

    it('should handle build warnings', async () => {
      const mockExecutor = createMockExecutor({
        success: true,
        output: 'warning: deprecated method used\nBUILD SUCCEEDED',
      });

      const { result } = await runBuildSimLogic(
        {
          workspacePath: '/path/to/workspace',
          scheme: 'MyScheme',
          simulatorName: 'iPhone 17',
        },
        mockExecutor,
      );

      expect(result.isError()).toBeFalsy();
      expectPendingBuildResponse(result, 'get_sim_app_path');
    });

    it('should handle command executor errors', async () => {
      const mockExecutor = createMockExecutor({
        success: false,
        error: 'spawn xcodebuild ENOENT',
      });

      const { result } = await runBuildSimLogic(
        {
          workspacePath: '/path/to/workspace',
          scheme: 'MyScheme',
          simulatorName: 'iPhone 17',
        },
        mockExecutor,
      );

      expect(result.isError()).toBe(true);
      expectPendingBuildResponse(result);
    });

    it('should handle mixed warning and error output', async () => {
      const mockExecutor = createMockExecutor({
        success: false,
        output: 'warning: deprecated method\nerror: undefined symbol',
        error: 'Build failed',
      });

      const { result } = await runBuildSimLogic(
        {
          workspacePath: '/path/to/workspace',
          scheme: 'MyScheme',
          simulatorName: 'iPhone 17',
        },
        mockExecutor,
      );

      expect(result.isError()).toBe(true);
      expectPendingBuildResponse(result);
    });

    it('should use default configuration when not provided', async () => {
      const mockExecutor = createMockExecutor({ success: true, output: 'BUILD SUCCEEDED' });

      const { result } = await runBuildSimLogic(
        {
          workspacePath: '/path/to/workspace',
          scheme: 'MyScheme',
          simulatorName: 'iPhone 17',
        },
        mockExecutor,
      );

      expect(result.isError()).toBeFalsy();
      expectPendingBuildResponse(result, 'get_sim_app_path');
    });

    it('should suggest running prepared simulator tests after success', async () => {
      const mockExecutor = createMockExecutor({ success: true, output: 'BUILD SUCCEEDED' });
      const testProductsPath = '/tmp/MyApp Tests.xctestproducts';

      const { result } = await runBuildSimLogic(
        {
          workspacePath: '/path/to/workspace',
          scheme: 'MyScheme',
          simulatorName: 'iPhone 17',
          buildForTesting: true,
          testProductsPath,
        },
        mockExecutor,
      );

      expect(result.nextStepParams).toEqual({
        test_sim: { testProductsPath, simulatorName: 'iPhone 17' },
      });
      expect(result.nextStepConditionKeys).toEqual(['prepared_tests_available']);
    });
  });

  describe('Error Handling', () => {
    it('should handle catch block exceptions', async () => {
      const mockExecutor = createMockExecutor({ success: true, output: 'BUILD SUCCEEDED' });

      const { result } = await runBuildSimLogic(
        {
          workspacePath: '/path/to/workspace',
          scheme: 'MyScheme',
          simulatorName: 'iPhone 17',
        },
        mockExecutor,
      );

      expect(result.isError()).toBeFalsy();
      expectPendingBuildResponse(result, 'get_sim_app_path');
    });
  });
});
