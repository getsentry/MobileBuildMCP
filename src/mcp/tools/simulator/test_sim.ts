/**
 * Simulator Test Plugin: Test Simulator (Unified)
 *
 * Runs tests for a project or workspace on a simulator by UUID or name.
 * Accepts mutually exclusive `projectPath` or `workspacePath`.
 * Accepts mutually exclusive `simulatorId` or `simulatorName`.
 */

import * as z from 'zod';
import type { TestResultDomainResult } from '../../../types/domain-results.ts';
import type { StreamingExecutor } from '../../../types/tool-execution.ts';
import { createTestExecutor } from '../../../utils/test/index.ts';
import { log } from '../../../utils/logging/index.ts';
import type { CommandExecutor, FileSystemExecutor } from '../../../utils/execution/index.ts';
import {
  getDefaultCommandExecutor,
  getDefaultFileSystemExecutor,
} from '../../../utils/execution/index.ts';
import { nullifyEmptyStrings, withSimulatorIdOrName } from '../../../utils/schema-helpers.ts';
import {
  hasPreparedTestSource,
  TEST_SOURCE_EXCLUSIVE_GROUPS,
  withProjectWorkspaceOrTestArtifact,
} from '../../../utils/test-source.ts';
import {
  createSessionAwareTool,
  getSessionAwareToolSchemaShape,
  getHandlerContext,
  toInternalSchema,
} from '../../../utils/typed-tool-factory.ts';
import { inferPlatform, type InferPlatformResult } from '../../../utils/infer-platform.ts';
import { resolveTestPreflight, type TestPreflightResult } from '../../../utils/test-preflight.ts';
import { resolveSimulatorIdOrName } from '../../../utils/simulator-resolver.ts';
import {
  createStreamingExecutionContext,
  createDomainStreamingPipeline,
  createTestDomainResult,
  setXcodebuildStructuredOutput,
} from '../../../utils/xcodebuild-domain-results.ts';
import type { BuildInvocationRequest } from '../../../types/domain-fragments.ts';
import { resolveEffectiveDerivedDataPath } from '../../../utils/derived-data-path.ts';
import { createBuildInvocationFragment } from '../../../utils/xcodebuild-pipeline.ts';
import { displayPath } from '../../../utils/build-preflight.ts';
import {
  normalizeEnvironmentVariableArgument,
  testRunnerEnvironmentSchema,
} from '../../../utils/environment-variable-input.ts';

const baseSchemaObject = z.object({
  projectPath: z
    .string()
    .optional()
    .describe('Path to .xcodeproj file. Provide EITHER this OR workspacePath, not both'),
  workspacePath: z
    .string()
    .optional()
    .describe('Path to .xcworkspace file. Provide EITHER this OR projectPath, not both'),
  scheme: z.string().optional().describe('The scheme to use in source mode'),
  testProductsPath: z
    .string()
    .optional()
    .describe('Path to a prepared .xctestproducts package. Cannot be combined with source inputs'),
  xctestrunPath: z
    .string()
    .optional()
    .describe('Path to a prepared .xctestrun file. Cannot be combined with source inputs'),
  simulatorId: z
    .string()
    .optional()
    .describe(
      'UUID of the simulator (from list_sims). Provide EITHER this OR simulatorName, not both',
    ),
  simulatorName: z
    .string()
    .optional()
    .describe(
      "Name of the simulator (e.g., 'iPhone 17'). Provide EITHER this OR simulatorId, not both",
    ),
  configuration: z.string().optional().describe('Build configuration (Debug, Release, etc.)'),
  derivedDataPath: z.string().optional(),
  extraArgs: z.array(z.string()).optional(),
  onlyTesting: z
    .array(z.string())
    .optional()
    .describe('Test identifiers to include (for example, Target/Suite/testMethod)'),
  skipTesting: z
    .array(z.string())
    .optional()
    .describe('Test identifiers to exclude (for example, Target/Suite/testMethod)'),
  useLatestOS: z
    .boolean()
    .optional()
    .describe('Whether to use the latest OS version for the named simulator'),
  preferXcodebuild: z.boolean().optional(),
  testRunnerEnv: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      'Environment variables to pass to the test runner (TEST_RUNNER_ prefix added automatically)',
    ),
  progress: z
    .boolean()
    .optional()
    .describe('Show detailed test progress output (MCP defaults to true, CLI defaults to false)'),
});

