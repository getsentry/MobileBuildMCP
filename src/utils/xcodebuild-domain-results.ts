import type { ToolHandlerContext } from '../rendering/types.ts';
import type {
  BasicDiagnostics,
  DiagnosticEntry,
  BuildResultArtifacts,
  BuildResultDomainResult,
  BuildRunResultArtifacts,
  BuildRunResultDomainResult,
  BuildTarget,
  Counts,
  TestDiagnostics,
  TestResultArtifacts,
  TestResultDomainResult,
  TestSelectionInfo,
} from '../types/domain-results.ts';
import type {
  BuildInvocationRequest,
  BuildLikeKind,
  TestDiscoveryFragment,
  XcodebuildOperation,
} from '../types/domain-fragments.ts';
import type { StreamingExecutionContext } from '../types/tool-execution.ts';

import { finalizeInlineXcodebuild } from './xcodebuild-output.ts';
import type { StartedPipeline, XcodebuildPipeline } from './xcodebuild-pipeline.ts';
import { createXcodebuildPipeline } from './xcodebuild-pipeline.ts';
import type { XcodebuildRunState } from './xcodebuild-run-state.ts';
import { collectResolvedTestSelectors, type TestPreflightResult } from './test-preflight.ts';
import { createStreamingExecutionContext } from './tool-execution-compat.ts';
import { isBuildErrorDiagnosticLine } from './xcodebuild-line-parsers.ts';
import { extractTestSummaryCountsFromXcresult } from './xcresult-test-failures.ts';

const MAX_DISCOVERED_TESTS = 6;

interface LineStreamState {
  remainder: string;
  lines: string[];
}

function emitChunkLines(state: LineStreamState, chunk: string): void {
  const combined = `${state.remainder}${chunk}`;
  const normalized = combined.replace(/\r\n/g, '\n');
  const parts = normalized.split('\n');
  state.remainder = parts.pop() ?? '';

  for (const line of parts) {
    if (line.length === 0) {
      continue;
    }

    state.lines.push(line);
  }
}

function flushChunkLines(state: LineStreamState): void {
  if (state.remainder.length === 0) {
    return;
  }

  state.lines.push(state.remainder);
  state.remainder = '';
}

function collectRawOutput(
  fallbackErrorMessages: readonly string[] | undefined,
): string[] | undefined {
  if (!fallbackErrorMessages || fallbackErrorMessages.length === 0) {
    return undefined;
  }

  const lines = fallbackErrorMessages.filter((msg) => msg.trim().length > 0);
  return lines.length > 0 ? lines : undefined;
}

function normalizeDiagnosticText(value: string): string {
  return value.trim().toLowerCase();
}

function isLineRepresentedByDiagnostic(
  line: string,
  diagnostics: readonly DiagnosticEntry[],
): boolean {
  const normalizedLine = normalizeDiagnosticText(line);

  return diagnostics.some((diagnostic) => {
    const normalizedMessages = diagnostic.message
      .split(/\r?\n/u)
      .map(normalizeDiagnosticText)
      .filter(Boolean);
    if (normalizedMessages.includes(normalizedLine)) {
      return true;
    }

    const representedMessage = normalizedMessages.find((message) =>
      normalizedLine.endsWith(message),
    );
    if (!representedMessage) {
      return false;
    }

    const normalizedLocation = diagnostic.location
      ? normalizeDiagnosticText(diagnostic.location)
      : null;
    return normalizedLocation ? normalizedLine.includes(normalizedLocation) : true;
  });
}

function collectDiagnosticRawOutput(
  fallbackErrorMessages: readonly string[] | undefined,
  parsedErrors: readonly DiagnosticEntry[],
): string[] | undefined {
  const rawOutput = collectRawOutput(fallbackErrorMessages);
  if (!rawOutput || parsedErrors.length === 0) {
    return rawOutput;
  }

  const diagnosticLines = rawOutput.filter(
    (line) =>
      isBuildErrorDiagnosticLine(line) && !isLineRepresentedByDiagnostic(line, parsedErrors),
  );
  return diagnosticLines.length > 0 ? diagnosticLines : undefined;
}

function createBasicDiagnostics(
  state: XcodebuildRunState,
  didError: boolean,
  fallbackErrorMessages?: readonly string[],
): BasicDiagnostics {
  const warnings = state.warnings.map((warning) => ({
    message: warning.message,
    location: warning.location,
  }));

  const errors = didError
    ? state.errors.map((error) => ({
        message: error.message,
        location: error.location,
      }))
    : [];

  const rawOutput = didError
    ? collectDiagnosticRawOutput(fallbackErrorMessages, errors)
    : undefined;

  return { warnings, errors, ...(rawOutput ? { rawOutput } : {}) };
}

