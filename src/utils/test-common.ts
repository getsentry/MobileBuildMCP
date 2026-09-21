/**
 * Common Test Utilities - Shared logic for test tools
 *
 * This module provides shared functionality for all xcodebuild-backed test tools across platforms.
 */

import * as path from 'node:path';
import { log } from './logger.ts';
import { constructDestinationString, XcodePlatform } from './xcode.ts';
import { executeXcodeBuildCommand } from './build/index.ts';
import { extractTestFailuresFromXcresult } from './xcresult-test-failures.ts';

import { normalizeTestRunnerEnv } from './environment.ts';
import type { CommandExecutor, CommandExecOptions } from './command.ts';
import { getDefaultCommandExecutor } from './command.ts';
import { type TestPreflightResult } from './test-preflight.ts';

import { createSimulatorTwoPhaseExecutionPlan } from './simulator-test-execution.ts';
import { parseResultBundlePathArgs } from './result-bundle-args.ts';
import {
  createDefaultResultBundlePath,
  markResultBundlePathCompleted,
} from './result-bundle-path.ts';
import {
  withManagedTestProductsOutput,
  withManagedTestProductsReader,
} from './test-products-lifecycle.ts';
import { resolvePathFromCwd } from './path.ts';
import { displayPath } from './build-preflight.ts';
import {
  filterPreparedTestExtraArgs,
  filterTestProductsPathArgs,
  getPreparedTestDestinationArgs,
} from './test-source.ts';

import type {
  BuildTarget,
  TestResultArtifacts,
  TestResultDomainResult,
} from '../types/domain-results.ts';
import type { BuildInvocationRequest } from '../types/domain-fragments.ts';
import type { StreamingExecutor } from '../types/tool-execution.ts';
import {
  createDomainStreamingPipeline,
  createTestDiscoveryFragment,
  createTestDomainResult,
} from './xcodebuild-domain-results.ts';

function emitXcresultFailures(
  pipeline: ReturnType<typeof createDomainStreamingPipeline>['pipeline'],
  xcresultPath: string,
): void {
  const failures = extractTestFailuresFromXcresult(xcresultPath);
  for (const event of failures) {
    pipeline.emitFragment(event);
  }
}

function getBuildTarget(platform: XcodePlatform): BuildTarget {
  if (String(platform).includes('Simulator')) {
    return 'simulator';
  }
  if (String(platform) === 'macOS') {
    return 'macos';
  }
  return 'device';
}

function getFallbackErrorMessages(
  streamedLines: readonly string[],
  responseContent?: Array<{ type: 'text'; text: string }>,
): string[] {
  return [...streamedLines, ...(responseContent ?? []).map((item) => item.text)];
}

function createXcodebuildTestArtifacts(
  params: Pick<SharedTestExecutorParams, 'deviceId'>,
  started: ReturnType<typeof createDomainStreamingPipeline>,
  xcresultPath?: string,
  preparedTestSource?: Pick<SharedTestExecutorParams, 'testProductsPath' | 'xctestrunPath'>,
): TestResultArtifacts & { testProductsPath?: string; xctestrunPath?: string } {
  return {
    ...(params.deviceId ? { deviceId: params.deviceId } : {}),
    buildLogPath: started.pipeline.logPath,
    ...(xcresultPath ? { xcresultPath } : {}),
    ...(preparedTestSource?.testProductsPath
      ? { testProductsPath: displayPath(preparedTestSource.testProductsPath) }
      : {}),
    ...(preparedTestSource?.xctestrunPath
      ? { xctestrunPath: displayPath(preparedTestSource.xctestrunPath) }
      : {}),
  };
}

function createDisplayedTestDomainResult(
  options: Parameters<typeof createTestDomainResult>[0],
): TestResultDomainResult {
  const result = createTestDomainResult(options);
  return {
    ...result,
    artifacts: {
      ...result.artifacts,
      ...(result.artifacts.buildLogPath
        ? { buildLogPath: displayPath(result.artifacts.buildLogPath) }
        : {}),
      ...(result.artifacts.xcresultPath
        ? { xcresultPath: displayPath(result.artifacts.xcresultPath) }
        : {}),
    },
  };
}

export function resolveTestProgressEnabled(progress: boolean | undefined): boolean {
  return progress ?? process.env.XCODEBUILDMCP_RUNTIME === 'mcp';
}