const testSimulatorSchema = z.preprocess(
  nullifyEmptyStrings,
  withSimulatorIdOrName(withProjectWorkspaceOrTestArtifact(baseSchemaObject)),
);

const mcpFullSchemaObject = baseSchemaObject.extend({
  testRunnerEnv: testRunnerEnvironmentSchema,
});

type TestSimulatorParams = z.infer<typeof testSimulatorSchema>;
type TestSimulatorResult = TestResultDomainResult;

interface PreparedTestSimExecution {
  configuration?: string;
  platform: InferPlatformResult['platform'];
  preflight?: TestPreflightResult;
  resolvedSimulatorId?: string;
  invocationRequest: BuildInvocationRequest;
  resolutionError?: string;
  warningMessage?: string;
}

function resolveExtraArgs(params: TestSimulatorParams): string[] | undefined {
  const selectorArgs = [
    ...(params.onlyTesting ?? []).map((selector) => `-only-testing:${selector}`),
    ...(params.skipTesting ?? []).map((selector) => `-skip-testing:${selector}`),
  ];

  if (!params.extraArgs && selectorArgs.length === 0) {
    return undefined;
  }

  return [...(params.extraArgs ?? []), ...selectorArgs];
}

async function prepareTestSimExecution(
  params: TestSimulatorParams,
  executor: CommandExecutor,
  fileSystemExecutor: FileSystemExecutor,
): Promise<PreparedTestSimExecution> {
  const preparedTestSource = hasPreparedTestSource(params);
  const extraArgs = resolveExtraArgs(params);
  const configuration = preparedTestSource ? undefined : params.configuration;
  const inferred = await inferPlatform(
    {
      projectPath: params.projectPath,
      workspacePath: params.workspacePath,
      scheme: params.scheme,
      simulatorId: params.simulatorId,
      simulatorName: params.simulatorName,
    },
    executor,
  );

  log(
    'info',
    `Inferred simulator platform for tests: ${inferred.platform} (source: ${inferred.source})`,
  );

  const simulatorResolution = await resolveSimulatorIdOrName(
    executor,
    params.simulatorId,
    params.simulatorName,
  );

  if (!simulatorResolution.success) {
    return {
      configuration,
      platform: inferred.platform,
      resolutionError: simulatorResolution.error,
      invocationRequest: {
        scheme: params.scheme,
        workspacePath: params.workspacePath,
        projectPath: params.projectPath,
        derivedDataPath: preparedTestSource ? undefined : resolveEffectiveDerivedDataPath(params),
        configuration,
        platform: inferred.platform,
        simulatorName: params.simulatorName,
        simulatorId: params.simulatorId,
        testProductsPath: params.testProductsPath
          ? displayPath(params.testProductsPath)
          : undefined,
        xctestrunPath: params.xctestrunPath ? displayPath(params.xctestrunPath) : undefined,
      },
      warningMessage:
        params.simulatorId && params.useLatestOS !== undefined
          ? 'useLatestOS parameter is ignored when using simulatorId (UUID implies exact device/OS)'
          : undefined,
    };
  }

  const destinationName = params.simulatorName ?? simulatorResolution.simulatorName;
  const preflight = preparedTestSource
    ? null
    : await resolveTestPreflight(
        {
          projectPath: params.projectPath,
          workspacePath: params.workspacePath,
          scheme: params.scheme!,
          configuration,
          extraArgs,
          destinationName,
        },
        fileSystemExecutor,
      );

  return {
    configuration,
    platform: inferred.platform,
    preflight: preflight ?? undefined,
    resolvedSimulatorId: simulatorResolution.simulatorId,
    invocationRequest: {
      scheme: params.scheme,
      workspacePath: params.workspacePath,
      projectPath: params.projectPath,
      derivedDataPath: preparedTestSource ? undefined : resolveEffectiveDerivedDataPath(params),
      configuration,
      platform: inferred.platform,
      simulatorName: params.simulatorName,
      simulatorId: params.simulatorId,
      testProductsPath: params.testProductsPath ? displayPath(params.testProductsPath) : undefined,
      xctestrunPath: params.xctestrunPath ? displayPath(params.xctestrunPath) : undefined,
      onlyTesting: preflight?.selectors.onlyTesting.map((selector) => selector.raw),
      skipTesting: preflight?.selectors.skipTesting.map((selector) => selector.raw),
    },
    warningMessage:
      params.simulatorId && params.useLatestOS !== undefined
        ? 'useLatestOS parameter is ignored when using simulatorId (UUID implies exact device/OS)'
        : undefined,
  };
}

