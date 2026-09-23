/**
 * Coverage Tool: Get File Coverage
 *
 * Shows function-level coverage and optionally uncovered line ranges
 * for a specific file from an xcresult bundle.
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

const getFileCoverageSchema = z.object({
  xcresultPath: z.string().describe('Path to the .xcresult bundle'),
  file: z.string().describe('Source file name or path to inspect'),
  showLines: z
    .boolean()
    .optional()
    .default(false)
    .describe('When true, include uncovered line ranges from the archive'),
});

type GetFileCoverageParams = z.infer<typeof getFileCoverageSchema>;
type GetFileCoverageResult = CoverageResultDomainResult & {
  uncoveredLineRanges?: LineRange[];
};

interface CoverageFunction {
  coveredLines: number;
  executableLines: number;
  executionCount: number;
  lineCoverage: number;
  lineNumber: number;
  name: string;
}

interface RawFileEntry {
  file?: string;
  path?: string;
  name?: string;
  coveredLines?: number;
  executableLines?: number;
  lineCoverage?: number;
  functions?: CoverageFunction[];
}

interface FileFunctionCoverage {
  filePath: string;
  coveredLines: number;
  executableLines: number;
  lineCoverage: number;
  functions: CoverageFunction[];
}

function normalizeFileEntry(raw: RawFileEntry): FileFunctionCoverage {
  const functions = raw.functions ?? [];
  const coveredLines =
    raw.coveredLines ?? functions.reduce((sum, fn) => sum + fn.coveredLines, 0);
  const executableLines =
    raw.executableLines ?? functions.reduce((sum, fn) => sum + fn.executableLines, 0);
  const lineCoverage =
    raw.lineCoverage ?? (executableLines > 0 ? coveredLines / executableLines : 0);
  const filePath = raw.file ?? raw.path ?? raw.name ?? 'unknown';
  return { filePath, coveredLines, executableLines, lineCoverage, functions };
}

type GetFileCoverageContext = {
  executor: CommandExecutor;
  fileSystem: FileSystemExecutor;
};

interface LineRange {
  start: number;
  end: number;
}

function createFileCoverageResult(params: {
  xcresultPath: string;
  file: string;
  didError: boolean;
  error?: string;
  sourceFilePath?: string;
  coveragePct?: number;
  coveredLines?: number;
  executableLines?: number;
  functions?: NonNullable<GetFileCoverageResult['functions']>;
  diagnostics?: BasicDiagnostics;
  uncoveredLineRanges?: LineRange[];
}): GetFileCoverageResult {
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
    coverageScope: 'file',
    artifacts: {
      xcresultPath: params.xcresultPath,
      file: params.file,
      ...(params.sourceFilePath ? { sourceFilePath: params.sourceFilePath } : {}),
    },
    ...(params.functions ? { functions: params.functions } : {}),
    ...(params.diagnostics ? { diagnostics: params.diagnostics } : {}),
    ...(params.uncoveredLineRanges !== undefined
      ? { uncoveredLineRanges: params.uncoveredLineRanges }
      : {}),
  };
}

function setStructuredOutput(ctx: ToolHandlerContext, result: GetFileCoverageResult): void {
  ctx.structuredOutput = {
    result,
    schema: 'mobilebuildmcp.output.coverage-result',
    schemaVersion: '2',
  };
}

function buildCoverageFunctions(entry: FileFunctionCoverage): NonNullable<GetFileCoverageResult['functions']> {
  const notCovered = entry.functions
    .filter((fn) => fn.coveredLines === 0)
    .sort((a, b) => b.executableLines - a.executableLines || a.lineNumber - b.lineNumber)
    .map((fn) => ({
      line: fn.lineNumber,
      name: fn.name,
      coveredLines: fn.coveredLines,
      executableLines: fn.executableLines,
    }));

  const partialCoverage = entry.functions
    .filter((fn) => fn.coveredLines > 0 && fn.coveredLines < fn.executableLines)
    .sort((a, b) => a.lineCoverage - b.lineCoverage || a.lineNumber - b.lineNumber)
    .map((fn) => ({
      line: fn.lineNumber,
      name: fn.name,
      coveragePct: Number((fn.lineCoverage * 100).toFixed(1)),
      coveredLines: fn.coveredLines,
      executableLines: fn.executableLines,
    }));

  const fullCoverageCount = entry.functions.filter(
    (fn) => fn.executableLines > 0 && fn.coveredLines === fn.executableLines,
  ).length;

  return {
    ...(notCovered.length > 0 ? { notCovered } : {}),
    ...(partialCoverage.length > 0 ? { partialCoverage } : {}),
    fullCoverageCount,
    notCoveredFunctionCount: notCovered.length,
    notCoveredLineCount: notCovered.reduce((sum, fn) => sum + fn.executableLines, 0),
    partialCoverageFunctionCount: partialCoverage.length,
  };
}

export function createGetFileCoverageExecutor(
  context: GetFileCoverageContext,
): NonStreamingExecutor<GetFileCoverageParams, GetFileCoverageResult> {
  return async (params) => {
    const { xcresultPath, file, showLines } = params;

    const fileExistsValidation = validateFileExists(xcresultPath, context.fileSystem);
    if (!fileExistsValidation.isValid) {
      return createFileCoverageResult({
        xcresultPath,
        file,
        didError: true,
        error: fileExistsValidation.errorMessage!,
        diagnostics: createBasicDiagnostics({ errors: [fileExistsValidation.errorMessage!] }),
      });
    }

    log('info', `Getting file coverage for "${file}" from: ${xcresultPath}`);

    const funcResult = await context.executor(
      ['xcrun', 'xccov', 'view', '--report', '--functions-for-file', file, '--json', xcresultPath],
      'Get File Function Coverage',
      false,
    );

    if (!funcResult.success) {
      return createFileCoverageResult({
        xcresultPath,
        file,
        didError: true,
        error: 'Failed to get file coverage.',
        diagnostics: diagnosticsFromCommandFailure(funcResult),
      });
    }

    let data: unknown;
    try {
      data = JSON.parse(funcResult.output);
    } catch {
      return createFileCoverageResult({
        xcresultPath,
        file,
        didError: true,
        error: 'Failed to parse coverage JSON output.',
        diagnostics: createBasicDiagnostics({
          errors: ['Failed to parse coverage JSON output.'],
          rawOutput: funcResult.output,
        }),
      });
    }

    let fileEntries: FileFunctionCoverage[] = [];

    if (Array.isArray(data)) {
      fileEntries = (data as RawFileEntry[]).map(normalizeFileEntry);
    } else if (
      typeof data === 'object' &&
      data !== null &&
      'targets' in data &&
      Array.isArray((data as { targets: unknown }).targets)
    ) {
      const targets = (data as { targets: unknown[] }).targets;
      for (const targetEntry of targets) {
        if (typeof targetEntry !== 'object' || targetEntry === null) continue;
        const target = targetEntry as { files?: RawFileEntry[] };
        if (target.files) {
          fileEntries.push(...target.files.map(normalizeFileEntry));
        }
      }
    }

    if (fileEntries.length === 0) {
      return createFileCoverageResult({
        xcresultPath,
        file,
        didError: true,
        error: `No coverage data found for "${file}".`,
        diagnostics: createBasicDiagnostics({ errors: [`No coverage data found for "${file}".`] }),
      });
    }

    const entry = fileEntries[0];
    const functions = buildCoverageFunctions(entry);
    let uncoveredLineRanges: LineRange[] | undefined;

    if (showLines) {
      const filePath = entry.filePath !== 'unknown' ? entry.filePath : file;
      const archiveResult = await context.executor(
        ['xcrun', 'xccov', 'view', '--archive', '--file', filePath, xcresultPath],
        'Get File Line Coverage',
        false,
      );

      if (archiveResult.success && archiveResult.output) {
        uncoveredLineRanges = parseUncoveredLines(archiveResult.output);
      }
    }

    return createFileCoverageResult({
      xcresultPath,
      file,
      didError: false,
      sourceFilePath: entry.filePath !== 'unknown' ? entry.filePath : undefined,
      coveragePct: Number((entry.lineCoverage * 100).toFixed(1)),
      coveredLines: entry.coveredLines,
      executableLines: entry.executableLines,
      functions,
      ...(uncoveredLineRanges !== undefined ? { uncoveredLineRanges } : {}),
    });
  };
}

export async function get_file_coverageLogic(
  params: GetFileCoverageParams,
  context: GetFileCoverageContext,
): Promise<void> {
  const ctx = getHandlerContext();
  const { xcresultPath } = params;
  const executeGetFileCoverage = createGetFileCoverageExecutor(context);
  const result = await executeGetFileCoverage(params);

  setStructuredOutput(ctx, result);
  if (!result.didError) {
    ctx.nextStepParams = {
      get_coverage_report: { xcresultPath },
    };
  }
}

/**
 * Parse xccov archive output to find uncovered line ranges.
 * Each line starts with the line number, a colon, and a count (0 = uncovered, * = non-executable).
 * Example:
 *   1: *
 *   2: 1
 *   3: 0
 *   4: 0
 *   5: 1
 * Lines with count 0 are uncovered.
 */
function parseUncoveredLines(output: string): LineRange[] {
  const ranges: LineRange[] = [];
  let currentRange: LineRange | null = null;

  for (const line of output.split('\n')) {
    const match = line.match(/^\s*(\d+):\s+(\S+)/);
    if (!match) continue;

    const lineNum = parseInt(match[1], 10);
    const count = match[2];

    if (count === '0') {
      if (currentRange) {
        currentRange.end = lineNum;
      } else {
        currentRange = { start: lineNum, end: lineNum };
      }
    } else if (currentRange) {
      ranges.push(currentRange);
      currentRange = null;
    }
  }

  if (currentRange) {
    ranges.push(currentRange);
  }

  return ranges;
}

export const schema = getFileCoverageSchema.shape;

export const handler = createTypedToolWithContext(
  getFileCoverageSchema,
  get_file_coverageLogic,
  () => ({
    executor: getDefaultCommandExecutor(),
    fileSystem: getDefaultFileSystemExecutor(),
  }),
);
