/**
 * Simulator Build & Run Plugin: Build Run Simulator (Unified)
 *
 * Builds and runs an app from a project or workspace on a specific simulator by UUID or name.
 * Accepts mutually exclusive `projectPath` or `workspacePath`.
 * Accepts mutually exclusive `simulatorId` or `simulatorName`.
 */

import * as z from 'zod';
import type { SharedBuildParams } from '../../../types/common.ts';
import type { BuildRunResultDomainResult } from '../../../types/domain-results.ts';
import type { BuildInvocationRequest } from '../../../types/domain-fragments.ts';
import type { StreamingExecutor } from '../../../types/tool-execution.ts';
import { log } from '../../../utils/logging/index.ts';
import { getDefaultCommandExecutor } from '../../../utils/execution/index.ts';
import {
  createSessionAwareTool,
  getSessionAwareToolSchemaShape,
  getHandlerContext,
  toInternalSchema,
} from '../../../utils/typed-tool-factory.ts';
import { executeXcodeBuildCommand } from '../../../utils/build/index.ts';
import type { CommandExecutor } from '../../../utils/execution/index.ts';
import {
  determineSimulatorUuid,
  validateAvailableSimulatorId,
} from '../../../utils/simulator-utils.ts';
import {
  nullifyEmptyStrings,
  withProjectOrWorkspace,
  withSimulatorIdOrName,
} from '../../../utils/schema-helpers.ts';
import { inferPlatform, type InferPlatformResult } from '../../../utils/infer-platform.ts';
import { constructDestinationString } from '../../../utils/xcode.ts';
import { resolveAppPathFromBuildSettings } from '../../../utils/app-path-resolver.ts';
import { extractBundleIdFromAppPath } from '../../../utils/bundle-id.ts';
import {
  findSimulatorById,
  installAppOnSimulator,
  launchSimulatorAppWithLogging,
  type LaunchWithLoggingResult,
} from '../../../utils/simulator-steps.ts';
import {
  collectFallbackErrorMessages,
  createBuildRunDomainResult,
  createStreamingExecutionContext,
  createDomainStreamingPipeline,
  setXcodebuildStructuredOutput,
} from '../../../utils/xcodebuild-domain-results.ts';
import { resolveEffectiveDerivedDataPath } from '../../../utils/derived-data-path.ts';
import { createBuildInvocationFragment } from '../../../utils/xcodebuild-pipeline.ts';
import { openSimulatorFrontend } from '../../../utils/focus-policy.ts';

const baseOptions = {
  scheme: z.string().describe('The scheme to use (Required)'),
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
  extraArgs: z
    .array(z.string())
    .optional()
    .describe('Additional xcodebuild/build-settings arguments (not app launch arguments)'),
  launchArgs: z
    .array(z.string())
    .optional()
    .describe('Arguments passed to the launched app process on simulator runtime'),
  useLatestOS: z
    .boolean()
    .optional()
    .describe('Whether to use the latest OS version for the named simulator'),
  preferXcodebuild: z.boolean().optional(),
};

const baseSchemaObject = z.object({
  projectPath: z
    .string()
    .optional()
    .describe('Path to .xcodeproj file. Provide EITHER this OR workspacePath, not both'),
  workspacePath: z
    .string()
    .optional()
    .describe('Path to .xcworkspace file. Provide EITHER this OR projectPath, not both'),
  ...baseOptions,
});

const buildRunSimulatorSchema = z.preprocess(
  nullifyEmptyStrings,
  withSimulatorIdOrName(withProjectOrWorkspace(baseSchemaObject)),
);

export type BuildRunSimulatorParams = z.infer<typeof buildRunSimulatorSchema>;
export type SimulatorLauncher = typeof launchSimulatorAppWithLogging;
type BuildRunSimulatorResult = BuildRunResultDomainResult;

interface PreparedBuildRunSimExecution {
  configuration?: string;
  detectedPlatform: InferPlatformResult['platform'];
  displayPlatform: string;
  platformName: string;
  sharedBuildParams: SharedBuildParams;
  platformOptions: {
    platform: InferPlatformResult['platform'];
    simulatorId?: string;
    simulatorName?: string;
    useLatestOS?: boolean;
    logPrefix: string;
  };
  invocationRequest: BuildInvocationRequest;
  warningMessage?: string;
}

