import type { XcodebuildOperation, XcodebuildStage } from '../types/domain-fragments.ts';
import type { BuildLikeKind, DomainFragment } from '../types/domain-fragments.ts';
import {
  packageResolutionPatterns,
  compilePatterns,
  linkPatterns,
  parseTestCaseLine,
  parseTotalsLine,
  parseFailureDiagnostic,
  parseBuildErrorDiagnostic,
  parseDurationMs,
  isBuildErrorDiagnosticLine,
  type ParsedTestCase,
} from './xcodebuild-line-parsers.ts';
import {
  parseSwiftTestingIssueLine,
  parseSwiftTestingResultLine,
  parseSwiftTestingRunSummary,
  parseSwiftTestingContinuationLine,
} from './swift-testing-line-parsers.ts';

function resolveStageFromLine(line: string): XcodebuildStage | null {
  if (packageResolutionPatterns.some((pattern) => pattern.test(line))) {
    return 'RESOLVING_PACKAGES';
  }
  if (compilePatterns.some((pattern) => pattern.test(line))) {
    return 'COMPILING';
  }
  if (linkPatterns.some((pattern) => pattern.test(line))) {
    return 'LINKING';
  }
  if (
    /^Testing started$/u.test(line) ||
    /^Test [Ss]uite .+ started/u.test(line) ||
    /^Test [Cc]ase .+ started/u.test(line) ||
    /^[◇] Test run started/u.test(line) ||
    /^[◇] Test .+ started/u.test(line) ||
    /^[◇] Test case .+ started/u.test(line)
  ) {
    return 'RUN_TESTS';
  }
  return null;
}

const stageMessages: Record<XcodebuildStage, string> = {
  RESOLVING_PACKAGES: 'Resolving packages',
  COMPILING: 'Compiling',
  LINKING: 'Linking',
  PREPARING_TESTS: 'Preparing tests',
  RUN_TESTS: 'Running tests',
  ARCHIVING: 'Archiving',
  COMPLETED: 'Completed',
};

function parseWarningLine(line: string): { location?: string; message: string } | null {
  const locationMatch = line.match(/^(.*?):(\d+)(?::\d+)?:\s+warning:\s+(.+)$/u);
  if (locationMatch) {
    return {
      location: `${locationMatch[1]}:${locationMatch[2]}`,
      message: locationMatch[3],
    };
  }

  const prefixedMatch = line.match(/^(?:[\w-]+:\s+)?warning:\s+(.+)$/iu);
  if (prefixedMatch) {
    return { message: prefixedMatch[1] };
  }

  return null;
}

const IGNORED_NOISE_PATTERNS = [
  /^Command line invocation:$/u,
  /^\s*\/Applications\/Xcode[^\s]+\/Contents\/Developer\/usr\/bin\/xcodebuild\b/u,
  /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+\s+xcodebuild\[.+\]\s+Writing error result bundle to\s+/u,
  /^Build settings from command line:$/u,
  /^(?:COMPILER_INDEX_STORE_ENABLE|ONLY_ACTIVE_ARCH)\s*=\s*.+$/u,
  /^\s*[A-Za-z0-9_.-]+:\s+https?:\/\/.+$/u,
  /^--- xcodebuild: WARNING: Using the first of multiple matching destinations:$/u,
  /^\{\s*platform:.+\}$/u,
  /^(?:ComputePackagePrebuildTargetDependencyGraph|Prepare packages|CreateBuildRequest|SendProjectDescription|CreateBuildOperation|ComputeTargetDependencyGraph|GatherProvisioningInputs|CreateBuildDescription)$/u,
  /^Target '.+' in project '.+' \(no dependencies\)$/u,
  /^(?:Build description signature|Build description path):\s+.+$/u,
  /^(?:ExecuteExternalTool|ClangStatCache|CopySwiftLibs|builtin-infoPlistUtility|builtin-swiftStdLibTool)\b/u,
  /^cd\s+.+$/u,
  /^\*\* BUILD SUCCEEDED \*\*$/u,
];

function isIgnoredNoiseLine(line: string): boolean {
  return IGNORED_NOISE_PATTERNS.some((pattern) => pattern.test(line));
}

function normalizeEventLine(rawLine: string): string {
  return rawLine.trim().replace(/^(?:\u200B|\u200C|\u200D|\uFEFF)+/u, '');
}

function parseXcresultPathLine(line: string): string | null {
  const resultBundleMessage = line.match(
    /(?:Writing error result bundle to|Writing result bundle to|Result bundle written to):?\s+(.+?\.xcresult)\s*$/u,
  );
  if (resultBundleMessage) {
    return resultBundleMessage[1];
  }

  const standalonePath = line.match(/^((?:\/|~\/|\.\.?\/)[^\n]*\.xcresult)\s*$/u);
  if (standalonePath && !/\s-[A-Za-z]/u.test(standalonePath[1])) {
    return standalonePath[1];
  }

  return null;
}

export interface EventParserOptions {
  operation: XcodebuildOperation;
  kind?: BuildLikeKind;
  onEvent: (fragment: DomainFragment) => void;
  onUnrecognizedLine?: (line: string) => void;
}

