/**
 * Coverage Tool: Get Coverage Report
 *
 * Shows overall per-target code coverage from an xcresult bundle.
 * Uses `xcrun xccov view --report` to extract coverage data.
 */

import * as z from 'zod';
import type { ToolHandlerContext } from '../../../rendering/types.ts';
import type { BasicDiagnostics, CoverageResultDomainResult } from '../../../types/domain-results.ts';
import type { NonStreamingExecutor } from '../../../types/tool-execution.ts';
import { log } from '../../../utils/logging/index.ts';
import { validateFileExists } from '../../../utils/validation.ts';
import type { CommandExecutor, FileSystemExecutor } from '../../../utils/execution/index.ts';
import {
  getDefaultCommandExecutor,
  getDefaultFileSystemExecutor,
} from '../../../utils/execution/index.ts';
import {
  createTypedToolWithContext,
  getHandlerContext,
} from '../../../utils/typed-tool-factory.ts';
import { createBasicDiagnostics, diagnosticsFromCommandFailure } from '../../../utils/diagnostics.ts';

const getCoverageReportSchema = z.object({
  xcresultPath: z.string().describe('Path to the .xcresult bundle'),
  target: z.string().optional().describe('Filter results to a specific target name'),
  showFiles: z
    .boolean()
    .optional()
    .default(false)
    .describe('When true, include per-file coverage breakdown under each target'),
});

type GetCoverageReportParams = z.infer<typeof getCoverageReportSchema>;
type CoverageReportTargetFile = {
  name: string;
  path?: string;
  coveragePct: number;
  coveredLines: number;
  executableLines: number;
};
type CoverageReportTargetResult = {
  name: string;
  coveragePct: number;
  coveredLines: number;
  executableLines: number;
  files?: CoverageReportTargetFile[];
};
type GetCoverageReportResult = CoverageResultDomainResult & {
  targets?: CoverageReportTargetResult[];
};

interface CoverageFile {
  coveredLines: number;
  executableLines: number;
  lineCoverage: number;
  name: string;
  path: string;
}

interface CoverageTarget {
  coveredLines: number;
  executableLines: number;
  lineCoverage: number;
  name: string;
  files?: CoverageFile[];
}

function isValidCoverageTarget(value: unknown): value is CoverageTarget {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as CoverageTarget).name === 'string' &&
    typeof (value as CoverageTarget).coveredLines === 'number' &&
    typeof (value as CoverageTarget).executableLines === 'number' &&
    typeof (value as CoverageTarget).lineCoverage === 'number'
  );
}

type GetCoverageReportContext = {
  executor: CommandExecutor;
  fileSystem: FileSystemExecutor;
};

function createCoverageReportResult(params: {
  xcresultPath: string;
  didError: boolean;
  error?: string;
  target?: string;
  coveragePct?: number;
  coveredLines?: number;
  executableLines?: number;
  targets?: CoverageReportTargetResult[];
  diagnostics?: BasicDiagnostics;
}): GetCoverageReportResult {
  return {
    kind: 'coverage-result',
    didError: params.didError,
    error: params.error ?? null,
    summary: {
      status: params.didError ? 'FAILED' : 'SUCCEEDED',
      ...(typeof params.coveragePct === 'number' ? { coveragePct: params.coveragePct } : {}),
      ...(typeof params.coveredLines === 'number' ? { coveredLines: params.coveredLines } : {}),
      ...(typeof params.executableLines === 'number'
        ? { executableLines: params.executableLines }
        : {}),
    },
    coverageScope: 'report',
    artifacts: {
      xcresultPath: params.xcresultPath,
      ...(params.target ? { target: params.target } : {}),
    },
    ...(params.targets ? { targets: params.targets } : {}),
    ...(params.diagnostics ? { diagnostics: params.diagnostics } : {}),
  };
}

function setStructuredOutput(ctx: ToolHandlerContext, result: GetCoverageReportResult): void {
  ctx.structuredOutput = {
    result,
    schema: 'mobilebuildmcp.output.coverage-result',
    schemaVersion: '2',
  };
}