export interface SharedTestExecutorParams {
  workspacePath?: string;
  projectPath?: string;
  scheme?: string;
  configuration?: string;
  simulatorName?: string;
  simulatorId?: string;
  deviceId?: string;
  useLatestOS?: boolean;
  packageCachePath?: string;
  derivedDataPath?: string;
  extraArgs?: string[];
  preferXcodebuild?: boolean;
  platform: XcodePlatform;
  testRunnerEnv?: Record<string, string>;
  progress?: boolean;
  testProductsPath?: string;
  xctestrunPath?: string;
}

export interface SharedTestExecutorOptions {
  preflight?: TestPreflightResult;
  toolName?: string;
  target?: BuildTarget;
  request: BuildInvocationRequest;
}

function createPreparedTestDestination(params: SharedTestExecutorParams): string | undefined {
  if (String(params.platform).includes('Simulator')) {
    return constructDestinationString(
      params.platform,
      params.simulatorName,
      params.simulatorId,
      params.useLatestOS,
    );
  }
  if (params.platform === XcodePlatform.macOS) {
    return constructDestinationString(params.platform);
  }
  if (params.deviceId) {
    return `platform=${String(params.platform)},id=${params.deviceId}`;
  }
  return undefined;
}

function resolveSourceWorkingDirectory(params: SharedTestExecutorParams): string | undefined {
  const sourcePath = params.workspacePath ?? params.projectPath;
  return sourcePath ? path.dirname(resolvePathFromCwd(sourcePath)) : undefined;
}

async function executePreparedTestCommand(
  params: SharedTestExecutorParams,
  extraArgs: string[],
  resultBundlePath: string,
  executor: CommandExecutor,
  execOpts: CommandExecOptions | undefined,
  pipeline: ReturnType<typeof createDomainStreamingPipeline>['pipeline'],
  destinationArgs?: string[],
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const sourceArgs = params.testProductsPath
    ? ['-testProductsPath', resolvePathFromCwd(params.testProductsPath)]
    : params.xctestrunPath
      ? ['-xctestrun', resolvePathFromCwd(params.xctestrunPath)]
      : [];
  const destination = createPreparedTestDestination(params);
  if (sourceArgs.length === 0) {
    return {
      content: [{ type: 'text', text: 'A prepared test artifact is required.' }],
      isError: true,
    };
  }
  if (!destination) {
    return {
      content: [{ type: 'text', text: 'A destination is required to run prepared tests.' }],
      isError: true,
    };
  }

  const command = [
    'xcodebuild',
    ...sourceArgs,
    ...(destinationArgs && destinationArgs.length > 0
      ? destinationArgs
      : ['-destination', destination]),
    '-collect-test-diagnostics',
    'never',
    ...extraArgs,
    '-resultBundlePath',
    resultBundlePath,
    'test-without-building',
  ];
  const sourceWorkingDirectory = resolveSourceWorkingDirectory(params);
  const execute = async (): Promise<{
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  }> => {
    const response = await executor(command, 'Test Run', false, {
      ...execOpts,
      ...(sourceWorkingDirectory ? { cwd: sourceWorkingDirectory } : {}),
      onStdout: (chunk) => pipeline.onStdout(chunk),
      onStderr: (chunk) => pipeline.onStderr(chunk),
    });

    return response.success
      ? { content: [{ type: 'text' as const, text: 'Test Run test-without-building succeeded.' }] }
      : {
          content: [{ type: 'text' as const, text: 'Test Run test-without-building failed.' }],
          isError: true,
        };
  };

  const preparedSourcePath = params.testProductsPath ?? params.xctestrunPath;
  return preparedSourcePath
    ? withManagedTestProductsReader(resolvePathFromCwd(preparedSourcePath), execute)
    : execute();
}

type PreparedTestCommandResult = Awaited<ReturnType<typeof executePreparedTestCommand>>;