export interface XcodebuildEventParser {
  onStdout(chunk: string): void;
  onStderr(chunk: string): void;
  flush(): void;
  xcresultPath: string | null;
}

export function createXcodebuildEventParser(options: EventParserOptions): XcodebuildEventParser {
  const { operation, onEvent, onUnrecognizedLine } = options;
  const kind: BuildLikeKind =
    options.kind ?? (operation === 'TEST' ? 'test-result' : 'build-result');

  let stdoutBuffer = '';
  let stderrBuffer = '';
  let completedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  let testCasesCompletedSinceSwiftTestingSummary = 0;
  let issuesAccountedSinceSwiftTestingSummary = 0;
  let detectedXcresultPath: string | null = null;

  let pendingError: {
    message: string;
    location?: string;
    rawLines: string[];
  } | null = null;

  const pendingFailureDiagnostics = new Map<
    string,
    Array<{ suiteName?: string; testName?: string; message: string; location?: string }>
  >();
  const pendingFailureDurations = new Map<string, number>();

  function getFailureKey(suiteName?: string, testName?: string): string | null {
    if (!suiteName && !testName) {
      return null;
    }

    return `${suiteName ?? ''}::${testName ?? ''}`.trim().toLowerCase();
  }

  function emitFailureFragment(failure: {
    suiteName?: string;
    testName?: string;
    message: string;
    location?: string;
    durationMs?: number;
  }): void {
    if (operation !== 'TEST') {
      return;
    }

    onEvent({
      kind: 'test-result',
      fragment: 'test-failure',
      operation: 'TEST',
      suite: failure.suiteName,
      test: failure.testName,
      message: failure.message,
      location: failure.location,
      durationMs: failure.durationMs,
    });
  }

  function queueFailureDiagnostic(failure: {
    suiteName?: string;
    testName?: string;
    message: string;
    location?: string;
  }): void {
    const key = getFailureKey(failure.suiteName, failure.testName);
    if (!key) {
      emitFailureFragment(failure);
      return;
    }

    const durationMs = pendingFailureDurations.get(key);
    if (durationMs !== undefined) {
      pendingFailureDurations.delete(key);
      emitFailureFragment({ ...failure, durationMs });
      return;
    }

    const queued = pendingFailureDiagnostics.get(key) ?? [];
    queued.push(failure);
    pendingFailureDiagnostics.set(key, queued);
  }

  function flushQueuedFailureDiagnostics(): void {
    for (const [key, failures] of pendingFailureDiagnostics.entries()) {
      const durationMs = pendingFailureDurations.get(key);
      for (const failure of failures) {
        emitFailureFragment({ ...failure, durationMs });
      }
    }
    pendingFailureDiagnostics.clear();
  }

  function applyFailureDuration(suiteName?: string, testName?: string, durationMs?: number): void {
    const key = getFailureKey(suiteName, testName);
    if (!key || durationMs === undefined) {
      return;
    }

    pendingFailureDurations.set(key, durationMs);
    const pendingFailures = pendingFailureDiagnostics.get(key);
    if (!pendingFailures) {
      return;
    }

    for (const failure of pendingFailures) {
      emitFailureFragment({ ...failure, durationMs });
    }
    pendingFailureDiagnostics.delete(key);
    pendingFailureDurations.delete(key);
  }

  function emitTestProgress(): void {
    if (operation !== 'TEST') {
      return;
    }
    onEvent({
      kind: 'test-result',
      fragment: 'test-progress',
      operation: 'TEST',
      completed: completedCount,
      failed: failedCount,
      skipped: skippedCount,
    });
  }

  function recordTestCaseResult(
    testCase: ParsedTestCase,
    source: 'xcodebuild' | 'swift-testing' | 'swift-testing-native' = 'xcodebuild',
    issueCount = 1,
  ): void {
    const increment = 1;
    completedCount += increment;
    const durationMs = parseDurationMs(testCase.durationText);

    if (testCase.status === 'failed') {
      applyFailureDuration(testCase.suiteName, testCase.testName, durationMs);
      failedCount += increment;
    } else if (testCase.status === 'skipped') {
      skippedCount += increment;
    }

    if (source !== 'xcodebuild') {
      testCasesCompletedSinceSwiftTestingSummary += increment;
      if (testCase.status === 'failed') {
        issuesAccountedSinceSwiftTestingSummary += issueCount;
      }
    }

    if (operation === 'TEST') {
      onEvent({
        kind: 'test-result',
        fragment: 'test-case-result',
        operation: 'TEST',
        ...(testCase.suiteName !== undefined ? { suite: testCase.suiteName } : {}),
        test: testCase.testName,
        status: testCase.status,
        ...(durationMs !== undefined ? { durationMs } : {}),
      });
    }
    const suppressProgress = source === 'swift-testing-native' && testCase.status === 'failed';
    if (!suppressProgress) {
      emitTestProgress();
    }
  }

  function flushPendingError(): void {
    if (!pendingError) {
      return;
    }
    onEvent({
      kind,
      fragment: 'compiler-diagnostic',
      operation,
      severity: 'error',
      message: pendingError.message,
      location: pendingError.location,
      rawLine: pendingError.rawLines.join('\n'),
    });
    pendingError = null;
  }

  function processLine(rawLine: string): void {
    const line = normalizeEventLine(rawLine);
    if (!line) {
      flushPendingError();
      return;
    }

    const stContinuation = parseSwiftTestingContinuationLine(line);
    if (stContinuation) {
      const lastQueuedEntry = Array.from(pendingFailureDiagnostics.values()).at(-1)?.at(-1);
      if (lastQueuedEntry) {
        lastQueuedEntry.message += `\n${stContinuation}`;
        return;
      }
    }

    if (pendingError && /^\s/u.test(rawLine)) {
      pendingError.message += `\n${line}`;
      pendingError.rawLines.push(rawLine);
      return;
    }

    flushPendingError();

    const xcresultPath = parseXcresultPathLine(line);
    if (xcresultPath) {
      detectedXcresultPath = xcresultPath;
      return;
    }

    const testCase = parseTestCaseLine(line);
    if (testCase) {
      const source =
        /^Test case /u.test(line) && /\/.+\(\)$/u.test(testCase.rawName)
          ? 'swift-testing'
          : 'xcodebuild';
      recordTestCaseResult(testCase, source);
      return;
    }

    const totals = parseTotalsLine(line);
    if (totals) {
      completedCount = Math.max(completedCount, totals.executed);
      failedCount = Math.max(failedCount, totals.failed);
      emitTestProgress();
      return;
    }

    const failureDiag = parseFailureDiagnostic(line);
    if (failureDiag) {
      queueFailureDiagnostic(failureDiag);
      return;
    }

    const stIssue = parseSwiftTestingIssueLine(line);
    if (stIssue) {
      queueFailureDiagnostic(stIssue);
      return;
    }

    const stResult = parseSwiftTestingResultLine(line);
    if (stResult) {
      const issueMatch = line.match(/with (\d+) issues?\.?$/u);
      recordTestCaseResult(
        stResult,
        'swift-testing-native',
        issueMatch ? Number(issueMatch[1]) : 1,
      );
      return;
    }

    const stSummary = parseSwiftTestingRunSummary(line);
    if (stSummary) {
      // The summary reports issues, not failed tests, and one test can record
      // several issues. Only issues not already attributed to a reported failed
      // test can mark unreported tests as failed.
      const unreportedTests = Math.max(
        0,
        stSummary.executed - testCasesCompletedSinceSwiftTestingSummary,
      );
      const unaccountedIssues = Math.max(
        0,
        stSummary.failed - issuesAccountedSinceSwiftTestingSummary,
      );
      completedCount += unreportedTests;
      failedCount += Math.min(unreportedTests, unaccountedIssues);
      testCasesCompletedSinceSwiftTestingSummary = 0;
      issuesAccountedSinceSwiftTestingSummary = 0;
      emitTestProgress();
      return;
    }

    const stage = resolveStageFromLine(line);
    if (stage) {
      onEvent({
        kind,
        fragment: 'build-stage',
        operation,
        stage,
        message: stageMessages[stage],
      });
      return;
    }

    const buildError = parseBuildErrorDiagnostic(line);
    if (buildError) {
      pendingError = {
        message: buildError.message,
        location: buildError.location,
        rawLines: [line],
      };
      return;
    }

    const warning = parseWarningLine(line);
    if (warning) {
      onEvent({
        kind,
        fragment: 'compiler-diagnostic',
        operation,
        severity: 'warning',
        message: warning.message,
        location: warning.location,
        rawLine: line,
      });
      return;
    }

    if (/^Test [Ss]uite /u.test(line)) {
      return;
    }

    if (isIgnoredNoiseLine(line)) {
      return;
    }

    if (isBuildErrorDiagnosticLine(line)) {
      onEvent({
        kind,
        fragment: 'compiler-diagnostic',
        operation,
        severity: 'error',
        message: line,
        rawLine: line,
      });
      return;
    }

    if (onUnrecognizedLine) {
      onUnrecognizedLine(line);
    }
  }

  function drainLines(buffer: string, chunk: string): string {
    const combined = buffer + chunk;
    const lines = combined.split(/\r?\n/u);
    const remainder = lines.pop() ?? '';
    for (const line of lines) {
      processLine(line);
    }
    return remainder;
  }

  return {
    onStdout(chunk: string): void {
      stdoutBuffer = drainLines(stdoutBuffer, chunk);
    },
    onStderr(chunk: string): void {
      stderrBuffer = drainLines(stderrBuffer, chunk);
    },
    flush(): void {
      if (stdoutBuffer.trim()) {
        processLine(stdoutBuffer);
      }
      if (stderrBuffer.trim()) {
        processLine(stderrBuffer);
      }
      flushQueuedFailureDiagnostics();
      flushPendingError();
      stdoutBuffer = '';
      stderrBuffer = '';
    },
    get xcresultPath(): string | null {
      return detectedXcresultPath;
    },
  };
}