export function createGetCoverageReportExecutor(
  context: GetCoverageReportContext,
): NonStreamingExecutor<GetCoverageReportParams, GetCoverageReportResult> {
  return async (params) => {
    const { xcresultPath, target, showFiles } = params;

    const fileExistsValidation = validateFileExists(xcresultPath, context.fileSystem);
    if (!fileExistsValidation.isValid) {
      return createCoverageReportResult({
        xcresultPath,
        didError: true,
        error: fileExistsValidation.errorMessage!,
        diagnostics: createBasicDiagnostics({ errors: [fileExistsValidation.errorMessage!] }),
      });
    }

    log('info', `Getting coverage report from: ${xcresultPath}`);

    const cmd = ['xcrun', 'xccov', 'view', '--report'];
    if (!showFiles) {
      cmd.push('--only-targets');
    }
    cmd.push('--json', xcresultPath);

    const commandResult = await context.executor(cmd, 'Get Coverage Report', false);
    if (!commandResult.success) {
      return createCoverageReportResult({
        xcresultPath,
        didError: true,
        error: 'Failed to get coverage report.',
        diagnostics: diagnosticsFromCommandFailure(commandResult),
      });
    }

    let data: unknown;
    try {
      data = JSON.parse(commandResult.output);
    } catch {
      return createCoverageReportResult({
        xcresultPath,
        didError: true,
        error: 'Failed to parse coverage JSON output.',
        diagnostics: createBasicDiagnostics({
          errors: ['Failed to parse coverage JSON output.'],
          rawOutput: commandResult.output,
        }),
      });
    }

    let rawTargets: unknown[] = [];
    if (Array.isArray(data)) {
      rawTargets = data;
    } else if (
      typeof data === 'object' &&
      data !== null &&
      'targets' in data &&
      Array.isArray((data as { targets: unknown }).targets)
    ) {
      rawTargets = (data as { targets: unknown[] }).targets;
    } else {
      return createCoverageReportResult({
        xcresultPath,
        didError: true,
        error: 'Unexpected coverage data format.',
        diagnostics: createBasicDiagnostics({
          errors: ['Unexpected coverage data format.'],
          rawOutput: commandResult.output,
        }),
      });
    }

    let targets = rawTargets.filter(isValidCoverageTarget);
    if (target) {
      const lowerTarget = target.toLowerCase();
      targets = targets.filter((entry) => entry.name.toLowerCase().includes(lowerTarget));
      if (targets.length === 0) {
        return createCoverageReportResult({
          xcresultPath,
          didError: true,
          error: `No targets found matching "${target}".`,
          target,
          diagnostics: createBasicDiagnostics({ errors: [`No targets found matching "${target}".`] }),
        });
      }
    }

    if (targets.length === 0) {
      return createCoverageReportResult({
        xcresultPath,
        didError: true,
        error: 'No coverage data found in the xcresult bundle.',
        diagnostics: createBasicDiagnostics({
          errors: ['No coverage data found in the xcresult bundle.'],
        }),
      });
    }

    let totalCovered = 0;
    let totalExecutable = 0;
    for (const entry of targets) {
      totalCovered += entry.coveredLines;
      totalExecutable += entry.executableLines;
    }
    const overallPct = totalExecutable > 0 ? (totalCovered / totalExecutable) * 100 : 0;

    targets.sort((a, b) => a.lineCoverage - b.lineCoverage);

    return createCoverageReportResult({
      xcresultPath,
      didError: false,
      target,
      coveragePct: Number(overallPct.toFixed(1)),
      coveredLines: totalCovered,
      executableLines: totalExecutable,
      targets: targets.map((entry) => ({
        name: entry.name,
        coveragePct: Number((entry.lineCoverage * 100).toFixed(1)),
        coveredLines: entry.coveredLines,
        executableLines: entry.executableLines,
        ...(showFiles && entry.files?.length
          ? {
              files: [...entry.files]
                .sort((left, right) => left.lineCoverage - right.lineCoverage)
                .map((fileEntry) => ({
                  name: fileEntry.name,
                  path: fileEntry.path,
                  coveragePct: Number((fileEntry.lineCoverage * 100).toFixed(1)),
                  coveredLines: fileEntry.coveredLines,
                  executableLines: fileEntry.executableLines,
                })),
            }
          : {}),
      })),
    });
  };
}

export async function get_coverage_reportLogic(
  params: GetCoverageReportParams,
  context: GetCoverageReportContext,
): Promise<void> {
  const ctx = getHandlerContext();
  const { xcresultPath } = params;
  const executeGetCoverageReport = createGetCoverageReportExecutor(context);
  const result = await executeGetCoverageReport(params);

  setStructuredOutput(ctx, result);
  if (!result.didError) {
    ctx.nextStepParams = {
      get_file_coverage: { xcresultPath },
    };
  }
}

export const schema = getCoverageReportSchema.shape;

export const handler = createTypedToolWithContext(
  getCoverageReportSchema,
  get_coverage_reportLogic,
  () => ({
    executor: getDefaultCommandExecutor(),
    fileSystem: getDefaultFileSystemExecutor(),
  }),
);
