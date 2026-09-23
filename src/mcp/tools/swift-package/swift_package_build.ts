import * as z from 'zod';
import path from 'node:path';
import type { ToolHandlerContext } from '../../../rendering/types.ts';
import type { BuildResultDomainResult } from '../../../types/domain-results.ts';
import type { StreamingExecutor } from '../../../types/tool-execution.ts';
import { log } from '../../../utils/logging/index.ts';
import type { CommandExecutor } from '../../../utils/execution/index.ts';
import { getDefaultCommandExecutor } from '../../../utils/execution/index.ts';
import {
  createSessionAwareTool,
  getSessionAwareToolSchemaShape,
  getHandlerContext,
} from '../../../utils/typed-tool-factory.ts';
import { createBuildInvocationFragment } from '../../../utils/xcodebuild-pipeline.ts';
import type { BuildInvocationRequest } from '../../../types/domain-fragments.ts';
import {
  createBuildDomainResult,
  createStreamingExecutionContext,
  createDomainStreamingPipeline,
} from '../../../utils/xcodebuild-domain-results.ts';
import { toErrorMessage } from '../../../utils/errors.ts';

const STRUCTURED_OUTPUT_SCHEMA = 'mobilebuildmcp.output.build-result';

const baseSchemaObject = z.object({
  packagePath: z.string(),
  targetName: z.string().optional(),
  configuration: z.enum(['debug', 'release', 'Debug', 'Release']).optional(),
  architectures: z.array(z.string()).optional(),
  parseAsLibrary: z.boolean().optional(),
});

const publicSchemaObject = baseSchemaObject.omit({
  configuration: true,
} as const);

const swiftPackageBuildSchema = baseSchemaObject;

type SwiftPackageBuildParams = z.infer<typeof swiftPackageBuildSchema>;
type SwiftPackageBuildResult = BuildResultDomainResult;

function setStructuredOutput(ctx: ToolHandlerContext, result: SwiftPackageBuildResult): void {
  ctx.structuredOutput = {
    result,
    schema: STRUCTURED_OUTPUT_SCHEMA,
    schemaVersion: '2',
  };
}

function createBuildSpmInvocationRequest(
  resolvedPath: string,
  params: SwiftPackageBuildParams,
): BuildInvocationRequest {
  return {
    packagePath: resolvedPath,
    ...(params.targetName ? { targetName: params.targetName } : {}),
    ...(params.configuration ? { configuration: params.configuration } : {}),
    target: 'swift-package' as const,
  };
}

export function createSwiftPackageBuildExecutor(
  executor: CommandExecutor,
  request?: BuildInvocationRequest,
): StreamingExecutor<SwiftPackageBuildParams, SwiftPackageBuildResult> {
  return async (params, ctx) => {
    const resolvedPath = path.resolve(params.packagePath);
    const resolvedRequest = request ?? createBuildSpmInvocationRequest(resolvedPath, params);
    const swiftArgs = ['build', '--package-path', resolvedPath];

    if (params.configuration?.toLowerCase() === 'release') {
      swiftArgs.push('-c', 'release');
    }

    if (params.targetName) {
      swiftArgs.push('--target', params.targetName);
    }

    if (params.architectures) {
      for (const arch of params.architectures) {
        swiftArgs.push('--arch', arch);
      }
    }

    if (params.parseAsLibrary) {
      swiftArgs.push('-Xswiftc', '-parse-as-library');
    }

    log('info', `Running swift ${swiftArgs.join(' ')}`);

    const started = createDomainStreamingPipeline('build_spm', 'BUILD', ctx, 'build-result');

    try {
      const result = await executor(['swift', ...swiftArgs], 'Swift Package Build', false, {
        onStdout: (chunk: string) => started.pipeline.onStdout(chunk),
        onStderr: (chunk: string) => started.pipeline.onStderr(chunk),
      });

      const failureMessage = result.error || result.output || 'Unknown error';
      return createBuildDomainResult({
        started,
        succeeded: result.success,
        target: 'swift-package',
        artifacts: {
          packagePath: resolvedPath,
          buildLogPath: started.pipeline.logPath,
        },
        fallbackErrorMessages: [...started.stderrLines, failureMessage],
        request: resolvedRequest,
      });
    } catch (error) {
      const message = toErrorMessage(error);
      return createBuildDomainResult({
        started,
        succeeded: false,
        target: 'swift-package',
        artifacts: {
          packagePath: resolvedPath,
          buildLogPath: started.pipeline.logPath,
        },
        fallbackErrorMessages: [...started.stderrLines, message],
        request: resolvedRequest,
      });
    }
  };
}

export async function swift_package_buildLogic(
  params: SwiftPackageBuildParams,
  executor: CommandExecutor,
): Promise<void> {
  const ctx = getHandlerContext();
  const resolvedPath = path.resolve(params.packagePath);

  const invocationRequest = createBuildSpmInvocationRequest(resolvedPath, params);
  ctx.emit(createBuildInvocationFragment('build-result', 'BUILD', invocationRequest));
  const executionContext = createStreamingExecutionContext(ctx);
  const executeSwiftPackageBuild = createSwiftPackageBuildExecutor(executor, invocationRequest);
  const result = await executeSwiftPackageBuild(params, executionContext);

  setStructuredOutput(ctx, result);
}

export const schema = getSessionAwareToolSchemaShape({
  sessionAware: publicSchemaObject,
  legacy: baseSchemaObject,
});

export const handler = createSessionAwareTool<SwiftPackageBuildParams>({
  internalSchema: swiftPackageBuildSchema,
  logicFunction: swift_package_buildLogic,
  getExecutor: getDefaultCommandExecutor,
});