async function prepareBuildRunSimExecution(
  params: BuildRunSimulatorParams,
  executor: CommandExecutor,
): Promise<PreparedBuildRunSimExecution> {
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
  const detectedPlatform = inferred.platform;
  const configuration = params.configuration;
  // Every successful inference source (cache, runtime, name heuristic) is
  // authoritative, so the detected platform is always safe to display.
  const displayPlatform = String(detectedPlatform);
  const platformName = detectedPlatform.replace(' Simulator', '');

  return {
    configuration,
    detectedPlatform,
    displayPlatform,
    platformName,
    sharedBuildParams: {
      workspacePath: params.workspacePath,
      projectPath: params.projectPath,
      scheme: params.scheme,
      configuration,
      derivedDataPath: params.derivedDataPath,
      extraArgs: params.extraArgs,
    },
    platformOptions: {
      platform: detectedPlatform,
      simulatorId: params.simulatorId,
      simulatorName: params.simulatorName,
      useLatestOS: params.simulatorId ? false : params.useLatestOS,
      logPrefix: `${platformName} Simulator Build`,
    },
    invocationRequest: {
      scheme: params.scheme,
      workspacePath: params.workspacePath,
      projectPath: params.projectPath,
      derivedDataPath: resolveEffectiveDerivedDataPath(params),
      configuration,
      platform: displayPlatform,
      simulatorName: params.simulatorName,
      simulatorId: params.simulatorId,
    },
    warningMessage:
      params.simulatorId && params.useLatestOS !== undefined
        ? 'useLatestOS parameter is ignored when using simulatorId (UUID implies exact device/OS)'
        : undefined,
  };
}

