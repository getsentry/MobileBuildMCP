import type {
  BuildStageFragment,
  BuildSummaryFragment,
  CompilerDiagnosticFragment,
  DomainFragment,
  TestCaseResultFragment,
  TestDiscoveryFragment,
  TestFailureFragment,
  TestProgressFragment,
} from '../types/domain-fragments.ts';
import type { XcodebuildOperation, XcodebuildStage } from '../types/domain-fragments.ts';
import { STAGE_RANK } from '../types/domain-fragments.ts';

type XcodebuildRunStateFragment =
  | BuildStageFragment
  | CompilerDiagnosticFragment
  | TestDiscoveryFragment
  | TestFailureFragment
  | TestProgressFragment
  | TestCaseResultFragment;

export interface XcodebuildRunState {
  operation: XcodebuildOperation;
  currentStage: XcodebuildStage | null;
  milestones: BuildStageFragment[];
  warnings: CompilerDiagnosticFragment[];
  errors: CompilerDiagnosticFragment[];
  testFailures: TestFailureFragment[];
  testCaseResults: TestCaseResultFragment[];
  completedTests: number;
  failedTests: number;
  skippedTests: number;
  finalStatus: 'SUCCEEDED' | 'FAILED' | null;
  wallClockDurationMs: number | null;
}

export interface RunStateOptions {
  operation: XcodebuildOperation;
  minimumStage?: XcodebuildStage;
  onEvent?: (fragment: DomainFragment) => void;
}

function normalizeDiagnosticKey(location: string | undefined, message: string): string {
  return `${location ?? ''}|${message}`.trim().toLowerCase();
}

function normalizeTestIdentifier(value: string | undefined): string {
  return (value ?? '').trim().replace(/\(\)$/u, '').toLowerCase();
}

function normalizeTestFailureLocation(location: string | undefined): string | null {
  if (!location) {
    return null;
  }

  const match = location.match(/([^/]+:\d+(?::\d+)?)$/u);
  return (match?.[1] ?? location).trim().toLowerCase();
}

function normalizeTestFailureMessage(message: string): string {
  const lines = message
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  while (lines.at(-1)?.startsWith('// MARK:') === true) {
    lines.pop();
  }

  return lines.join('\n').toLowerCase();
}

function normalizeTestFailureKey(fragment: TestFailureFragment): string {
  const normalizedLocation = normalizeTestFailureLocation(fragment.location);
  const normalizedMessage = normalizeTestFailureMessage(fragment.message);
  const suite = normalizeTestIdentifier(fragment.suite);
  const test = normalizeTestIdentifier(fragment.test);

  if (normalizedLocation) {
    return `${test}|${normalizedLocation}|${normalizedMessage}`;
  }

  return `${suite}|${test}|${normalizedMessage}`;
}

/**
 * Failed test count for a run. Failure diagnostics are counted per test, not per
 * diagnostic, because one test can record several failed assertions.
 */
export function countFailedTests(
  state: Pick<XcodebuildRunState, 'failedTests' | 'testFailures'>,
): number {
  const failedTestKeys = new Set<string>();
  for (const [index, failure] of state.testFailures.entries()) {
    const test = normalizeTestIdentifier(failure.test);
    failedTestKeys.add(test ? `test:${test}` : `failure:${index}`);
  }
  return Math.max(state.failedTests, failedTestKeys.size);
}

export interface XcodebuildRunStateHandle {
  push(fragment: XcodebuildRunStateFragment): void;
  finalize(succeeded: boolean, durationMs?: number): XcodebuildRunState;
  snapshot(): Readonly<XcodebuildRunState>;
  highestStageRank(): number;
}