export function createTestSimExecutor(
  executor: CommandExecutor,
  fileSystemExecutor: FileSystemExecutor = getDefaultFileSystemExecutor(),
  prepared?: PreparedTestSimExecution,
): StreamingExecutor<TestSimulatorParams, TestSimulatorResult> {
  return async (params, ctx) => {
    const resolved =
      prepared ?? (await prepareTestSimExecution(params, executor, fileSystemExecutor));

    if (resolved.warningMessage) {
      log('warn', resolved.warningMessage);
      ctx.emitFragment({
        kind: 'test-result',
        fragment: 'warning',
        message: resolved.warningMessage,
      });
    }

    if (resolved.resolutionError || !resolved.resolvedSimulatorId) {
      const started = createDomainStreamingPipeline('test_sim', 'TEST', ctx, 'test-result');
      return createTestDomainResult({
        started,
        succeeded: false,
        target: 'simulator',
        artifacts: {
          buildLogPath: displayPath(started.pipeline.logPath),
        },
        fallbackErrorMessages: [
          resolved.resolutionError ?? 'Failed to resolve simulator identifier for test execution.',
        ],
        request: resolved.invocationRequest,
      });
    }

    const executeTest = createTestExecutor(executor, {
      preflight: resolved.preflight,
      toolName: 'test_sim',
      target: 'simulator',
      request: resolved.invocationRequest,
    });

    return executeTest(
      {
        projectPath: params.projectPath,
        workspacePath: params.workspacePath,
        scheme: params.scheme,
        simulatorId: resolved.resolvedSimulatorId,
        simulatorName: params.simulatorName,
        configuration: resolved.configuration,
        derivedDataPath: params.derivedDataPath,
        extraArgs: resolveExtraArgs(params),
        useLatestOS: false,
        preferXcodebuild: params.preferXcodebuild ?? false,
        platform: resolved.platform,
        testRunnerEnv: params.testRunnerEnv,
        progress: params.progress,
        testProductsPath: params.testProductsPath,
        xctestrunPath: params.xctestrunPath,
      },
      ctx,
    );
  };
}

export async function test_simLogic(
  params: TestSimulatorParams,
  executor: CommandExecutor,
  fileSystemExecutor: FileSystemExecutor = getDefaultFileSystemExecutor(),
): Promise<void> {
  const ctx = getHandlerContext();
  const prepared = await prepareTestSimExecution(params, executor, fileSystemExecutor);

  ctx.emit(createBuildInvocationFragment('test-result', 'TEST', prepared.invocationRequest));
  const executionContext = createStreamingExecutionContext(ctx);
  const executeTestSim = createTestSimExecutor(executor, fileSystemExecutor, prepared);
  const result = await executeTestSim(params, executionContext);

  setXcodebuildStructuredOutput(ctx, 'test-result', result, '3');
}

const publicSchemaObject = baseSchemaObject;

const mcpPublicSchemaObject = mcpFullSchemaObject;

export const schema = getSessionAwareToolSchemaShape({
  sessionAware: publicSchemaObject,
  legacy: baseSchemaObject,
});

export const mcpSchema = getSessionAwareToolSchemaShape({
  sessionAware: mcpPublicSchemaObject,
  legacy: mcpFullSchemaObject,
});

export const handler = createSessionAwareTool<TestSimulatorParams>({
  internalSchema: toInternalSchema<TestSimulatorParams>(testSimulatorSchema),
  logicFunction: (params, executor) =>
    test_simLogic(params, executor, getDefaultFileSystemExecutor()),
  getExecutor: getDefaultCommandExecutor,
  requirements: [
    { oneOf: ['simulatorId', 'simulatorName'], message: 'Provide simulatorId or simulatorName' },
  ],
  exclusivePairs: [
    ...TEST_SOURCE_EXCLUSIVE_GROUPS,
    ['projectPath', 'workspacePath'],
    ['simulatorId', 'simulatorName'],
  ],
  normalizeExplicitArgs: (args) => normalizeEnvironmentVariableArgument(args, 'testRunnerEnv'),
});
