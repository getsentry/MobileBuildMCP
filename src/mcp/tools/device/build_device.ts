/**
 * Device Shared Plugin: Build Device (Unified)
 *
 * Builds an app from a project or workspace for a physical Apple device.
 * Accepts mutually exclusive `projectPath` or `workspacePath`.
 */

import * as z from 'zod';
import type { BuildResultDomainResult } from '../../../types/domain-results.ts';
import type { StreamingExecutor } from '../../../types/tool-execution.ts';
import { executeXcodeBuildCommand } from '../../../utils/build/index.ts';
import { devicePlatformSchema, mapDevicePlatform } from './build-settings.ts';
import type { CommandExecutor } from '../../../utils/execution/index.ts';
import { getDefaultCommandExecutor } from '../../../utils/execution/index.ts';
import {
  createSessionAwareTool,
  getSessionAwareToolSchemaShape,
  getHandlerContext,
  toInternalSchema,
} from '../../../utils/typed-tool-factory.ts';
import { nullifyEmptyStrings, withProjectOrWorkspace } from '../../../utils/schema-helpers.ts';
import {
  collectFallbackErrorMessages,
  createBuildDomainResult,
  createStreamingExecutionContext,
  createDomainStreamingPipeline,
  setXcodebuildStructuredOutput,
} from '../../../utils/xcodebuild-domain-results.ts';
import type { BuildInvocationRequest } from '../../../types/domain-fragments.ts';
import { displayPath } from '../../../utils/build-preflight.ts';
import { resolveEffectiveDerivedDataPath } from '../../../utils/derived-data-path.ts';
import { resolvePathFromCwd } from '../../../utils/path.ts';
import { filterTestProductsPathArgs } from '../../../utils/test-source.ts';
import { findXctestrunPaths } from '../../../utils/test-products-path.ts';
import { withManagedTestProductsOutput } from '../../../utils/test-products-lifecycle.ts';
import { createBuildInvocationFragment } from '../../../utils/xcodebuild-pipeline.ts';

interface PreparedBuildDeviceExecution {
  buildAction: 'build' | 'build-for-testing';
  invocationRequest: BuildInvocationRequest;
  logLabel: 'Build' | 'Build for Testing';
  sharedBuildParams: BuildDeviceParams;
  testProductsPath?: string;
}

function prepareBuildDeviceExecution(
  params: BuildDeviceParams,
  managedTestProductsPath?: string,
): PreparedBuildDeviceExecution {
  const buildForTesting = params.buildForTesting ?? false;
  const testProductsPath = buildForTesting
    ? (resolvePathFromCwd(params.testProductsPath) ?? managedTestProductsPath)
    : undefined;
  const sharedBuildParams = testProductsPath
    ? {
        ...params,
        extraArgs: [
          ...filterTestProductsPathArgs(params.extraArgs ?? []),
          '-testProductsPath',
          testProductsPath,
        ],
      }
    : params;

  return {
    buildAction: buildForTesting ? 'build-for-testing' : 'build',
    invocationRequest: createBuildDeviceRequest(params, testProductsPath),
    logLabel: buildForTesting ? 'Build for Testing' : 'Build',
    sharedBuildParams,
    testProductsPath,
  };
}

function createBuildDeviceRequest(
  params: BuildDeviceParams,
  testProductsPath?: string,
): BuildInvocationRequest {
  return {
    ...(params.buildForTesting ? { buildForTesting: true } : {}),
    scheme: params.scheme,
    workspacePath: params.workspacePath,
    projectPath: params.projectPath,
    derivedDataPath: resolveEffectiveDerivedDataPath(params),
    configuration: params.configuration,
    platform: String(mapDevicePlatform(params.platform)),
    target: 'device',
    ...(params.buildForTesting && params.deviceId ? { deviceId: params.deviceId } : {}),
    ...(testProductsPath ? { testProductsPath: displayPath(testProductsPath) } : {}),
  };
}

const baseSchemaObject = z.object({
  projectPath: z.string().optional().describe('Path to the .xcodeproj file'),
  workspacePath: z.string().optional().describe('Path to the .xcworkspace file'),
  scheme: z.string().describe('The scheme to build'),
  platform: devicePlatformSchema,
  configuration: z.string().optional().describe('Build configuration (Debug, Release)'),
  derivedDataPath: z.string().optional(),
  extraArgs: z.array(z.string()).optional(),
  preferXcodebuild: z.boolean().optional(),
  deviceId: z.string().optional().describe('UDID of the destination device'),
  buildForTesting: z
    .boolean()
    .optional()
    .describe('Build reusable test products without running tests (default: false)'),
  testProductsPath: z
    .string()
    .optional()
    .describe('Output path for the .xctestproducts bundle when buildForTesting is true'),
});

const buildDeviceSchema = z.preprocess(
  nullifyEmptyStrings,
  withProjectOrWorkspace(baseSchemaObject)
    .refine((params) => params.testProductsPath === undefined || params.buildForTesting === true, {
      message: 'testProductsPath requires buildForTesting to be true',
    })
    .refine((params) => params.deviceId === undefined || params.buildForTesting === true, {
      message: 'deviceId requires buildForTesting to be true',
    }),
);

export type BuildDeviceParams = z.infer<typeof buildDeviceSchema>;
type BuildDeviceResult = BuildResultDomainResult;

