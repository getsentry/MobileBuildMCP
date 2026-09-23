import * as z from 'zod';
import path from 'node:path';
import type { ToolHandlerContext } from '../../../rendering/types.ts';
import type { BuildResultDomainResult } from '../../../types/domain-results.ts';
import type { NonStreamingExecutor } from '../../../types/tool-execution.ts';
import type { CommandExecutor } from '../../../utils/execution/index.ts';
import { getDefaultCommandExecutor } from '../../../utils/execution/index.ts';
import { log } from '../../../utils/logging/index.ts';
import { createTypedTool, getHandlerContext } from '../../../utils/typed-tool-factory.ts';
import { toErrorMessage } from '../../../utils/errors.ts';
import { createBasicDiagnostics } from '../../../utils/diagnostics.ts';

const STRUCTURED_OUTPUT_SCHEMA = 'mobilebuildmcp.output.build-result';

const swiftPackageCleanSchema = z.object({
  packagePath: z.string(),
});

type SwiftPackageCleanParams = z.infer<typeof swiftPackageCleanSchema>;
type SwiftPackageCleanResult = BuildResultDomainResult;

function setStructuredOutput(ctx: ToolHandlerContext, result: SwiftPackageCleanResult): void {
  ctx.structuredOutput = {
    result,
    schema: STRUCTURED_OUTPUT_SCHEMA,
    schemaVersion: '2',
  };
}

function createSwiftPackageCleanResult(
  resolvedPath: string,
  success: boolean,
  errorMessage?: string,
): SwiftPackageCleanResult {
  return {
    kind: 'build-result',
    didError: !success,
    error: success ? null : 'Swift package clean failed.',
    summary: {
      status: success ? 'SUCCEEDED' : 'FAILED',
      target: 'swift-package',
    },
    artifacts: {
      packagePath: resolvedPath,
    },
    diagnostics: createBasicDiagnostics({
      errors: success ? [] : [errorMessage ?? 'Unknown error'],
    }),
  };
}

export function createSwiftPackageCleanExecutor(
  executor: CommandExecutor,
): NonStreamingExecutor<SwiftPackageCleanParams, SwiftPackageCleanResult> {
  return async (params) => {
    const resolvedPath = path.resolve(params.packagePath);
    const swiftArgs = ['package', '--package-path', resolvedPath, 'clean'];

    log('info', `Running swift ${swiftArgs.join(' ')}`);

    try {
      const result = await executor(['swift', ...swiftArgs], 'Swift Package Clean', false);
      if (!result.success) {
        const errorMessage = result.error || result.output || 'Unknown error';
        return createSwiftPackageCleanResult(resolvedPath, false, errorMessage);
      }

      return createSwiftPackageCleanResult(resolvedPath, true);
    } catch (error) {
      const errorMessage = toErrorMessage(error);
      return createSwiftPackageCleanResult(resolvedPath, false, errorMessage);
    }
  };
}

export async function swift_package_cleanLogic(
  params: SwiftPackageCleanParams,
  executor: CommandExecutor,
): Promise<void> {
  const ctx = getHandlerContext();
  const executeSwiftPackageClean = createSwiftPackageCleanExecutor(executor);
  const result = await executeSwiftPackageClean(params);

  setStructuredOutput(ctx, result);
}

export const schema = swiftPackageCleanSchema.shape;

export const handler = createTypedTool(
  swiftPackageCleanSchema,
  swift_package_cleanLogic,
  getDefaultCommandExecutor,
);
