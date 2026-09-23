import * as z from 'zod';
import path from 'node:path';
import type { ToolHandlerContext } from '../../../rendering/types.ts';
import type { BuildRunResultDomainResult } from '../../../types/domain-results.ts';
import type { StreamingExecutor } from '../../../types/tool-execution.ts';
import { log } from '../../../utils/logging/index.ts';
import type { CommandExecutor, CommandResponse } from '../../../utils/execution/index.ts';
import { getDefaultCommandExecutor } from '../../../utils/execution/index.ts';
import { addProcess } from './active-processes.ts';
import {
  createSessionAwareTool,
  getSessionAwareToolSchemaShape,
  getHandlerContext,
} from '../../../utils/typed-tool-factory.ts';
import { acquireDaemonActivity } from '../../../daemon/activity-registry.ts';
import { toErrorMessage } from '../../../utils/errors.ts';
import {
  createBuildRunDomainResult,
  createDomainStreamingPipeline,
  createStreamingExecutionContext,
} from '../../../utils/xcodebuild-domain-results.ts';
import { createBuildInvocationFragment } from '../../../utils/xcodebuild-pipeline.ts';
import type { BuildInvocationRequest } from '../../../types/domain-fragments.ts';

const baseSchemaObject = z.object({
  packagePath: z.string(),
  executableName: z.string().optional(),
  arguments: z.array(z.string()).optional(),
  configuration: z.enum(['debug', 'release', 'Debug', 'Release']).optional(),
  timeout: z.number().optional(),
  background: z.boolean().optional(),
  parseAsLibrary: z.boolean().optional(),
});

const publicSchemaObject = baseSchemaObject.omit({
  configuration: true,
} as const);

type SwiftPackageRunParams = z.infer<typeof baseSchemaObject>;
type SwiftPackageRunResult = BuildRunResultDomainResult;

type SwiftPackageRunTimeoutResult = {
  success: boolean;
  output: string;
  error: string;
  timedOut: true;
};

function isTimedOutResult(
  result: CommandResponse | SwiftPackageRunTimeoutResult,
): result is SwiftPackageRunTimeoutResult {
  return 'timedOut' in result && result.timedOut;
}

async function resolveExecutablePath(
  executor: CommandExecutor,
  packagePath: string,
  executableName: string,
  configuration?: SwiftPackageRunParams['configuration'],
): Promise<string | null> {
  const command = ['swift', 'build', '--package-path', packagePath, '--show-bin-path'];
  if (configuration?.toLowerCase() === 'release') {
    command.push('-c', 'release');
  }

  const result = await executor(command, 'Swift Package Run (Resolve Executable Path)', false);
  if (!result.success) {
    return null;
  }

  const binPath = result.output.trim();
  if (!binPath) {
    return null;
  }

  return path.join(binPath, executableName);
}

const STRUCTURED_OUTPUT_SCHEMA = 'mobilebuildmcp.output.build-run-result';

function createRunSpmInvocationRequest(
  resolvedPath: string,
  executableName: string,
): BuildInvocationRequest {
  return {
    packagePath: resolvedPath,
    executableName,
    target: 'swift-package' as const,
  };
}

export async function swift_package_runLogic(
  params: SwiftPackageRunParams,
  executor: CommandExecutor,
): Promise<void> {
  const ctx = getHandlerContext();
  const resolvedPath = path.resolve(params.packagePath);
  const invocationRequest = createRunSpmInvocationRequest(
    resolvedPath,
    params.executableName ?? path.basename(resolvedPath),
  );
  ctx.emit(createBuildInvocationFragment('build-run-result', 'BUILD', invocationRequest));
  const executionContext = createStreamingExecutionContext(ctx);
  const executeSwiftPackageRun = createSwiftPackageRunExecutor(executor, invocationRequest);
  const result = await executeSwiftPackageRun(params, executionContext);

  setStructuredOutput(ctx, result);

  if (result.didError) {
    log('error', `Swift run failed: ${result.error ?? 'Unknown error'}`);
    return;
  }

  if (params.background) {
    const processId = getProcessId(result);
    if (processId !== undefined) {
      ctx.nextStepParams = { swift_package_stop: { pid: processId } };
    }
  }
}

function getProcessId(result: SwiftPackageRunResult): number | undefined {
  return 'processId' in result.artifacts ? result.artifacts.processId : undefined;
}

function setStructuredOutput(ctx: ToolHandlerContext, result: SwiftPackageRunResult): void {
  ctx.structuredOutput = {
    result,
    schema: STRUCTURED_OUTPUT_SCHEMA,
    schemaVersion: '2',
  };
}