export function createBuildRunSimExecutor(
  executor: CommandExecutor,
  launcher: SimulatorLauncher = launchSimulatorAppWithLogging,
  prepared?: PreparedBuildRunSimExecution,
): StreamingExecutor<BuildRunSimulatorParams, BuildRunSimulatorResult> {
  return async (params, ctx) => {
    const resolved = prepared ?? (await prepareBuildRunSimExecution(params, executor));

    if (resolved.warningMessage) {
      log('warn', resolved.warningMessage);
      ctx.emitFragment({
        kind: 'build-run-result',
        fragment: 'warning',
        message: resolved.warningMessage,
      });
    }

    const started = createDomainStreamingPipeline('build_run_sim', 'BUILD', ctx);

    try {
      if (params.simulatorId) {
        const validation = await validateAvailableSimulatorId(params.simulatorId, executor);
        if (validation.error) {
          return createBuildRunDomainResult({
            started,
            succeeded: false,
            target: 'simulator',
            artifacts: {
              buildLogPath: started.pipeline.logPath,
            },
            fallbackErrorMessages: collectFallbackErrorMessages(started, [validation.error]),
            request: resolved.invocationRequest,
          });
        }
      }

      const buildResult = await executeXcodeBuildCommand(
        resolved.sharedBuildParams,
        resolved.platformOptions,
        params.preferXcodebuild ?? false,
        'build',
        executor,
        undefined,
        started.pipeline,
      );

      if (buildResult.isError) {
        return createBuildRunDomainResult({
          started,
          succeeded: false,
          target: 'simulator',
          artifacts: {
            buildLogPath: started.pipeline.logPath,
          },
          fallbackErrorMessages: collectFallbackErrorMessages(started, [], buildResult.content),
          request: resolved.invocationRequest,
        });
      }

      ctx.emitFragment({
        kind: 'build-run-result',
        fragment: 'phase',
        phase: 'resolve-app-path',
        status: 'started',
      });

      let destination: string;
      if (params.simulatorId) {
        destination = constructDestinationString(
          resolved.detectedPlatform,
          undefined,
          params.simulatorId,
        );
      } else if (params.simulatorName) {
        destination = constructDestinationString(
          resolved.detectedPlatform,
          params.simulatorName,
          undefined,
          params.useLatestOS ?? true,
        );
      } else {
        destination = constructDestinationString(resolved.detectedPlatform);
      }

      let appBundlePath: string;
      try {
        appBundlePath = await resolveAppPathFromBuildSettings(
          {
            projectPath: params.projectPath,
            workspacePath: params.workspacePath,
            scheme: params.scheme,
            configuration: resolved.configuration,
            platform: resolved.detectedPlatform,
            destination,
            derivedDataPath: params.derivedDataPath,
            extraArgs: params.extraArgs,
          },
          executor,
        );
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return createBuildRunDomainResult({
          started,
          succeeded: false,
          target: 'simulator',
          artifacts: {
            buildLogPath: started.pipeline.logPath,
          },
          fallbackErrorMessages: collectFallbackErrorMessages(started, [
            `Failed to get app path to launch: ${errorMessage}`,
          ]),
          request: resolved.invocationRequest,
        });
      }

      log('info', `App bundle path for run: ${appBundlePath}`);
      ctx.emitFragment({
        kind: 'build-run-result',
        fragment: 'phase',
        phase: 'resolve-app-path',
        status: 'succeeded',
      });

      const uuidResult = await determineSimulatorUuid(
        { simulatorId: params.simulatorId, simulatorName: params.simulatorName },
        executor,
      );

      if (uuidResult.error || !uuidResult.uuid) {
        return createBuildRunDomainResult({
          started,
          succeeded: false,
          target: 'simulator',
          artifacts: {
            buildLogPath: started.pipeline.logPath,
          },
          fallbackErrorMessages: collectFallbackErrorMessages(started, [
            uuidResult.error ?? 'Failed to resolve simulator: no simulator identifier provided',
          ]),
          request: resolved.invocationRequest,
        });
      }

      if (uuidResult.warning) {
        log('warn', uuidResult.warning);
      }

      const simulatorId = uuidResult.uuid;
      ctx.emitFragment({
        kind: 'build-run-result',
        fragment: 'phase',
        phase: 'boot-simulator',
        status: 'started',
      });

      try {
        const { simulator: targetSimulator, error: findError } = await findSimulatorById(
          simulatorId,
          executor,
        );
        if (!targetSimulator) {
          throw new Error(findError ?? `Failed to find simulator with UUID: ${simulatorId}`);
        }

        if (targetSimulator.state !== 'Booted') {
          const bootResult = await executor(
            ['xcrun', 'simctl', 'boot', simulatorId],
            'Boot Simulator',
          );
          if (!bootResult.success) {
            throw new Error(bootResult.error ?? 'Failed to boot simulator');
          }
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return createBuildRunDomainResult({
          started,
          succeeded: false,
          target: 'simulator',
          artifacts: {
            simulatorId,
            buildLogPath: started.pipeline.logPath,
          },
          fallbackErrorMessages: collectFallbackErrorMessages(started, [
            `Failed to boot simulator: ${errorMessage}`,
          ]),
          request: resolved.invocationRequest,
        });
      }

      ctx.emitFragment({
        kind: 'build-run-result',
        fragment: 'phase',
        phase: 'boot-simulator',
        status: 'succeeded',
      });

      try {
        const openResult = await openSimulatorFrontend(executor, { simulatorId });
        if (!openResult.success) {
          throw new Error(openResult.error);
        }
      } catch (error) {
        log(
          'warn',
          `Warning: Could not open simulator frontend: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      ctx.emitFragment({
        kind: 'build-run-result',
        fragment: 'phase',
        phase: 'install-app',
        status: 'started',
      });
      const installResult = await installAppOnSimulator(simulatorId, appBundlePath, executor);
      if (!installResult.success) {
        const errorMessage = installResult.error ?? 'Failed to install app';
        return createBuildRunDomainResult({
          started,
          succeeded: false,
          target: 'simulator',
          artifacts: {
            simulatorId,
            buildLogPath: started.pipeline.logPath,
          },
          fallbackErrorMessages: collectFallbackErrorMessages(started, [
            `Failed to install app on simulator: ${errorMessage}`,
          ]),
          request: resolved.invocationRequest,
        });
      }
      ctx.emitFragment({
        kind: 'build-run-result',
        fragment: 'phase',
        phase: 'install-app',
        status: 'succeeded',
      });

      let bundleId: string;
      try {
        bundleId = (await extractBundleIdFromAppPath(appBundlePath, executor)).trim();
        if (bundleId.length === 0) {
          throw new Error('Empty bundle ID returned');
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return createBuildRunDomainResult({
          started,
          succeeded: false,
          target: 'simulator',
          artifacts: {
            simulatorId,
            buildLogPath: started.pipeline.logPath,
          },
          fallbackErrorMessages: collectFallbackErrorMessages(started, [
            `Failed to extract bundle ID: ${errorMessage}`,
          ]),
          request: resolved.invocationRequest,
        });
      }

      ctx.emitFragment({
        kind: 'build-run-result',
        fragment: 'phase',
        phase: 'launch-app',
        status: 'started',
      });
      const launchOptions =
        params.launchArgs === undefined ? undefined : { args: params.launchArgs };
      const launchResult: LaunchWithLoggingResult = await launcher(
        simulatorId,
        bundleId,
        executor,
        launchOptions,
      );
      if (!launchResult.success) {
        const errorMessage = launchResult.error ?? 'Failed to launch app';
        return createBuildRunDomainResult({
          started,
          succeeded: false,
          target: 'simulator',
          artifacts: {
            simulatorId,
            buildLogPath: started.pipeline.logPath,
          },
          fallbackErrorMessages: collectFallbackErrorMessages(started, [
            `Failed to launch app ${appBundlePath}: ${errorMessage}`,
          ]),
          request: resolved.invocationRequest,
        });
      }

      const processId = launchResult.processId;
      if (processId !== undefined) {
        log('info', `Launched with PID: ${processId}`);
      }

      return createBuildRunDomainResult({
        started,
        succeeded: true,
        target: 'simulator',
        artifacts: {
          appPath: appBundlePath,
          bundleId,
          ...(processId !== undefined ? { processId } : {}),
          simulatorId,
          buildLogPath: started.pipeline.logPath,
          ...(launchResult.logFilePath ? { runtimeLogPath: launchResult.logFilePath } : {}),
          ...(launchResult.osLogPath ? { osLogPath: launchResult.osLogPath } : {}),
        },
        request: resolved.invocationRequest,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return createBuildRunDomainResult({
        started,
        succeeded: false,
        target: 'simulator',
        artifacts: {
          buildLogPath: started.pipeline.logPath,
        },
        fallbackErrorMessages: collectFallbackErrorMessages(started, [
          `Error during simulator build and run: ${errorMessage}`,
        ]),
        request: resolved.invocationRequest,
      });
    }
  };
}

const publicSchemaObject = baseSchemaObject.partial({
  scheme: true,
} as const);

export async function build_run_simLogic(
  params: BuildRunSimulatorParams,
  executor: CommandExecutor,
  launcher: SimulatorLauncher = launchSimulatorAppWithLogging,
): Promise<void> {
  const ctx = getHandlerContext();

  let prepared: PreparedBuildRunSimExecution;
  try {
    prepared = await prepareBuildRunSimExecution(params, executor);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const fallbackRequest: BuildInvocationRequest = {
      scheme: params.scheme,
      workspacePath: params.workspacePath,
      projectPath: params.projectPath,
      derivedDataPath: resolveEffectiveDerivedDataPath(params),
      configuration: params.configuration,
      platform: 'Simulator',
      simulatorName: params.simulatorName,
      simulatorId: params.simulatorId,
    };
    ctx.emit(createBuildInvocationFragment('build-run-result', 'BUILD', fallbackRequest));
    const executionContext = createStreamingExecutionContext(ctx);
    const started = createDomainStreamingPipeline('build_run_sim', 'BUILD', executionContext);
    const result = createBuildRunDomainResult({
      started,
      succeeded: false,
      target: 'simulator',
      artifacts: {
        buildLogPath: started.pipeline.logPath,
      },
      fallbackErrorMessages: [`Error during simulator build and run: ${errorMessage}`],
      request: fallbackRequest,
    });
    setXcodebuildStructuredOutput(ctx, 'build-run-result', result);
    return;
  }

  ctx.emit(createBuildInvocationFragment('build-run-result', 'BUILD', prepared.invocationRequest));
  const executionContext = createStreamingExecutionContext(ctx);
  const executeBuildRunSim = createBuildRunSimExecutor(executor, launcher, prepared);

  const result = await executeBuildRunSim(params, executionContext);

  setXcodebuildStructuredOutput(ctx, 'build-run-result', result);

  if (!result.didError && 'simulatorId' in result.artifacts && 'bundleId' in result.artifacts) {
    const simulatorId =
      typeof result.artifacts.simulatorId === 'string' ? result.artifacts.simulatorId : undefined;
    const bundleId =
      typeof result.artifacts.bundleId === 'string' ? result.artifacts.bundleId : undefined;
    if (simulatorId && bundleId) {
      ctx.nextStepParams = {
        stop_app_sim: {
          simulatorId,
          bundleId,
        },
      };
    }
  }
}

export const schema = getSessionAwareToolSchemaShape({
  sessionAware: publicSchemaObject,
  legacy: baseSchemaObject,
});

export const handler = createSessionAwareTool<BuildRunSimulatorParams>({
  internalSchema: toInternalSchema<BuildRunSimulatorParams>(buildRunSimulatorSchema),
  logicFunction: build_run_simLogic,
  getExecutor: getDefaultCommandExecutor,
  requirements: [
    { allOf: ['scheme'], message: 'scheme is required' },
    { oneOf: ['projectPath', 'workspacePath'], message: 'Provide a project or workspace' },
    { oneOf: ['simulatorId', 'simulatorName'], message: 'Provide simulatorId or simulatorName' },
  ],
  exclusivePairs: [
    ['projectPath', 'workspacePath'],
    ['simulatorId', 'simulatorName'],
  ],
});
