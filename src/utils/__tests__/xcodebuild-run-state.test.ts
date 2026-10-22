import { describe, expect, it } from 'vitest';
import { createXcodebuildRunState } from '../xcodebuild-run-state.ts';
import type {
  CompilerDiagnosticFragment,
  DomainFragment,
  TestFailureFragment,
} from '../../types/domain-fragments.ts';
import { STAGE_RANK } from '../../types/domain-fragments.ts';

describe('xcodebuild-run-state', () => {
  it('accepts status events and tracks milestones in order', () => {
    const forwarded: DomainFragment[] = [];
    const state = createXcodebuildRunState({
      operation: 'TEST',
      onEvent: (e) => forwarded.push(e),
    });

    state.push({
      kind: 'test-result',
      fragment: 'build-stage',
      operation: 'TEST',
      stage: 'RESOLVING_PACKAGES',
      message: 'Resolving packages',
    });
    state.push({
      kind: 'test-result',
      fragment: 'build-stage',
      operation: 'TEST',
      stage: 'COMPILING',
      message: 'Compiling',
    });
    state.push({
      kind: 'test-result',
      fragment: 'build-stage',
      operation: 'TEST',
      stage: 'RUN_TESTS',
      message: 'Running tests',
    });

    const snap = state.snapshot();
    expect(snap.milestones).toHaveLength(3);
    expect(snap.milestones.map((m) => m.stage)).toEqual([
      'RESOLVING_PACKAGES',
      'COMPILING',
      'RUN_TESTS',
    ]);
    expect(snap.currentStage).toBe('RUN_TESTS');
    expect(forwarded).toHaveLength(3);
  });

  it('deduplicates milestones at or below current rank', () => {
    const state = createXcodebuildRunState({ operation: 'BUILD' });

    state.push({
      kind: 'build-result',
      fragment: 'build-stage',
      operation: 'BUILD',
      stage: 'RESOLVING_PACKAGES',
      message: 'Resolving packages',
    });
    state.push({
      kind: 'build-result',
      fragment: 'build-stage',
      operation: 'BUILD',
      stage: 'COMPILING',
      message: 'Compiling',
    });
    // Duplicate: should be ignored
    state.push({
      kind: 'build-result',
      fragment: 'build-stage',
      operation: 'BUILD',
      stage: 'RESOLVING_PACKAGES',
      message: 'Resolving packages',
    });
    state.push({
      kind: 'build-result',
      fragment: 'build-stage',
      operation: 'BUILD',
      stage: 'COMPILING',
      message: 'Compiling',
    });

    const snap = state.snapshot();
    expect(snap.milestones).toHaveLength(2);
  });

  it('respects minimumStage for multi-phase continuation', () => {
    const state = createXcodebuildRunState({
      operation: 'TEST',
      minimumStage: 'COMPILING',
    });

    // These should be suppressed because they're at or below COMPILING rank
    state.push({
      kind: 'test-result',
      fragment: 'build-stage',
      operation: 'TEST',
      stage: 'RESOLVING_PACKAGES',
      message: 'Resolving packages',
    });
    state.push({
      kind: 'test-result',
      fragment: 'build-stage',
      operation: 'TEST',
      stage: 'COMPILING',
      message: 'Compiling',
    });
    // This should be accepted
    state.push({
      kind: 'test-result',
      fragment: 'build-stage',
      operation: 'TEST',
      stage: 'RUN_TESTS',
      message: 'Running tests',
    });

    const snap = state.snapshot();
    expect(snap.milestones).toHaveLength(1);
    expect(snap.milestones[0].stage).toBe('RUN_TESTS');
  });

  it('deduplicates error diagnostics by location+message', () => {
    const state = createXcodebuildRunState({ operation: 'BUILD' });

    const error: CompilerDiagnosticFragment = {
      kind: 'build-result',
      fragment: 'compiler-diagnostic',
      severity: 'error',
      operation: 'BUILD',
      message: 'type mismatch',
      location: '/tmp/App.swift:8',
      rawLine: '/tmp/App.swift:8:17: error: type mismatch',
    };

    state.push(error);
    state.push(error);

    const snap = state.snapshot();
    expect(snap.errors).toHaveLength(1);
  });

  it('deduplicates test failures by location+message', () => {
    const state = createXcodebuildRunState({ operation: 'TEST' });

    const failure: TestFailureFragment = {
      kind: 'test-result',
      fragment: 'test-failure',
      operation: 'TEST',
      suite: 'Suite',
      test: 'testA',
      message: 'assertion failed',
      location: '/tmp/Test.swift:10',
    };

    state.push(failure);
    state.push(failure);

    const snap = state.snapshot();
    expect(snap.testFailures).toHaveLength(1);
  });

  it('deduplicates test failures when xcresult and live parsing disagree on suite/test naming', () => {
    const state = createXcodebuildRunState({ operation: 'TEST' });

    state.push({
      kind: 'test-result',
      fragment: 'test-failure',
      operation: 'TEST',
      suite: 'CalculatorAppTests.CalculatorAppTests',
      test: 'testCalculatorServiceFailure',
      message: 'XCTAssertEqual failed',
      location: '/tmp/CalculatorAppTests.swift:52',
    });
    state.push({
      kind: 'test-result',
      fragment: 'test-failure',
      operation: 'TEST',
      test: 'testCalculatorServiceFailure()',
      message: 'XCTAssertEqual failed',
      location: 'CalculatorAppTests.swift:52',
    });

    const snap = state.snapshot();
    expect(snap.testFailures).toHaveLength(1);
  });

  it('deduplicates Swift Testing failures with volatile trailing source context lines', () => {
    const state = createXcodebuildRunState({ operation: 'TEST' });

    state.push({
      kind: 'test-result',
      fragment: 'test-failure',
      operation: 'TEST',
      suite: 'Calculator Basic Functionality',
      test: 'This test should fail to verify error reporting',
      message: `Expectation failed: Bool(false)
// This test is designed to fail so we can test error reporting
This should fail for testing purposes`,
      location: '/tmp/CalculatorServiceTests.swift:37',
    });
    state.push({
      kind: 'test-result',
      fragment: 'test-failure',
      operation: 'TEST',
      suite: '(Unknown Suite)',
      test: 'This test should fail to verify error reporting',
      message: `Expectation failed: Bool(false)
// This test is designed to fail so we can test error reporting
This should fail for testing purposes
// MARK: - Calculator Basic Tests`,
      location: 'CalculatorServiceTests.swift:37',
    });

    const snap = state.snapshot();
    expect(snap.testFailures).toHaveLength(1);
  });

  it('keeps distinct Swift Testing failures when MARK lines are part of the assertion message', () => {
    const state = createXcodebuildRunState({ operation: 'TEST' });

    state.push({
      kind: 'test-result',
      fragment: 'test-failure',
      operation: 'TEST',
      suite: 'Suite',
      test: 'testA',
      message: `Expectation failed
// MARK: expected value`,
      location: '/tmp/Test.swift:10',
    });
    state.push({
      kind: 'test-result',
      fragment: 'test-failure',
      operation: 'TEST',
      suite: 'Suite',
      test: 'testA',
      message: `Expectation failed
// MARK: expected value
Actual mismatch`,
      location: '/tmp/Test.swift:10',
    });

    const snap = state.snapshot();
    expect(snap.testFailures).toHaveLength(2);
  });

  it('deduplicates warnings by location+message', () => {
    const state = createXcodebuildRunState({ operation: 'BUILD' });

    const warning: CompilerDiagnosticFragment = {
      kind: 'build-result',
      fragment: 'compiler-diagnostic',
      severity: 'warning',
      operation: 'BUILD',
      message: 'unused variable',
      location: '/tmp/App.swift:5',
      rawLine: '/tmp/App.swift:5: warning: unused variable',
    };

    state.push(warning);
    state.push(warning);

    const snap = state.snapshot();
    expect(snap.warnings).toHaveLength(1);
  });

  it('tracks test counts from test-progress events', () => {
    const state = createXcodebuildRunState({ operation: 'TEST' });

    state.push({
      kind: 'test-result',
      fragment: 'test-progress',
      operation: 'TEST',
      completed: 1,
      failed: 0,
      skipped: 0,
    });
    state.push({
      kind: 'test-result',
      fragment: 'test-progress',
      operation: 'TEST',
      completed: 2,
      failed: 1,
      skipped: 0,
    });
    state.push({
      kind: 'test-result',
      fragment: 'test-progress',
      operation: 'TEST',
      completed: 3,
      failed: 1,
      skipped: 1,
    });

    const snap = state.snapshot();
    expect(snap.completedTests).toBe(3);
    expect(snap.failedTests).toBe(1);
    expect(snap.skippedTests).toBe(1);
  });

  it('auto-inserts RUN_TESTS milestone on first test-progress', () => {
    const forwarded: DomainFragment[] = [];
    const state = createXcodebuildRunState({
      operation: 'TEST',
      onEvent: (e) => forwarded.push(e),
    });

    state.push({
      kind: 'test-result',
      fragment: 'test-progress',
      operation: 'TEST',
      completed: 1,
      failed: 0,
      skipped: 0,
    });

    const snap = state.snapshot();
    expect(snap.milestones).toHaveLength(1);
    expect(snap.milestones[0].stage).toBe('RUN_TESTS');
    // RUN_TESTS status + test-progress both forwarded
    expect(forwarded).toHaveLength(2);
  });

  it('finalize emits a summary event for test runs', () => {
    const forwarded: DomainFragment[] = [];
    const state = createXcodebuildRunState({
      operation: 'TEST',
      onEvent: (e) => forwarded.push(e),
    });

    state.push({
      kind: 'test-result',
      fragment: 'test-progress',
      operation: 'TEST',
      completed: 5,
      failed: 2,
      skipped: 0,
    });

    const finalState = state.finalize(false, 1234);

    expect(finalState.finalStatus).toBe('FAILED');
    expect(finalState.wallClockDurationMs).toBe(1234);
    expect(finalState.completedTests).toBe(5);
    expect(finalState.failedTests).toBe(2);
    expect(finalState.skippedTests).toBe(0);
    expect(forwarded.at(-1)).toEqual({
      kind: 'test-result',
      fragment: 'build-summary',
      operation: 'TEST',
      status: 'FAILED',
      totalTests: 5,
      passedTests: 3,
      failedTests: 2,
      skippedTests: 0,
      durationMs: 1234,
    });
  });

  it('preserves explicit test failures alongside raw progress counts', () => {
    const state = createXcodebuildRunState({ operation: 'TEST' });

    state.push({
      kind: 'test-result',
      fragment: 'test-progress',
      operation: 'TEST',
      completed: 6,
      failed: 1,
      skipped: 0,
    });
    state.push({
      kind: 'test-result',
      fragment: 'test-failure',
      operation: 'TEST',
      suite: 'CalculatorAppTests',
      test: 'testCalculatorServiceFailure',
      message: 'XCTAssertEqual failed',
      location: '/tmp/SimpleTests.swift:49',
    });
    state.push({
      kind: 'test-result',
      fragment: 'test-failure',
      operation: 'TEST',
      test: 'test',
      message: 'Expectation failed: Bool(false)',
      location: '/tmp/SimpleTests.swift:57',
    });

    const finalState = state.finalize(false, 1234);
    expect(finalState.completedTests).toBe(6);
    expect(finalState.failedTests).toBe(1);
    expect(finalState.skippedTests).toBe(0);
    expect(finalState.testFailures).toHaveLength(2);
  });

  it('counts several failure diagnostics from one test as one failed test', () => {
    const forwarded: DomainFragment[] = [];
    const state = createXcodebuildRunState({
      operation: 'TEST',
      onEvent: (e) => forwarded.push(e),
    });

    state.push({
      kind: 'test-result',
      fragment: 'test-progress',
      operation: 'TEST',
      completed: 2,
      failed: 1,
      skipped: 0,
    });
    for (const line of [10, 11, 12]) {
      state.push({
        kind: 'test-result',
        fragment: 'test-failure',
        operation: 'TEST',
        test: 'fails',
        message: `Expectation failed: ${line}`,
        location: `CountsTests.swift:${line}:3`,
      });
    }

    state.finalize(false);
    expect(forwarded.at(-1)).toMatchObject({
      fragment: 'build-summary',
      totalTests: 2,
      passedTests: 1,
      failedTests: 1,
      skippedTests: 0,
    });
  });

  it('highestStageRank returns correct rank for multi-phase handoff', () => {
    const state = createXcodebuildRunState({ operation: 'TEST' });

    state.push({
      kind: 'test-result',
      fragment: 'build-stage',
      operation: 'TEST',
      stage: 'RESOLVING_PACKAGES',
      message: 'Resolving packages',
    });
    state.push({
      kind: 'test-result',
      fragment: 'build-stage',
      operation: 'TEST',
      stage: 'COMPILING',
      message: 'Compiling',
    });

    expect(state.highestStageRank()).toBe(STAGE_RANK.COMPILING);
  });

  it('does not deduplicate distinct test failures sharing the same assertion location', () => {
    const state = createXcodebuildRunState({ operation: 'TEST' });

    state.push({
      kind: 'test-result',
      fragment: 'test-failure',
      operation: 'TEST',
      suite: 'SuiteA',
      test: 'testOne',
      message: 'XCTAssertTrue failed',
      location: '/tmp/SharedAssert.swift:10',
    });
    state.push({
      kind: 'test-result',
      fragment: 'test-failure',
      operation: 'TEST',
      suite: 'SuiteB',
      test: 'testTwo',
      message: 'XCTAssertTrue failed',
      location: '/tmp/SharedAssert.swift:10',
    });

    expect(state.snapshot().testFailures).toHaveLength(2);
  });

  it('collects test-case-result fragments on the snapshot', () => {
    const forwarded: DomainFragment[] = [];
    const state = createXcodebuildRunState({
      operation: 'TEST',
      onEvent: (e) => forwarded.push(e),
    });

    state.push({
      kind: 'test-result',
      fragment: 'test-case-result',
      operation: 'TEST',
      suite: 'Suite',
      test: 'testA',
      status: 'passed',
      durationMs: 5,
    });
    state.push({
      kind: 'test-result',
      fragment: 'test-case-result',
      operation: 'TEST',
      suite: 'Suite',
      test: 'testB',
      status: 'failed',
      durationMs: 12,
    });

    const snap = state.snapshot();
    expect(snap.testCaseResults).toHaveLength(2);
    expect(snap.testCaseResults[0]).toMatchObject({ test: 'testA', status: 'passed' });
    expect(snap.testCaseResults[1]).toMatchObject({ test: 'testB', status: 'failed' });
    expect(forwarded).toHaveLength(2);
  });

  it('forwards test discovery events without storing additional state', () => {
    const forwarded: DomainFragment[] = [];
    const state = createXcodebuildRunState({
      operation: 'TEST',
      onEvent: (e) => forwarded.push(e),
    });

    state.push({
      kind: 'test-result',
      fragment: 'test-discovery',
      operation: 'TEST',
      total: 3,
      tests: ['testA', 'testB', 'testC'],
      truncated: false,
    });

    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toMatchObject({
      fragment: 'test-discovery',
      total: 3,
      tests: ['testA', 'testB', 'testC'],
    });
  });
});