function createTestDiagnostics(
  state: XcodebuildRunState,
  didError: boolean,
  fallbackErrorMessages?: readonly string[],
): TestDiagnostics {
  return {
    ...createBasicDiagnostics(
      state,
      didError,
      state.testFailures.length === 0 ? fallbackErrorMessages : undefined,
    ),
    testFailures: state.testFailures
      .map((failure) => ({
        suite: failure.suite ?? '(Unknown Suite)',
        test: failure.test ?? 'test',
        message: failure.message,
        location: failure.location,
      }))
      .sort((left, right) => {
        const leftKey = `${left.suite}\0${left.test}\0${left.location}\0${left.message}`;
        const rightKey = `${right.suite}\0${right.test}\0${right.location}\0${right.message}`;
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      }),
  };
}

function hasTestCounts(state: XcodebuildRunState): boolean {
  return (
    state.completedTests > 0 ||
    state.failedTests > 0 ||
    state.skippedTests > 0 ||
    state.testFailures.length > 0
  );
}

function createStateTestCounts(state: XcodebuildRunState): Counts | undefined {
  if (!hasTestCounts(state)) {
    return undefined;
  }

  const failed = Math.max(state.failedTests, state.testFailures.length);
  const skipped = state.skippedTests;
  const passed = Math.max(0, state.completedTests - failed - skipped);

  return {
    passed,
    failed,
    skipped,
  };
}

export function createTestDiscoveryFragment(
  preflight?: TestPreflightResult,
): TestDiscoveryFragment | null {
  if (!preflight || preflight.totalTests === 0) {
    return null;
  }

  const discoveredItems = collectResolvedTestSelectors(preflight).slice(0, MAX_DISCOVERED_TESTS);

  return {
    kind: 'test-result',
    fragment: 'test-discovery',
    operation: 'TEST',
    total: preflight.totalTests,
    tests: discoveredItems,
    truncated: discoveredItems.length < preflight.totalTests,
  };
}

function createTestSelectionInfo(preflight?: TestPreflightResult): TestSelectionInfo | undefined {
  if (!preflight || preflight.totalTests === 0) {
    return undefined;
  }

  const discoveredItems = collectResolvedTestSelectors(preflight);
  const discoveryEvent = createTestDiscoveryFragment(preflight);
  const hasExplicitSelection =
    preflight.selectors.onlyTesting.length > 0 || preflight.selectors.skipTesting.length > 0;

  return {
    ...(hasExplicitSelection ? { selected: discoveredItems } : {}),
    ...(discoveryEvent
      ? {
          discovered: {
            total: discoveryEvent.total,
            items: discoveryEvent.tests,
          },
        }
      : {}),
  };
}

interface FinalizeXcodebuildResultOptions {
  started: StartedPipeline;
  succeeded: boolean;
}

function finalizePipelineResult(options: FinalizeXcodebuildResultOptions) {
  const durationMs = Date.now() - options.started.startedAt;
  const pipelineResult = finalizeInlineXcodebuild({
    started: options.started,
    succeeded: options.succeeded,
    durationMs,
  });

  return {
    durationMs,
    pipelineResult,
  };
}

export interface ProgressStreamingXcodebuildExecution extends StartedPipeline {
  stdoutLines: string[];
  stderrLines: string[];
}

export function createDomainStreamingPipeline(
  toolName: string,
  operation: XcodebuildOperation,
  ctx: StreamingExecutionContext,
  kind: BuildLikeKind = 'build-run-result',
): ProgressStreamingXcodebuildExecution {
  const innerPipeline = createXcodebuildPipeline({
    operation,
    kind,
    toolName,
    params: {},
    emit: (fragment) => {
      ctx.emitFragment(fragment);
    },
  });

  const stdoutState: LineStreamState = { remainder: '', lines: [] };
  const stderrState: LineStreamState = { remainder: '', lines: [] };

  const pipeline: XcodebuildPipeline = {
    onStdout(chunk: string): void {
      innerPipeline.onStdout(chunk);
      emitChunkLines(stdoutState, chunk);
    },

    onStderr(chunk: string): void {
      innerPipeline.onStderr(chunk);
      emitChunkLines(stderrState, chunk);
    },

    emitFragment(fragment): void {
      innerPipeline.emitFragment(fragment);
    },

    finalize(succeeded, durationMs, options) {
      flushChunkLines(stdoutState);
      flushChunkLines(stderrState);
      return innerPipeline.finalize(succeeded, durationMs, options);
    },

    highestStageRank(): number {
      return innerPipeline.highestStageRank();
    },

    get xcresultPath(): string | null {
      return innerPipeline.xcresultPath;
    },

    get logPath(): string {
      return innerPipeline.logPath;
    },
  };

  return {
    pipeline,
    startedAt: Date.now(),
    stdoutLines: stdoutState.lines,
    stderrLines: stderrState.lines,
  };
}

export function createBuildDomainResult(options: {
  started: StartedPipeline;
  succeeded: boolean;
  target: BuildTarget;
  artifacts: BuildResultArtifacts;
  fallbackErrorMessages?: readonly string[];
  request: BuildInvocationRequest;
}): BuildResultDomainResult {
  const { durationMs, pipelineResult } = finalizePipelineResult(options);
  const result: BuildResultDomainResult = {
    kind: 'build-result',
    request: options.request,
    didError: !options.succeeded,
    error: options.succeeded ? null : 'Build failed',
    summary: {
      status: options.succeeded ? 'SUCCEEDED' : 'FAILED',
      durationMs,
      target: options.target,
    },
    artifacts: options.artifacts,
    diagnostics: createBasicDiagnostics(
      pipelineResult.state,
      !options.succeeded,
      options.fallbackErrorMessages,
    ),
  };

  return result;
}

