import * as z from 'zod';
import type { BuildResultDomainResult } from '../../../types/domain-results.ts';
import type { StreamingExecutor } from '../../../types/tool-execution.ts';
import { log } from '../../../utils/logging/index.ts';
import { executeXcodeBuildCommand } from '../../../utils/build/index.ts';
import { XcodePlatform } from '../../../types/common.ts';
import type { CommandExecutor } from '../../../utils/execution/index.ts';
import { getDefaultCommandExecutor } from '../../../utils/execution/index.ts';
import {
  createSessionAwareTool,
  getSessionAwareToolSchemaShape,
  getHandlerContext,
  toInternalSchema,
} from '../../../utils/typed-tool-factory.ts';
import { nullifyEmptyStrings, withProjectOrWorkspace } from '../../../utils/schema-helpers.ts';
import { resolveAppPathFromBuildSettings } from '../../../utils/app-path-resolver.ts';
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

interface PreparedBuildMacOSExecution {
  buildAction: 'build' | 'build-for-testing';
  invocationRequest: BuildInvocationRequest;
  logLabel: 'Build' | 'Build for Testing';
  sharedBuildParams: BuildMacOSParams;
  testProductsPath?: string;
}

function prepareBuildMacOSExecution(
  params: BuildMacOSParams,
  managedTestProductsPath?: string,
): PreparedBuildMacOSExecution {
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
    invocationRequest: createBuildMacOSRequest(params, testProductsPath),
    logLabel: buildForTesting ? 'Build for Testing' : 'Build',
    sharedBuildParams,
    testProductsPath,
  };
}

function createBuildMacOSRequest(
  params: BuildMacOSParams,
  testProductsPath?: string,
): BuildInvocationRequest {
  return {
    ...(params.buildForTesting ? { buildForTesting: true } : {}),
    scheme: params.scheme,
    workspacePath: params.workspacePath,
    projectPath: params.projectPath,
    derivedDataPath: resolveEffectiveDerivedDataPath(params),
    configuration: params.configuration,
    platform: 'macOS',
    arch: params.arch,
    target: 'macos',
    ...(testProductsPath ? { testProductsPath: displayPath(testProductsPath) } : {}),
  };
}

const baseSchemaObject = z.object({
  projectPath: z.string().optional().describe('Path to the .xcodeproj file'),
  workspacePath: z.string().optional().describe('Path to the .xcworkspace file'),
  scheme: z.string().describe('The scheme to use'),
  configuration: z.string().optional().describe('Build configuration (Debug, Release, etc.)'),
  derivedDataPath: z.string().optional(),
  arch: z
    .enum(['arm64', 'x86_64'])
    .optional()
    .describe('Architecture to build for (arm64 or x86_64). For macOS only.'),
  extraArgs: z.array(z.string()).optional(),
  preferXcodebuild: z.boolean().optional(),
  buildForTesting: z
    .boolean()
    .optional()
    .describe('Build reusable test products without running tests (default: false)'),
  testProductsPath: z
    .string()
    .optional()
    .describe('Output path for the .xctestproducts bundle when buildForTesting is true'),
});

const publicSchemaObject = baseSchemaObject.omit({
  projectPath: true,
  workspacePath: true,
  scheme: true,
  configuration: true,
  arch: true,
  derivedDataPath: true,
  preferXcodebuild: true,
} as const);

const buildMacOSSchema = z.preprocess(
  nullifyEmptyStrings,
  withProjectOrWorkspace(baseSchemaObject).refine(
    (params) => params.testProductsPath === undefined || params.buildForTesting === true,
    { message: 'testProductsPath requires buildForTesting to be true' },
  ),
);

export type BuildMacOSParams = z.infer<typeof buildMacOSSchema>;
type BuildMacOSResult = BuildResultDomainResult;

