import { describe, expect, it } from 'vitest';
import { createXcodebuildEventParser } from '../xcodebuild-event-parser.ts';
import { createXcodebuildRunState } from '../xcodebuild-run-state.ts';
import type { DomainFragment } from '../../types/domain-fragments.ts';

function collectEvents(
  operation: 'BUILD' | 'TEST',
  lines: { source: 'stdout' | 'stderr'; text: string }[],
): DomainFragment[] {
  const events: DomainFragment[] = [];
  const parser = createXcodebuildEventParser({
    operation,
    onEvent: (event) => events.push(event),
  });

  for (const { source, text } of lines) {
    if (source === 'stdout') {
      parser.onStdout(text);
    } else {
      parser.onStderr(text);
    }
  }

  parser.flush();
  return events;
}

function collectRunStateEvents(
  lines: { source: 'stdout' | 'stderr'; text: string }[],
): DomainFragment[] {
  const events: DomainFragment[] = [];
  const runState = createXcodebuildRunState({
    operation: 'TEST',
    onEvent: (event) => events.push(event),
  });
  const parser = createXcodebuildEventParser({
    operation: 'TEST',
    onEvent: (event) => {
      switch (event.fragment) {
        case 'build-stage':
        case 'compiler-diagnostic':
        case 'test-discovery':
        case 'test-failure':
        case 'test-progress':
        case 'test-case-result':
          runState.push(event);
          break;
      }
    },
  });

  for (const { source, text } of lines) {
    if (source === 'stdout') {
      parser.onStdout(text);
    } else {
      parser.onStderr(text);
    }
  }

  parser.flush();
  runState.finalize(false);
  return events;
}