export function createBuildRunDomainResult(options: {
  started: StartedPipeline;
  succeeded: boolean;
  target: BuildTarget;
  artifacts: BuildRunResultArtifacts;
  fallbackErrorMessages?: readonly string[];
  output?: BuildRunResultDomainResult['output'];
  request: BuildInvocationRequest;
}): BuildRunResultDomainResult {
  const { durationMs, pipelineResult } = finalizePipelineResult(options);
  const result: BuildRunResultDomainResult = {
    kind: 'build-run-result',
    request: options.request,
    didError: !options.succeeded,
    error: options.succeeded ? null : 'Build failed',
    summary: {
      status: options.succeeded ? 'SUCCEEDED' : 'FAILED',
      durationMs,
      target: options.target,
    },
    artifacts: options.artifacts,
    ...(options.output ? { output: options.output } : {}),
    diagnostics: createBasicDiagnostics(
      pipelineResult.state,
      !options.succeeded,
      options.fallbackErrorMessages,
    ),
  };

  return result;
}

export function createTestDomainResult(options: {
  started: StartedPipeline;
  succeeded: boolean;
  target: BuildTarget;
  artifacts: TestResultArtifacts;
  fallbackErrorMessages?: readonly string[];
  includeDetectedXcresult?: boolean;
  preflight?: TestPreflightResult;
  request: BuildInvocationRequest;
}): TestResultDomainResult {
  const { durationMs, pipelineResult } = finalizePipelineResult(options);
  const state = pipelineResult.state;
  const testSelectionInfo = createTestSelectionInfo(options.preflight);
  const testCases = state.testCaseResults.map((fragment) => ({
    ...(fragment.suite !== undefined ? { suite: fragment.suite } : {}),
    test: fragment.test,
    status: fragment.status,
    ...(fragment.durationMs !== undefined ? { durationMs: fragment.durationMs } : {}),
  }));
  const detectedXcresultPath =
    options.includeDetectedXcresult === false || options.target === 'swift-package'
      ? null
      : options.started.pipeline.xcresultPath;
  const providedXcresultPath =
    'xcresultPath' in options.artifacts ? options.artifacts.xcresultPath : undefined;
  const xcresultPath = providedXcresultPath ?? detectedXcresultPath;
  const artifacts: TestResultArtifacts = {
    ...options.artifacts,
    ...(xcresultPath ? { xcresultPath } : {}),
  };
  const counts =
    (xcresultPath ? extractTestSummaryCountsFromXcresult(xcresultPath) : null) ??
    createStateTestCounts(state);
  const result: TestResultDomainResult = {
    kind: 'test-result',
    request: options.request,
    didError: !options.succeeded,
    error: options.succeeded ? null : 'Tests failed',
    summary: {
      status: options.succeeded ? 'SUCCEEDED' : 'FAILED',
      durationMs,
      ...(counts ? { counts } : {}),
      target: options.target,
    },
    artifacts,
    ...(testSelectionInfo ? { tests: testSelectionInfo } : {}),
    diagnostics: createTestDiagnostics(state, !options.succeeded, options.fallbackErrorMessages),
    ...(testCases.length > 0 ? { testCases } : {}),
  };

  return result;
}

const XCODEBUILD_STRUCTURED_OUTPUT_SCHEMAS = {
  'build-result': 'mobilebuildmcp.output.build-result',
  'build-run-result': 'mobilebuildmcp.output.build-run-result',
  'test-result': 'mobilebuildmcp.output.test-result',
} as const;

export type XcodebuildStructuredOutputKind = keyof typeof XCODEBUILD_STRUCTURED_OUTPUT_SCHEMAS;

type XcodebuildDomainResultFor<K extends XcodebuildStructuredOutputKind> = {
  'build-result': BuildResultDomainResult;
  'build-run-result': BuildRunResultDomainResult;
  'test-result': TestResultDomainResult;
}[K];

export function setXcodebuildStructuredOutput<K extends XcodebuildStructuredOutputKind>(
  ctx: ToolHandlerContext,
  kind: K,
  result: XcodebuildDomainResultFor<K>,
  schemaVersion = '2',
): void {
  ctx.structuredOutput = {
    result,
    schema: XCODEBUILD_STRUCTURED_OUTPUT_SCHEMAS[kind],
    schemaVersion,
  };
}

export function collectFallbackErrorMessages(
  started: ProgressStreamingXcodebuildExecution,
  extraMessages: readonly string[] = [],
  responseContent?: ReadonlyArray<{ type: 'text'; text: string }>,
): string[] {
  return [
    ...started.stderrLines,
    ...extraMessages,
    ...(responseContent ?? []).map((item) => item.text),
  ];
}

export { createStreamingExecutionContext };