export function createBuildMacOSExecutor(
  executor: CommandExecutor,
  prepared?: PreparedBuildMacOSExecution,
): StreamingExecutor<BuildMacOSParams, BuildMacOSResult> {
  return async (params, ctx) => {
    const executePrepared = async (
      resolved: PreparedBuildMacOSExecution,
    ): Promise<BuildMacOSResult> => {
      const configuration = params.configuration;
      const started = createDomainStreamingPipeline('build_macos', 'BUILD', ctx, 'build-result');
      const buildResult = await executeXcodeBuildCommand(
        { ...resolved.sharedBuildParams, configuration },
        {
          platform: XcodePlatform.macOS,
          arch: params.arch,
          logPrefix: `macOS ${resolved.logLabel}`,
        },
        params.preferXcodebuild ?? false,
        resolved.buildAction,
        executor,
        undefined,
        started.pipeline,
      );

      let bundleId: string | undefined;
      if (!buildResult.isError && !params.buildForTesting) {
        try {
          const appPath = await resolveAppPathFromBuildSettings(
            {
              projectPath: params.projectPath,
              workspacePath: params.workspacePath,
              scheme: params.scheme,
              configuration,
              platform: XcodePlatform.macOS,
              derivedDataPath: params.derivedDataPath,
              extraArgs: params.extraArgs,
            },
            executor,
          );

          const plistResult = await executor(
            ['defaults', 'read', `${appPath}/Contents/Info`, 'CFBundleIdentifier'],
            'Extract Bundle ID',
            false,
          );
          if (plistResult.success && plistResult.output) {
            bundleId = plistResult.output.trim();
          }
        } catch {
          // bundle ID is informational only
        }
      }
      const succeeded = !buildResult.isError;
      const xctestrunPaths =
        succeeded && resolved.testProductsPath
          ? await findXctestrunPaths(resolved.testProductsPath)
          : [];

      return createBuildDomainResult({
        started,
        succeeded,
        target: 'macos',
        artifacts: {
          ...(bundleId ? { bundleId } : {}),
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
          'build_macos',
          (testProductsPath) =>
            executePrepared(prepareBuildMacOSExecution(params, testProductsPath)),
          { isSuccessful: (result) => !result.didError },
        )
      : executePrepared(prepareBuildMacOSExecution(params));
  };
}

async function executeBuildMacOSLogic(
  params: BuildMacOSParams,
  executor: CommandExecutor,
  prepared: PreparedBuildMacOSExecution,
): Promise<BuildMacOSResult> {
  const ctx = getHandlerContext();
  log('info', `Starting macOS build for scheme ${params.scheme}`);

  ctx.emit(createBuildInvocationFragment('build-result', 'BUILD', prepared.invocationRequest));
  const executionContext = createStreamingExecutionContext(ctx);
  const executeBuildMacOS = createBuildMacOSExecutor(executor, prepared);
  const result = await executeBuildMacOS(params, executionContext);

  setXcodebuildStructuredOutput(ctx, 'build-result', result, '3');

  if (!result.didError) {
    if (prepared.testProductsPath) {
      const nextParams = { testProductsPath: displayPath(prepared.testProductsPath) };
      ctx.nextStepParams = { test_macos: nextParams };
      ctx.nextStepConditionKeys = ['prepared_tests_available'];
    } else {
      const nextParams = {
        scheme: params.scheme,
        ...(params.derivedDataPath !== undefined
          ? { derivedDataPath: params.derivedDataPath }
          : {}),
      };
      ctx.nextStepParams = { get_mac_app_path: nextParams };
      ctx.nextStepConditionKeys = ['app_build_succeeded'];
    }
  }
  return result;
}

export async function buildMacOSLogic(
  params: BuildMacOSParams,
  executor: CommandExecutor,
): Promise<void> {
  if (params.buildForTesting && params.testProductsPath === undefined) {
    await withManagedTestProductsOutput(
      'build_macos',
      (testProductsPath) =>
        executeBuildMacOSLogic(
          params,
          executor,
          prepareBuildMacOSExecution(params, testProductsPath),
        ),
      { isSuccessful: (result) => !result.didError },
    );
    return;
  }
  await executeBuildMacOSLogic(params, executor, prepareBuildMacOSExecution(params));
}

export const schema = getSessionAwareToolSchemaShape({
  sessionAware: publicSchemaObject,
  legacy: baseSchemaObject,
});

export const handler = createSessionAwareTool<BuildMacOSParams>({
  internalSchema: toInternalSchema<BuildMacOSParams>(buildMacOSSchema),
  logicFunction: buildMacOSLogic,
  getExecutor: getDefaultCommandExecutor,
  requirements: [
    { allOf: ['scheme'], message: 'scheme is required' },
    { oneOf: ['projectPath', 'workspacePath'], message: 'Provide a project or workspace' },
  ],
  exclusivePairs: [['projectPath', 'workspacePath']],
});