function createTestSummaryFragment(
  state: XcodebuildRunState,
  kind: 'build-result' | 'build-run-result' | 'test-result',
  durationMs?: number,
): BuildSummaryFragment {
  const failedTests = countFailedTests(state);
  const passedTests = Math.max(0, state.completedTests - failedTests - state.skippedTests);
  const totalTests = passedTests + failedTests + state.skippedTests;

  return {
    kind,
    fragment: 'build-summary',
    operation: 'TEST',
    status: state.finalStatus ?? 'FAILED',
    ...(totalTests > 0
      ? {
          totalTests,
          passedTests,
          failedTests,
          skippedTests: state.skippedTests,
        }
      : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

function createBuildSummaryFragment(
  state: XcodebuildRunState,
  kind: 'build-result' | 'build-run-result' | 'test-result',
  durationMs?: number,
): BuildSummaryFragment {
  return {
    kind,
    fragment: 'build-summary',
    operation: 'BUILD',
    status: state.finalStatus ?? 'FAILED',
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

export function createXcodebuildRunState(options: RunStateOptions): XcodebuildRunStateHandle {
  const { operation, onEvent } = options;

  const state: XcodebuildRunState = {
    operation,
    currentStage: null,
    milestones: [],
    warnings: [],
    errors: [],
    testFailures: [],
    testCaseResults: [],
    completedTests: 0,
    failedTests: 0,
    skippedTests: 0,
    finalStatus: null,
    wallClockDurationMs: null,
  };

  let highestRank = options.minimumStage !== undefined ? STAGE_RANK[options.minimumStage] : -1;
  const seenDiagnostics = new Set<string>();

  function accept(fragment: DomainFragment): void {
    onEvent?.(fragment);
  }

  function acceptDedupedDiagnostic(
    fragment: CompilerDiagnosticFragment,
    collection: CompilerDiagnosticFragment[],
  ): void {
    const key = normalizeDiagnosticKey(fragment.location, fragment.message);
    if (seenDiagnostics.has(key)) {
      return;
    }
    seenDiagnostics.add(key);
    collection.push(fragment);
    accept(fragment);
  }

  return {
    push(fragment: XcodebuildRunStateFragment): void {
      switch (fragment.fragment) {
        case 'build-stage': {
          const rank = STAGE_RANK[fragment.stage];
          if (rank <= highestRank) {
            return;
          }
          highestRank = rank;
          state.currentStage = fragment.stage;
          state.milestones.push(fragment);
          accept(fragment);
          break;
        }

        case 'compiler-diagnostic': {
          if (fragment.severity === 'warning') {
            acceptDedupedDiagnostic(fragment, state.warnings);
          } else {
            acceptDedupedDiagnostic(fragment, state.errors);
          }
          break;
        }

        case 'test-failure': {
          const key = normalizeTestFailureKey(fragment);
          if (seenDiagnostics.has(key)) {
            return;
          }
          seenDiagnostics.add(key);
          state.testFailures.push(fragment);
          accept(fragment);
          break;
        }

        case 'test-discovery': {
          accept(fragment);
          break;
        }

        case 'test-case-result': {
          state.testCaseResults.push(fragment);
          accept(fragment);
          break;
        }

        case 'test-progress': {
          state.completedTests = fragment.completed;
          state.failedTests = fragment.failed;
          state.skippedTests = fragment.skipped;

          if (highestRank < STAGE_RANK.RUN_TESTS) {
            const runTestsFragment: BuildStageFragment = {
              kind: operation === 'TEST' ? 'test-result' : 'build-result',
              fragment: 'build-stage',
              operation: 'TEST',
              stage: 'RUN_TESTS',
              message: 'Running tests',
            };
            highestRank = STAGE_RANK.RUN_TESTS;
            state.currentStage = 'RUN_TESTS';
            state.milestones.push(runTestsFragment);
            accept(runTestsFragment);
          }

          accept(fragment);
          break;
        }
      }
    },

    finalize(succeeded: boolean, durationMs?: number): XcodebuildRunState {
      state.finalStatus = succeeded ? 'SUCCEEDED' : 'FAILED';
      state.wallClockDurationMs = durationMs ?? null;

      const kind = (state.milestones[0]?.kind ??
        (operation === 'TEST' ? 'test-result' : 'build-result')) as
        | 'build-result'
        | 'build-run-result'
        | 'test-result';

      if (operation === 'TEST') {
        onEvent?.(createTestSummaryFragment(state, kind, durationMs));
      } else if (operation === 'BUILD') {
        onEvent?.(createBuildSummaryFragment(state, kind, durationMs));
      }

      return {
        ...state,
        milestones: [...state.milestones],
        warnings: [...state.warnings],
        errors: [...state.errors],
        testFailures: [...state.testFailures],
        testCaseResults: [...state.testCaseResults],
      };
    },

    snapshot(): Readonly<XcodebuildRunState> {
      return {
        ...state,
        milestones: [...state.milestones],
        warnings: [...state.warnings],
        errors: [...state.errors],
        testFailures: [...state.testFailures],
        testCaseResults: [...state.testCaseResults],
      };
    },

    highestStageRank(): number {
      return highestRank;
    },
  };
}