describe('xcodebuild-event-parser', () => {
  it('emits status events for package resolution', () => {
    const events = collectEvents('TEST', [{ source: 'stdout', text: 'Resolve Package Graph\n' }]);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      fragment: 'build-stage',
      operation: 'TEST',
      stage: 'RESOLVING_PACKAGES',
      message: 'Resolving packages',
    });
  });

  it('emits status events for compile patterns', () => {
    const events = collectEvents('BUILD', [
      { source: 'stdout', text: 'CompileSwift normal arm64 /tmp/App.swift\n' },
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      fragment: 'build-stage',
      operation: 'BUILD',
      stage: 'COMPILING',
      message: 'Compiling',
    });
  });

  it('emits status events for linking', () => {
    const events = collectEvents('BUILD', [
      { source: 'stdout', text: 'Ld /Build/Products/Debug/MyApp.app/MyApp normal arm64\n' },
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      fragment: 'build-stage',
      operation: 'BUILD',
      stage: 'LINKING',
      message: 'Linking',
    });
  });

  it('emits status events for test start', () => {
    const events = collectEvents('TEST', [{ source: 'stdout', text: 'Testing started\n' }]);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      fragment: 'build-stage',
      stage: 'RUN_TESTS',
    });
  });

  it('emits running-tests status for test suite and case start lines', () => {
    const events = collectEvents('TEST', [
      {
        source: 'stdout',
        text: "Test suite 'WeatherUITests' started on 'Clone 1 of iPhone 17 Pro - WeatherUITests-Runner (12147)'\n",
      },
      {
        source: 'stdout',
        text: "Test case 'WeatherTests/emptySearchReturnsNoResults()' started on 'Clone 2 of iPhone 17 Pro - Weather (12472)'\n",
      },
      {
        source: 'stdout',
        text: '◇ Test "Calculator initializes with correct default values" started.\n',
      },
    ]);

    const stages = events.filter((event) => event.fragment === 'build-stage');
    expect(stages).toHaveLength(3);
    expect(stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fragment: 'build-stage', stage: 'RUN_TESTS' }),
      ]),
    );
  });

  it('emits test-progress events with cumulative counts', () => {
    const events = collectEvents('TEST', [
      { source: 'stdout', text: "Test Case '-[Suite testA]' passed (0.001 seconds)\n" },
      { source: 'stdout', text: "Test Case '-[Suite testB]' failed (0.002 seconds)\n" },
      { source: 'stdout', text: "Test Case '-[Suite testC]' passed (0.003 seconds)\n" },
    ]);

    const progressEvents = events.filter((e) => e.fragment === 'test-progress');
    expect(progressEvents).toHaveLength(3);
    expect(progressEvents[0]).toMatchObject({ completed: 1, failed: 0, skipped: 0 });
    expect(progressEvents[1]).toMatchObject({ completed: 2, failed: 1, skipped: 0 });
    expect(progressEvents[2]).toMatchObject({ completed: 3, failed: 1, skipped: 0 });
  });

  it('emits test-case-result events with status, suite, test, and duration', () => {
    const events = collectEvents('TEST', [
      { source: 'stdout', text: "Test Case '-[Suite testA]' passed (0.001 seconds)\n" },
      { source: 'stdout', text: "Test Case '-[Suite testB]' failed (0.250 seconds)\n" },
    ]);

    const cases = events.filter((e) => e.fragment === 'test-case-result');
    expect(cases).toHaveLength(2);
    expect(cases[0]).toMatchObject({
      fragment: 'test-case-result',
      operation: 'TEST',
      suite: 'Suite',
      test: 'testA',
      status: 'passed',
      durationMs: 1,
    });
    expect(cases[1]).toMatchObject({
      fragment: 'test-case-result',
      operation: 'TEST',
      suite: 'Suite',
      test: 'testB',
      status: 'failed',
      durationMs: 250,
    });
  });

  it('parses modern xcodebuild Test Case lines with destinations', () => {
    const events = collectEvents('TEST', [
      {
        source: 'stdout',
        text: "Test Case '-[WeatherTests testForecast]' passed on 'iPhone 16 Pro' (0.010 seconds)\n",
      },
      {
        source: 'stdout',
        text: "Test case 'WeatherUITests/testSearch()' failed on 'Clone 1 of iPhone 16 Pro' (0.250 seconds)\n",
      },
      {
        source: 'stdout',
        text: "Test case 'WeatherUITests/testOfflineMode()' skipped on 'Clone 2 of iPhone 16 Pro' (0.001 seconds)\n",
      },
    ]);

    const cases = events.filter((e) => e.fragment === 'test-case-result');
    expect(cases).toHaveLength(3);
    expect(cases[0]).toMatchObject({
      suite: 'WeatherTests',
      test: 'testForecast',
      status: 'passed',
      durationMs: 10,
    });
    expect(cases[1]).toMatchObject({
      suite: 'WeatherUITests',
      test: 'testSearch()',
      status: 'failed',
      durationMs: 250,
    });
    expect(cases[2]).toMatchObject({
      suite: 'WeatherUITests',
      test: 'testOfflineMode()',
      status: 'skipped',
      durationMs: 1,
    });

    const progressEvents = events.filter((e) => e.fragment === 'test-progress');
    expect(progressEvents).toHaveLength(3);
    expect(progressEvents[0]).toMatchObject({ completed: 1, failed: 0, skipped: 0 });
    expect(progressEvents[1]).toMatchObject({ completed: 2, failed: 1, skipped: 0 });
    expect(progressEvents[2]).toMatchObject({ completed: 3, failed: 1, skipped: 1 });
  });

  it('emits test-case-result events for Swift Testing passed/failed lines', () => {
    const events = collectEvents('TEST', [
      { source: 'stdout', text: '✔ Test "passingTest()" passed after 0.005 seconds.\n' },
      {
        source: 'stdout',
        text: '✘ Test "failingTest()" failed after 0.010 seconds with 1 issue.\n',
      },
    ]);

    const cases = events.filter((e) => e.fragment === 'test-case-result');
    expect(cases).toHaveLength(2);
    expect(cases[0]).toMatchObject({
      status: 'passed',
      test: 'passingTest()',
      durationMs: 5,
    });
    expect(cases[1]).toMatchObject({
      status: 'failed',
      test: 'failingTest()',
      durationMs: 10,
    });
  });

  it('does not emit test-case-result for BUILD operation', () => {
    const events = collectEvents('BUILD', [
      { source: 'stdout', text: "Test Case '-[Suite testA]' passed (0.001 seconds)\n" },
    ]);

    const cases = events.filter((e) => e.fragment === 'test-case-result');
    expect(cases).toHaveLength(0);
  });

  it('emits test-progress from totals line', () => {
    const events = collectEvents('TEST', [
      {
        source: 'stdout',
        text: 'Executed 5 tests, with 2 failures (0 unexpected) in 1.234 (1.235) seconds\n',
      },
    ]);

    const progressEvents = events.filter((e) => e.fragment === 'test-progress');
    expect(progressEvents).toHaveLength(1);
    expect(progressEvents[0]).toMatchObject({ completed: 5, failed: 2 });
  });

  it('emits test-failure events from diagnostics', () => {
    const events = collectEvents('TEST', [
      {
        source: 'stderr',
        text: '/tmp/Test.swift:52: error: -[Suite testB] : XCTAssertEqual failed: ("0") is not equal to ("1")\n',
      },
    ]);

    const failures = events.filter((e) => e.fragment === 'test-failure');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      fragment: 'test-failure',
      suite: 'Suite',
      test: 'testB',
      location: '/tmp/Test.swift:52',
      message: 'XCTAssertEqual failed: ("0") is not equal to ("1")',
    });
  });

  it('attaches failure duration when the diagnostic and failed test case lines both appear', () => {
    const events = collectEvents('TEST', [
      {
        source: 'stderr',
        text: '/tmp/Test.swift:52: error: -[Suite testB] : XCTAssertEqual failed: ("0") is not equal to ("1")\n',
      },
      { source: 'stdout', text: "Test Case '-[Suite testB]' failed (0.002 seconds)\n" },
    ]);

    const failures = events.filter((e) => e.fragment === 'test-failure');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      fragment: 'test-failure',
      suite: 'Suite',
      test: 'testB',
      location: '/tmp/Test.swift:52',
      message: 'XCTAssertEqual failed: ("0") is not equal to ("1")',
      durationMs: 2,
    });
  });

  it('emits error events for build errors', () => {
    const events = collectEvents('BUILD', [
      {
        source: 'stdout',
        text: "/tmp/App.swift:8:17: error: cannot convert value of type 'String' to specified type 'Int'\n",
      },
    ]);

    const errors = events.filter(
      (e) => e.fragment === 'compiler-diagnostic' && e.severity === 'error',
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      fragment: 'compiler-diagnostic',
      severity: 'error',
      location: '/tmp/App.swift:8',
      message: "cannot convert value of type 'String' to specified type 'Int'",
    });
  });

  it('emits error events for non-location build errors', () => {
    const events = collectEvents('BUILD', [
      { source: 'stdout', text: 'error: emit-module command failed with exit code 1\n' },
    ]);

    const errors = events.filter(
      (e) => e.fragment === 'compiler-diagnostic' && e.severity === 'error',
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      fragment: 'compiler-diagnostic',
      severity: 'error',
      message: 'emit-module command failed with exit code 1',
    });
  });

  it('emits raw error events for diagnostic-looking lines that cannot be structured', () => {
    const events: DomainFragment[] = [];
    const unrecognizedLines: string[] = [];
    const parser = createXcodebuildEventParser({
      operation: 'BUILD',
      onEvent: (event) => events.push(event),
      onUnrecognizedLine: (line) => unrecognizedLines.push(line),
    });
    const line = '2026-04-23 12:00:00.000 xcodebuild[123:456] error: IDE operation failed';

    parser.onStderr(`${line}\n`);
    parser.flush();

    expect(unrecognizedLines).toEqual([]);
    const errors = events.filter(
      (e) => e.fragment === 'compiler-diagnostic' && e.severity === 'error',
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      fragment: 'compiler-diagnostic',
      severity: 'error',
      message: line,
      rawLine: line,
    });
  });

  it('does not emit compiler errors for NSError selector dump lines', () => {
    const events = collectEvents('TEST', [
      { source: 'stderr', text: 'pid:error:,\n' },
      {
        source: 'stderr',
        text: '} (error = Error Domain=FBSOpenApplicationServiceErrorDomain Code=1 "The request was denied" UserInfo={BSErrorCodeDescription=RequestDenied, SimCallingSelector=launchApplicationWithID:options:pid:error:, NSLocalizedDescription=The request was denied})\n',
      },
      {
        source: 'stdout',
        text: "Test Case '-[WeatherTests.WeatherTests testLoadsForecast]' passed (0.002 seconds)\n",
      },
    ]);

    const errors = events.filter(
      (e) => e.fragment === 'compiler-diagnostic' && e.severity === 'error',
    );
    const cases = events.filter((e) => e.fragment === 'test-case-result');

    expect(errors).toHaveLength(0);
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({
      fragment: 'test-case-result',
      status: 'passed',
      suite: 'WeatherTests',
      test: 'testLoadsForecast',
    });
  });

  it('emits swift-testing issue fallbacks as test failures with the full raw line', () => {
    const line =
      '✘ Test "Parameterized failure" recorded an issue with 1 argument value → key:value: opaque failure';
    const events = collectEvents('TEST', [{ source: 'stdout', text: `${line}\n` }]);

    const failures = events.filter((e) => e.fragment === 'test-failure');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      fragment: 'test-failure',
      test: 'Parameterized failure',
      message: line,
    });
  });

  it('accumulates indented continuation lines into the preceding error', () => {
    const events = collectEvents('BUILD', [
      {
        source: 'stderr',
        text: 'xcodebuild: error: Unable to find a device matching the provided destination specifier:\n',
      },
      { source: 'stderr', text: '\t\t{ platform:iOS Simulator, name:iPhone 22, OS:latest }\n' },
      { source: 'stderr', text: '\n' },
    ]);

    const errors = events.filter(
      (e) => e.fragment === 'compiler-diagnostic' && e.severity === 'error',
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      fragment: 'compiler-diagnostic',
      severity: 'error',
      message:
        'Unable to find a device matching the provided destination specifier:\n{ platform:iOS Simulator, name:iPhone 22, OS:latest }',
    });
  });

  it('emits warning events', () => {
    const events = collectEvents('BUILD', [
      { source: 'stdout', text: '/tmp/App.swift:10:5: warning: variable unused\n' },
    ]);

    const warnings = events.filter(
      (e) => e.fragment === 'compiler-diagnostic' && e.severity === 'warning',
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      fragment: 'compiler-diagnostic',
      severity: 'warning',
      location: '/tmp/App.swift:10',
      message: 'variable unused',
    });
  });

  it('emits warning events for prefixed warnings', () => {
    const events = collectEvents('BUILD', [
      { source: 'stdout', text: 'ld: warning: directory not found for option\n' },
    ]);

    const warnings = events.filter(
      (e) => e.fragment === 'compiler-diagnostic' && e.severity === 'warning',
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      fragment: 'compiler-diagnostic',
      severity: 'warning',
      message: 'directory not found for option',
    });
  });

  it('handles split chunks across buffer boundaries', () => {
    const events: DomainFragment[] = [];
    const parser = createXcodebuildEventParser({
      operation: 'TEST',
      onEvent: (event) => events.push(event),
    });

    parser.onStdout('Resolve Pack');
    parser.onStdout('age Graph\n');
    parser.flush();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ fragment: 'build-stage', stage: 'RESOLVING_PACKAGES' });
  });

  it('attaches swift-testing failure duration when the issue and failed result lines both appear', () => {
    const events = collectEvents('TEST', [
      {
        source: 'stdout',
        text: '✘ Test "IntentionalFailureSuite/test" recorded an issue at /tmp/SimpleTests.swift:48:5: Expectation failed: true == false\n',
      },
      {
        source: 'stdout',
        text: '✘ Test "IntentionalFailureSuite/test" failed after 0.003 seconds with 1 issue.\n',
      },
    ]);

    const failures = events.filter((e) => e.fragment === 'test-failure');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      fragment: 'test-failure',
      suite: 'IntentionalFailureSuite',
      test: 'test',
      location: '/tmp/SimpleTests.swift:48',
      message: 'Expectation failed: true == false',
      durationMs: 3,
    });
  });

  it('uses Swift Testing and XCTest summaries once for mixed Calculator test output', () => {
    const xctestPassedLines = Array.from({ length: 21 }, (_, index) => ({
      source: 'stdout' as const,
      text: `Test Case '-[CalculatorAppTests.CalculatorAppTests testPassing${index + 1}]' passed (0.001 seconds).\n`,
    }));
    const events = collectRunStateEvents([
      {
        source: 'stdout',
        text: '✔ Test "Adding single digit numbers" passed after 0.016 seconds.\n',
      },
      {
        source: 'stdout',
        text: '\u200B✔ Test "Adding decimal numbers" passed after 0.012 seconds.\n',
      },
      {
        source: 'stdout',
        text: '✔ Test "Addition operation" with 4 test cases passed after 0.005 seconds.\n',
      },
      {
        source: 'stdout',
        text: '✘ Test "This test should fail to verify error reporting" recorded an issue at CalculatorServiceTests.swift:37:9: Expectation failed: (calculator.display → "0") == "999"\n',
      },
      {
        source: 'stdout',
        text: '✘ Test "This test should fail to verify error reporting" failed after 0.029 seconds with 1 issue.\n',
      },
      {
        source: 'stdout',
        text: '✘ Test run with 34 tests in 9 suites failed after 0.047 seconds with 1 issue.\n',
      },
      ...xctestPassedLines,
      {
        source: 'stderr',
        text: '/Volumes/Developer/MobileBuildMCP/example_projects/iOS_Calculator/CalculatorAppTests/CalculatorAppTests.swift:52: error: -[CalculatorAppTests.CalculatorAppTests testCalculatorServiceFailure] : XCTAssertEqual failed: ("0") is not equal to ("999") - This test should fail - display should be 0, not 999\n',
      },
      {
        source: 'stdout',
        text: "Test Case '-[CalculatorAppTests.CalculatorAppTests testCalculatorServiceFailure]' failed (0.004 seconds).\n",
      },
      {
        source: 'stderr',
        text: '/Volumes/Developer/MobileBuildMCP/example_projects/iOS_Calculator/CalculatorAppTests/CalculatorAppTests.swift:286: error: -[CalculatorAppTests.IntentionalFailureTests test] : XCTAssertTrue failed - This test should fail to verify error reporting\n',
      },
      {
        source: 'stdout',
        text: "Test Case '-[CalculatorAppTests.IntentionalFailureTests test]' failed (0.003 seconds).\n",
      },
      {
        source: 'stdout',
        text: '\t Executed 23 tests, with 2 failures (0 unexpected) in 0.654 (0.665) seconds\n',
      },
    ]);

    const summary = events.filter((event) => event.fragment === 'build-summary').at(-1);
    expect(summary).toMatchObject({
      fragment: 'build-summary',
      operation: 'TEST',
      totalTests: 57,
      passedTests: 54,
      failedTests: 3,
      skippedTests: 0,
    });
  });

  it('reconciles separate Swift Testing run summaries independently', () => {
    const events = collectRunStateEvents([
      {
        source: 'stdout',
        text: '✔ Test "First target test" passed after 0.001 seconds.\n',
      },
      {
        source: 'stdout',
        text: '✔ Test run with 1 test in 1 suite passed after 0.001 seconds.\n',
      },
      {
        source: 'stdout',
        text: '✔ Test "Second target parameterized test" with 4 test cases passed after 0.002 seconds.\n',
      },
      {
        source: 'stdout',
        text: '✔ Test run with 1 test in 1 suite passed after 0.002 seconds.\n',
      },
    ]);

    const summary = events.filter((event) => event.fragment === 'build-summary').at(-1);
    expect(summary).toMatchObject({
      fragment: 'build-summary',
      operation: 'TEST',
      totalTests: 2,
      passedTests: 2,
      failedTests: 0,
      skippedTests: 0,
    });
  });

  it('keeps Swift Testing summary progress monotonic when per-test lines exceed the summary', () => {
    const events = collectEvents('TEST', [
      {
        source: 'stdout',
        text: '✔ Test "First observed case" passed after 0.001 seconds.\n',
      },
      {
        source: 'stdout',
        text: '✔ Test "Second observed case" passed after 0.001 seconds.\n',
      },
      {
        source: 'stdout',
        text: '✔ Test run with 1 test in 1 suite passed after 0.001 seconds.\n',
      },
    ]);

    const progress = events.filter((event) => event.fragment === 'test-progress');
    expect(progress).toEqual([
      expect.objectContaining({ completed: 1, failed: 0, skipped: 0 }),
      expect.objectContaining({ completed: 2, failed: 0, skipped: 0 }),
      expect.objectContaining({ completed: 2, failed: 0, skipped: 0 }),
    ]);
  });

  it('keeps XCTest-style test case lines independent from Swift Testing summaries', () => {
    const events = collectEvents('TEST', [
      {
        source: 'stdout',
        text: "Test case 'WeatherUITests.testSearch()' passed on 'Clone 1' (0.001 seconds)\n",
      },
      {
        source: 'stdout',
        text: '✔ Test run with 1 test in 1 suite passed after 0.001 seconds.\n',
      },
    ]);

    const progress = events.filter((event) => event.fragment === 'test-progress');
    expect(progress).toEqual([
      expect.objectContaining({ completed: 1, failed: 0, skipped: 0 }),
      expect.objectContaining({ completed: 2, failed: 0, skipped: 0 }),
    ]);
  });

  it('does not double-count xcodebuild-formatted Swift Testing lines before a summary', () => {
    const events = collectEvents('TEST', [
      {
        source: 'stdout',
        text: "Test case 'WeatherTests/emptySearchReturnsNoResults()' passed on 'Clone 1' (0.001 seconds)\n",
      },
      {
        source: 'stdout',
        text: '✔ Test run with 1 test in 1 suite passed after 0.001 seconds.\n',
      },
    ]);

    const progress = events.filter((event) => event.fragment === 'test-progress');
    expect(progress).toEqual([
      expect.objectContaining({ completed: 1, failed: 0, skipped: 0 }),
      expect.objectContaining({ completed: 1, failed: 0, skipped: 0 }),
    ]);
  });

  it('defers Swift Testing failure progress until the run summary', () => {
    const events = collectEvents('TEST', [
      {
        source: 'stdout',
        text: '✘ Test "Individually reported failure" failed after 0.001 seconds with 1 issue.\n',
      },
      {
        source: 'stdout',
        text: '✘ Test run with 2 tests in 1 suite failed after 0.001 seconds with 2 issues.\n',
      },
    ]);

    const progress = events.filter((event) => event.fragment === 'test-progress');
    expect(progress).toEqual([expect.objectContaining({ completed: 2, failed: 2, skipped: 0 })]);
  });

  it('keeps parameterized Swift Testing result counts aligned with the run summary', () => {
    const events = collectRunStateEvents([
      {
        source: 'stdout',
        text: '✔ Test "Parameterized test" with 4 test cases passed after 0.001 seconds.\n',
      },
      {
        source: 'stdout',
        text: '✔ Test run with 1 test in 1 suite passed after 0.001 seconds.\n',
      },
    ]);

    const summary = events.filter((event) => event.fragment === 'build-summary').at(-1);
    expect(summary).toMatchObject({
      fragment: 'build-summary',
      operation: 'TEST',
      totalTests: 1,
      passedTests: 1,
      failedTests: 0,
      skippedTests: 0,
    });
  });

  it('processes full test lifecycle', () => {
    const events = collectEvents('TEST', [
      { source: 'stdout', text: 'Resolve Package Graph\n' },
      { source: 'stdout', text: 'CompileSwift normal arm64 /tmp/App.swift\n' },
      { source: 'stdout', text: "Test Case '-[Suite testA]' passed (0.001 seconds)\n" },
      { source: 'stdout', text: "Test Case '-[Suite testB]' failed (0.002 seconds)\n" },
      {
        source: 'stderr',
        text: '/tmp/Test.swift:52: error: -[Suite testB] : XCTAssertEqual failed: ("0") is not equal to ("1")\n',
      },
      {
        source: 'stdout',
        text: 'Executed 2 tests, with 1 failures (0 unexpected) in 0.123 (0.124) seconds\n',
      },
    ]);

    const fragments = events.map((e) => e.fragment);
    expect(fragments).toContain('build-stage');
    expect(fragments).toContain('test-progress');
    expect(fragments).toContain('test-failure');
  });

  it('counts parameterized Swift Testing result lines once for progress', () => {
    const events = collectEvents('TEST', [
      {
        source: 'stdout',
        text: '✔ Test "Parameterized test" with 3 test cases passed after 0.001 seconds.\n',
      },
    ]);

    const progress = events.filter((e) => e.fragment === 'test-progress');
    expect(progress).toHaveLength(1);
    if (progress[0].fragment === 'test-progress') {
      expect(progress[0].completed).toBe(1);
    }
  });

  it('skips Test Suite and Testing started noise lines without emitting events', () => {
    const events = collectEvents('TEST', [
      { source: 'stdout', text: "Test Suite 'All tests' started at 2025-01-01 00:00:00.000.\n" },
      { source: 'stdout', text: "Test Suite 'All tests' passed at 2025-01-01 00:00:01.000.\n" },
    ]);

    // Test Suite 'All tests' started triggers RUN_TESTS status; 'passed' is noise
    const statusEvents = events.filter((e) => e.fragment === 'build-stage');
    expect(statusEvents.length).toBeLessThanOrEqual(1);
  });
});