export function createTestExecutor(
  executor: CommandExecutor = getDefaultCommandExecutor(),
  options: SharedTestExecutorOptions,
): StreamingExecutor<SharedTestExecutorParams, TestResultDomainResult> {
  return async (params, ctx) => {
    log(
      'info',
      `Starting test run for ${params.scheme ? `scheme ${params.scheme}` : 'prepared tests'} on platform ${params.platform} (executor)`,
    );

    const execOpts: CommandExecOptions | undefined = params.testRunnerEnv
      ? { env: normalizeTestRunnerEnv(params.testRunnerEnv) }
      : undefined;
    const hasPreparedTestSource = Boolean(params.testProductsPath ?? params.xctestrunPath);
    const toolName = options.toolName ?? 'test_sim';
    const target = options.target ?? getBuildTarget(params.platform);
    const started = createDomainStreamingPipeline(toolName, 'TEST', ctx, 'test-result');
    const platformOptions = {
      platform: params.platform,
      simulatorName: params.simulatorName,
      simulatorId: params.simulatorId,
      deviceId: params.deviceId,
      useLatestOS: params.useLatestOS,
      packageCachePath: params.packageCachePath,
      logPrefix: 'Test Run',
    };
    const discoveryEvent = createTestDiscoveryFragment(options.preflight);

    if (discoveryEvent) {
      started.pipeline.emitFragment(discoveryEvent);
    }

    const parsedResultBundleArgs = parseResultBundlePathArgs(params.extraArgs);
    const shouldUseDefaultResultBundlePath = !parsedResultBundleArgs.resultBundlePath;
    const resultBundlePath =
      parsedResultBundleArgs.resultBundlePath ?? createDefaultResultBundlePath(toolName);

    if (!hasPreparedTestSource) {
      let managedOutputWasProduced = false;
      return withManagedTestProductsOutput(
        toolName,
        async (testProductsPath) => {
          const executionPlan = createSimulatorTwoPhaseExecutionPlan({
            extraArgs: parsedResultBundleArgs.remainingArgs,
            preflight: options.preflight,
          });

          const buildForTestingResult = await executeXcodeBuildCommand(
            {
              ...params,
              scheme: params.scheme!,
              extraArgs: [
                ...filterTestProductsPathArgs(executionPlan.buildArgs),
                '-testProductsPath',
                testProductsPath,
              ],
            },
            platformOptions,
            params.preferXcodebuild,
            'build-for-testing',
            executor,
            execOpts,
            started.pipeline,
            { propagateInfrastructureErrors: true },
          );

          if (buildForTestingResult.isError) {
            return createDisplayedTestDomainResult({
              started,
              succeeded: false,
              target,
              artifacts: createXcodebuildTestArtifacts(params, started),
              fallbackErrorMessages: getFallbackErrorMessages(
                started.stderrLines,
                buildForTestingResult.content,
              ),
              includeDetectedXcresult: false,
              preflight: options.preflight,
              request: options.request,
            });
          }
          managedOutputWasProduced = true;

          started.pipeline.emitFragment({
            kind: 'test-result',
            fragment: 'build-stage',
            operation: 'TEST',
            stage: 'RUN_TESTS',
            message: 'Running tests',
          });

          let testWithoutBuildingResult: PreparedTestCommandResult;
          try {
            testWithoutBuildingResult = await executePreparedTestCommand(
              { ...params, testProductsPath },
              filterPreparedTestExtraArgs(executionPlan.testArgs),
              resultBundlePath,
              executor,
              execOpts,
              started.pipeline,
              getPreparedTestDestinationArgs(executionPlan.testArgs),
            );
          } finally {
            if (shouldUseDefaultResultBundlePath) {
              markResultBundlePathCompleted(resultBundlePath);
            }
          }
          emitXcresultFailures(started.pipeline, resultBundlePath);

          return createDisplayedTestDomainResult({
            started,
            succeeded: !testWithoutBuildingResult.isError,
            target,
            artifacts: createXcodebuildTestArtifacts(params, started, resultBundlePath, {
              testProductsPath,
            }),
            fallbackErrorMessages: getFallbackErrorMessages(
              started.stderrLines,
              testWithoutBuildingResult.content,
            ),
            preflight: options.preflight,
            request: options.request,
          });
        },
        { isSuccessful: () => managedOutputWasProduced },
      );
    }

    started.pipeline.emitFragment({
      kind: 'test-result',
      fragment: 'build-stage',
      operation: 'TEST',
      stage: 'RUN_TESTS',
      message: 'Running tests',
    });

    let preparedTestResult: PreparedTestCommandResult;
    try {
      preparedTestResult = await executePreparedTestCommand(
        params,
        parsedResultBundleArgs.remainingArgs,
        resultBundlePath,
        executor,
        execOpts,
        started.pipeline,
      );
    } finally {
      if (shouldUseDefaultResultBundlePath) {
        markResultBundlePathCompleted(resultBundlePath);
      }
    }
    emitXcresultFailures(started.pipeline, resultBundlePath);

    return createDisplayedTestDomainResult({
      started,
      succeeded: !preparedTestResult.isError,
      target,
      artifacts: createXcodebuildTestArtifacts(params, started, resultBundlePath, params),
      fallbackErrorMessages: getFallbackErrorMessages(
        started.stderrLines,
        preparedTestResult.content,
      ),
      preflight: options.preflight,
      request: options.request,
    });
  };
}