const publicSchemaObject = baseSchemaObject.omit({
  projectPath: true,
  workspacePath: true,
  scheme: true,
  configuration: true,
  derivedDataPath: true,
  preferXcodebuild: true,
} as const);

export function createBuildDeviceExecutor(
  executor: CommandExecutor,
  prepared?: PreparedBuildDeviceExecution,
): StreamingExecutor<BuildDeviceParams, BuildDeviceResult> {
  return async (params, ctx) => {
    const executePrepared = async (
      resolved: PreparedBuildDeviceExecution,
    ): Promise<BuildDeviceResult> => {
      const platform = mapDevicePlatform(params.platform);
      const started = createDomainStreamingPipeline('build_device', 'BUILD', ctx, 'build-result');

      const buildResult = await executeXcodeBuildCommand(
        resolved.sharedBuildParams,
        {
          platform,
          logPrefix: `${platform} Device ${resolved.logLabel}`,
          deviceId: params.buildForTesting ? params.deviceId : undefined,
        },
        params.preferXcodebuild ?? false,
        resolved.buildAction,
        executor,
        undefined,
        started.pipeline,
      );
      const succeeded = !buildResult.isError;
      const xctestrunPaths =
        succeeded && resolved.testProductsPath
          ? await findXctestrunPaths(resolved.testProductsPath)
          : [];

      return createBuildDomainResult({
        started,
        succeeded,
        target: 'device',
        artifacts: {
          buildLogPath: displayPath(started.pipeline.logPath),
          ...(succeeded && resolved.testProductsPath
            ? { testProductsPath: displayPath(resolved.testProductsPath) }
            : {}),
          ...(xctestrunPaths.length > 0 ? { xctestrunPaths: xctestrunPaths.map(displayPath) } : {}),
        },
        fallbackErrorMessages: collectFallbackErrorMessages(started, [], buildResult.content),
        request: resolved.invocationRequest,
      });
    };

    if (prepared) {
      return executePrepared(prepared);
    }
    return params.buildForTesting && params.testProductsPath === undefined
      ? withManagedTestProductsOutput(
          'build_device',
          (testProductsPath) =>
            executePrepared(prepareBuildDeviceExecution(params, testProductsPath)),
          { isSuccessful: (result) => !result.didError },
        )
      : executePrepared(prepareBuildDeviceExecution(params));
  };
}

async function executeBuildDeviceLogic(
  params: BuildDeviceParams,
  executor: CommandExecutor,
  prepared: PreparedBuildDeviceExecution,
): Promise<BuildDeviceResult> {
  const ctx = getHandlerContext();
  ctx.emit(createBuildInvocationFragment('build-result', 'BUILD', prepared.invocationRequest));
  const executionContext = createStreamingExecutionContext(ctx);
  const executeBuildDevice = createBuildDeviceExecutor(executor, prepared);
  const result = await executeBuildDevice(params, executionContext);

  setXcodebuildStructuredOutput(ctx, 'build-result', result, '3');

  if (!result.didError) {
    if (prepared.testProductsPath && params.deviceId) {
      const nextParams = {
        testProductsPath: displayPath(prepared.testProductsPath),
        deviceId: params.deviceId,
        ...(params.platform ? { platform: String(mapDevicePlatform(params.platform)) } : {}),
      };
      ctx.nextStepParams = { test_device: nextParams };
      ctx.nextStepConditionKeys = ['prepared_tests_available'];
    } else if (!prepared.testProductsPath) {
      const nextParams = {
        scheme: params.scheme,
        ...(params.derivedDataPath !== undefined
          ? { derivedDataPath: params.derivedDataPath }
          : {}),
        ...(params.platform !== undefined
          ? { platform: String(mapDevicePlatform(params.platform)) }
          : {}),
      };
      ctx.nextStepParams = { get_device_app_path: nextParams };
      ctx.nextStepConditionKeys = ['app_build_succeeded'];
    }
  }
  return result;
}

export async function buildDeviceLogic(
  params: BuildDeviceParams,
  executor: CommandExecutor,
): Promise<void> {
  if (params.buildForTesting && params.testProductsPath === undefined) {
    await withManagedTestProductsOutput(
      'build_device',
      (testProductsPath) =>
        executeBuildDeviceLogic(
          params,
          executor,
          prepareBuildDeviceExecution(params, testProductsPath),
        ),
      { isSuccessful: (result) => !result.didError },
    );
    return;
  }
  await executeBuildDeviceLogic(params, executor, prepareBuildDeviceExecution(params));
}

export const schema = getSessionAwareToolSchemaShape({
  sessionAware: publicSchemaObject,
  legacy: baseSchemaObject,
});

export const handler = createSessionAwareTool<BuildDeviceParams>({
  internalSchema: toInternalSchema<BuildDeviceParams>(buildDeviceSchema),
  logicFunction: buildDeviceLogic,
  getExecutor: getDefaultCommandExecutor,
  clearSessionDeviceIdUnlessPrepared: true,
  requirements: [
    { allOf: ['scheme'], message: 'scheme is required' },
    { oneOf: ['projectPath', 'workspacePath'], message: 'Provide a project or workspace' },
  ],
  exclusivePairs: [['projectPath', 'workspacePath']],
});
