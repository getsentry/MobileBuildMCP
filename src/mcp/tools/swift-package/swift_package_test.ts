import * as z from 'zod';
import path from 'node:path';
import type { ToolHandlerContext } from '../../../rendering/types.ts';
import type { TestResultDomainResult } from '../../../types/domain-results.ts';
import type { StreamingExecutor } from '../../../types/tool-execution.ts';
import type { CommandExecutor } from '../../../utils/execution/index.ts';
import { getDefaultCommandExecutor } from '../../../utils/execution/index.ts';
import { log } from '../../../utils/logging/index.ts';
import {
  createSessionAwareTool,
  getSessionAwareToolSchemaShape,
  getHandlerContext,
} from '../../../utils/typed-tool-factory.ts';
import { createBuildInvocationFragment } from '../../../utils/xcodebuild-pipeline.ts';
import type { BuildInvocationRequest } from '../../../types/domain-fragments.ts';
import {
  createStreamingExecutionContext,
  createDomainStreamingPipeline,
  createTestDomainResult,
} from '../../../utils/xcodebuild-domain-results.ts';
import { toErrorMessage } from '../../../utils/errors.ts';

const STRUCTURED_OUTPUT_SCHEMA = 'mobilebuildmcp.output.test-result';

const baseSchemaObject = z.object({
  packagePath: z.string(),
  testProduct: z.string().optional(),
  filter: z.string().optional().describe('regex: pattern'),
  configuration: z.enum(['debug', 'release', 'Debug', 'Release']).optional(),
  parallel: z.boolean().optional(),
  showCodecov: z.boolean().optional(),
  parseAsLibrary: z.boolean().optional(),
});

const publicSchemaObject = baseSchemaObject.omit({
  configuration: true,
} as const);

const swiftPackageTestSchema = baseSchemaObject;

type SwiftPackageTestParams = z.infer<typeof swiftPackageTestSchema>;
type SwiftPackageTestResult = TestResultDomainResult;

function setStructuredOutput(ctx: ToolHandlerContext, result: SwiftPackageTestResult): void {
  ctx.structuredOutput = {
    result,
    schema: STRUCTURED_OUTPUT_SCHEMA,
    schemaVersion: '2',
  };
}

function createTestSpmInvocationRequest(
  resolvedPath: string,
  params: SwiftPackageTestParams,
): BuildInvocationRequest {
  return {
    scheme: path.basename(resolvedPath),
    configuration: (params.configuration ?? 'debug').toLowerCase(),
    platform: 'Swift Package',
    target: 'swift-package' as const,
  };
}

function getFallbackErrorMessages(
  started: ReturnType<typeof createDomainStreamingPipeline>,
  extraMessages: string[] = [],
): string[] {
  return [...started.stderrLines, ...extraMessages];
}

export function createSwiftPackageTestExecutor(
  executor: CommandExecutor,
  request?: BuildInvocationRequest,
): StreamingExecutor<SwiftPackageTestParams, SwiftPackageTestResult> {
  return async (params, ctx) => {
    const resolvedPath = path.resolve(params.packagePath);
    const resolvedRequest = request ?? createTestSpmInvocationRequest(resolvedPath, params);
    const swiftArgs = ['test', '--package-path', resolvedPath];
    const started = createDomainStreamingPipeline('swift_package_test', 'TEST', ctx, 'test-result');

    if (params.configuration?.toLowerCase() === 'release') {
      swiftArgs.push('-c', 'release');
    } else if (params.configuration && params.configuration.toLowerCase() !== 'debug') {
      return createTestDomainResult({
        started,
        succeeded: false,
        target: 'swift-package',
        artifacts: {
          buildLogPath: started.pipeline.logPath,
        },
        fallbackErrorMessages: ["Invalid configuration. Use 'debug' or 'release'."],
        request: resolvedRequest,
      });
    }

    if (params.testProduct) {
      swiftArgs.push('--test-product', params.testProduct);
    }

    if (params.filter) {
      swiftArgs.push('--filter', params.filter);
    }

    if (params.parallel === false) {
      swiftArgs.push('--no-parallel');
    }

    if (params.showCodecov) {
      swiftArgs.push('--show-code-coverage');
    }

    if (params.parseAsLibrary) {
      swiftArgs.push('-Xswiftc', '-parse-as-library');
    }

    log('info', `Running swift ${swiftArgs.join(' ')}`);

    try {
      const result = await executor(['swift', ...swiftArgs], 'Swift Package Test', false, {
        onStdout: (chunk: string) => started.pipeline.onStdout(chunk),
        onStderr: (chunk: string) => started.pipeline.onStderr(chunk),
      });

      const failureMessage = result.error || result.output || 'Unknown error';
      const shouldIncludePackagePath = /chdir error/i.test(failureMessage);

      return createTestDomainResult({
        started,
        succeeded: result.success,
        target: 'swift-package',
        artifacts: {
          buildLogPath: started.pipeline.logPath,
          ...(result.success || !shouldIncludePackagePath ? {} : { packagePath: resolvedPath }),
        },
        fallbackErrorMessages: getFallbackErrorMessages(started, [failureMessage]),
        request: resolvedRequest,
      });
    } catch (error) {
      const message = toErrorMessage(error);
      return createTestDomainResult({
        started,
        succeeded: false,
        target: 'swift-package',
        artifacts: {
          buildLogPath: started.pipeline.logPath,
          packagePath: resolvedPath,
        },
        fallbackErrorMessages: getFallbackErrorMessages(started, [message]),
        request: resolvedRequest,
      });
    }
  };
}

export async function swift_package_testLogic(
  params: SwiftPackageTestParams,
  executor: CommandExecutor,
): Promise<void> {
  const ctx = getHandlerContext();
  const resolvedPath = path.resolve(params.packagePath);

  const invocationRequest = createTestSpmInvocationRequest(resolvedPath, params);
  ctx.emit(createBuildInvocationFragment('test-result', 'TEST', invocationRequest));
  const executionContext = createStreamingExecutionContext(ctx);
  const executeSwiftPackageTest = createSwiftPackageTestExecutor(executor, invocationRequest);
  const result = await executeSwiftPackageTest(params, executionContext);

  setStructuredOutput(ctx, result);
}

export const schema = getSessionAwareToolSchemaShape({
  sessionAware: publicSchemaObject,
  legacy: baseSchemaObject,
});

export const handler = createSessionAwareTool<SwiftPackageTestParams>({
  internalSchema: swiftPackageTestSchema,
  logicFunction: swift_package_testLogic,
  getExecutor: getDefaultCommandExecutor,
});