export function createSwiftPackageRunExecutor(
  executor: CommandExecutor,
  request?: BuildInvocationRequest,
): StreamingExecutor<SwiftPackageRunParams, SwiftPackageRunResult> {
  return async (params, ctx) => {
    const resolvedPath = path.resolve(params.packagePath);
    const resolvedRequest =
      request ??
      createRunSpmInvocationRequest(
        resolvedPath,
        params.executableName ?? path.basename(resolvedPath),
      );
    const started = createDomainStreamingPipeline('build_run_spm', 'BUILD', ctx);
    const timeout = Math.min(params.timeout ?? 30, 300) * 1000;
    const swiftArgs = ['run', '--package-path', resolvedPath];
    const executableName = params.executableName ?? path.basename(resolvedPath);

    if (params.configuration?.toLowerCase() === 'release') {
      swiftArgs.push('-c', 'release');
    } else if (params.configuration && params.configuration.toLowerCase() !== 'debug') {
      return createBuildRunDomainResult({
        started,
        succeeded: false,
        target: 'swift-package',
        artifacts: {
          packagePath: resolvedPath,
        },
        fallbackErrorMessages: ["Invalid configuration. Use 'debug' or 'release'."],
        request: resolvedRequest,
      });
    }

    if (params.parseAsLibrary) {
      swiftArgs.push('-Xswiftc', '-parse-as-library');
    }

    if (params.executableName) {
      swiftArgs.push(params.executableName);
    }

    if (params.arguments && params.arguments.length > 0) {
      swiftArgs.push('--');
      swiftArgs.push(...params.arguments);
    }

    log('info', `Running swift ${swiftArgs.join(' ')}`);

    try {
      if (params.background) {
        const command = ['swift', ...swiftArgs];
        const cleanEnv = Object.fromEntries(
          Object.entries(process.env).filter(([, value]) => value !== undefined),
        ) as Record<string, string>;
        const result = await executor(
          command,
          'Swift Package Run (Background)',
          false,
          { env: cleanEnv },
          true,
        );
        const executablePath = await resolveExecutablePath(
          executor,
          resolvedPath,
          executableName,
          params.configuration,
        );

        if (!result.success) {
          return createBuildRunDomainResult({
            started,
            succeeded: false,
            target: 'swift-package',
            artifacts: {
              packagePath: resolvedPath,
              buildLogPath: started.pipeline.logPath,
            },
            fallbackErrorMessages: [result.error ?? result.output ?? 'Unknown error'],
            request: resolvedRequest,
          });
        }

        if (result.process?.pid) {
          addProcess(result.process.pid, {
            process: {
              kill: (signal?: string) => {
                if (result.process) {
                  result.process.kill(signal as NodeJS.Signals);
                }
              },
              on: (event: string, callback: () => void) => {
                if (result.process) {
                  result.process.on(event, callback);
                }
              },
              pid: result.process.pid,
            },
            startedAt: new Date(),
            executableName: params.executableName,
            packagePath: resolvedPath,
            releaseActivity: acquireDaemonActivity('swift-package.background-process'),
          });

          return createBuildRunDomainResult({
            started,
            succeeded: true,
            target: 'swift-package',
            artifacts: {
              packagePath: resolvedPath,
              ...(executablePath ? { executablePath } : {}),
              processId: result.process.pid,
              buildLogPath: started.pipeline.logPath,
            },
            output: { stdout: [], stderr: [] },
            request: resolvedRequest,
          });
        }

        return createBuildRunDomainResult({
          started,
          succeeded: true,
          target: 'swift-package',
          artifacts: {
            packagePath: resolvedPath,
            ...(executablePath ? { executablePath } : {}),
            buildLogPath: started.pipeline.logPath,
          },
          output: { stdout: [], stderr: [] },
          request: resolvedRequest,
        });
      }

      const command = ['swift', ...swiftArgs];
      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];

      let timeoutHandle: NodeJS.Timeout | undefined;
      const commandPromise = executor(command, 'Swift Package Run', false, {
        onStdout: (chunk: string) => {
          stdoutChunks.push(chunk);
          started.pipeline.onStdout(chunk);
        },
        onStderr: (chunk: string) => {
          stderrChunks.push(chunk);
          started.pipeline.onStderr(chunk);
        },
      });

      const timeoutPromise = new Promise<SwiftPackageRunTimeoutResult>((resolve) => {
        timeoutHandle = setTimeout(() => {
          resolve({
            success: false,
            output: '',
            error: `Process timed out after ${timeout / 1000} seconds`,
            timedOut: true,
          });
        }, timeout);
      });

      const result = await Promise.race([commandPromise, timeoutPromise]);
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }

      if (isTimedOutResult(result)) {
        return createBuildRunDomainResult({
          started,
          succeeded: false,
          target: 'swift-package',
          artifacts: {
            packagePath: resolvedPath,
            buildLogPath: started.pipeline.logPath,
          },
          fallbackErrorMessages: [result.error],
          request: resolvedRequest,
        });
      }

      const executablePath = await resolveExecutablePath(
        executor,
        resolvedPath,
        executableName,
        params.configuration,
      );

      if (!result.success) {
        return createBuildRunDomainResult({
          started,
          succeeded: false,
          target: 'swift-package',
          artifacts: {
            packagePath: resolvedPath,
            buildLogPath: started.pipeline.logPath,
          },
          fallbackErrorMessages: [result.error ?? result.output ?? 'Unknown error'],
          request: resolvedRequest,
        });
      }

      const stdout = stdoutChunks
        .join('')
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0);
      const stderr = stderrChunks
        .join('')
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0);

      return createBuildRunDomainResult({
        started,
        succeeded: true,
        target: 'swift-package',
        artifacts: {
          packagePath: resolvedPath,
          ...(executablePath ? { executablePath } : {}),
          ...(result.process?.pid ? { processId: result.process.pid } : {}),
          buildLogPath: started.pipeline.logPath,
        },
        output: {
          stdout,
          stderr,
        },
        request: resolvedRequest,
      });
    } catch (error) {
      return createBuildRunDomainResult({
        started,
        succeeded: false,
        target: 'swift-package',
        artifacts: {
          packagePath: resolvedPath,
          buildLogPath: started.pipeline.logPath,
        },
        fallbackErrorMessages: [toErrorMessage(error)],
        request: resolvedRequest,
      });
    }
  };
}

export const schema = getSessionAwareToolSchemaShape({
  sessionAware: publicSchemaObject,
  legacy: baseSchemaObject,
});

export const handler = createSessionAwareTool<SwiftPackageRunParams>({
  internalSchema: baseSchemaObject,
  logicFunction: swift_package_runLogic,
  getExecutor: getDefaultCommandExecutor,
});
