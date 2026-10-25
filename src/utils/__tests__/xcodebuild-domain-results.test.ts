import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  extractTestSummaryCountsFromXcresult: vi.fn(),
}));

vi.mock('../xcresult-test-failures.ts', () => ({
  extractTestSummaryCountsFromXcresult: mocks.extractTestSummaryCountsFromXcresult,
}));

import { createBuildDomainResult, createTestDomainResult } from '../xcodebuild-domain-results.ts';
import { createXcodebuildRunState, type XcodebuildRunState } from '../xcodebuild-run-state.ts';
import type { StartedPipeline, XcodebuildPipeline } from '../xcodebuild-pipeline.ts';

function createStartedPipelineWithState(
  state: XcodebuildRunState,
  xcresultPath: string | null = null,
): StartedPipeline {
  const pipeline: XcodebuildPipeline = {
    onStdout(): void {},
    onStderr(): void {},
    emitFragment(): void {},
    finalize() {
      return { state };
    },
    highestStageRank() {
      return 0;
    },
    xcresultPath,
    logPath: '/tmp/build.log',
  };

  return { pipeline, startedAt: Date.now() };
}

describe('xcodebuild-domain-results', () => {
  beforeEach(() => {
    mocks.extractTestSummaryCountsFromXcresult.mockReturnValue(null);
  });

  it('includes detected xcresult paths in test result artifacts', () => {
    const runState = createXcodebuildRunState({ operation: 'TEST' });

    const result = createTestDomainResult({
      started: createStartedPipelineWithState(
        runState.finalize(true, 1000),
        '/tmp/App Tests.xcresult',
      ),
      succeeded: true,
      target: 'simulator',
      artifacts: { buildLogPath: '/tmp/build.log' },
      request: { scheme: 'App' },
    });

    expect(result.artifacts).toMatchObject({
      buildLogPath: '/tmp/build.log',
      xcresultPath: '/tmp/App Tests.xcresult',
    });
  });

  it('does not copy parser-detected xcresult paths into SwiftPM test results', () => {
    const runState = createXcodebuildRunState({ operation: 'TEST' });

    const result = createTestDomainResult({
      started: createStartedPipelineWithState(
        runState.finalize(true, 1000),
        '/tmp/NotFromSwiftPM.xcresult',
      ),
      succeeded: true,
      target: 'swift-package',
      artifacts: { buildLogPath: '/tmp/build.log' },
      request: { target: 'swift-package', packagePath: '/tmp/Package' },
    });

    expect(result.artifacts).toEqual({ buildLogPath: '/tmp/build.log' });
  });

  it('preserves provided xcresult paths when the pipeline does not detect one', () => {
    const runState = createXcodebuildRunState({ operation: 'TEST' });

    const result = createTestDomainResult({
      started: createStartedPipelineWithState(runState.finalize(true, 1000)),
      succeeded: true,
      target: 'macos',
      artifacts: {
        buildLogPath: '/tmp/build.log',
        xcresultPath: '/tmp/User Provided.xcresult',
      },
      request: { scheme: 'App' },
    });

    expect(result.artifacts.xcresultPath).toBe('/tmp/User Provided.xcresult');
  });

  it('uses xcresult top-level declaration counts instead of streamed run counts', () => {
    mocks.extractTestSummaryCountsFromXcresult.mockReturnValue({
      passed: 16,
      failed: 0,
      skipped: 0,
    });

    const runState = createXcodebuildRunState({ operation: 'TEST' });
    runState.push({
      kind: 'test-result',
      fragment: 'test-progress',
      operation: 'TEST',
      completed: 19,
      failed: 0,
      skipped: 0,
    });

    const result = createTestDomainResult({
      started: createStartedPipelineWithState(
        runState.finalize(true, 1000),
        '/tmp/Weather.xcresult',
      ),
      succeeded: true,
      target: 'simulator',
      artifacts: { buildLogPath: '/tmp/build.log' },
      request: { scheme: 'Weather' },
    });

    expect(mocks.extractTestSummaryCountsFromXcresult).toHaveBeenCalledWith(
      '/tmp/Weather.xcresult',
    );
    expect(result.summary.counts).toEqual({ passed: 16, failed: 0, skipped: 0 });
  });

  it('sorts test failures independently of xcodebuild emission order', () => {
    const runState = createXcodebuildRunState({ operation: 'TEST' });
    runState.push({
      kind: 'test-result',
      fragment: 'test-failure',
      operation: 'TEST',
      suite: 'MCPTestsXCTests',
      test: 'testDeliberateFailure()',
      message: 'XCTAssertTrue failed',
      location: 'MCPTestsXCTests.swift:11',
    });
    runState.push({
      kind: 'test-result',
      fragment: 'test-failure',
      operation: 'TEST',
      suite: 'MCPTestTests',
      test: 'deliberateFailure()',
      message: 'Expectation failed',
      location: 'MCPTestTests.swift:11',
    });

    const result = createTestDomainResult({
      started: createStartedPipelineWithState(runState.finalize(false, 1000)),
      succeeded: false,
      target: 'macos',
      artifacts: { buildLogPath: '/tmp/build.log' },
      request: { scheme: 'MCPTest' },
    });

    expect(result.diagnostics.testFailures.map((failure) => failure.suite)).toEqual([
      'MCPTestTests',
      'MCPTestsXCTests',
    ]);
  });

  it('does not duplicate fallback lines represented by multi-line parsed errors', () => {
    const runState = createXcodebuildRunState({ operation: 'BUILD' });
    runState.push({
      kind: 'build-result',
      fragment: 'compiler-diagnostic',
      operation: 'BUILD',
      severity: 'error',
      message:
        'Unable to find a device matching the provided destination specifier:\n{ platform:iOS Simulator, name:iPhone 22, OS:latest }',
      rawLine:
        'xcodebuild: error: Unable to find a device matching the provided destination specifier:\n\t\t{ platform:iOS Simulator, name:iPhone 22, OS:latest }',
    });

    const result = createBuildDomainResult({
      started: createStartedPipelineWithState(runState.finalize(false, 1000)),
      succeeded: false,
      target: 'simulator',
      artifacts: { buildLogPath: '/tmp/build.log' },
      request: { scheme: 'App' },
      fallbackErrorMessages: [
        'xcodebuild: error: Unable to find a device matching the provided destination specifier:',
        '\t\t{ platform:iOS Simulator, name:iPhone 22, OS:latest }',
      ],
    });

    if (!result.diagnostics) {
      throw new Error('Expected diagnostics to be present');
    }

    expect(result.diagnostics.rawOutput).toBeUndefined();
  });

  it('preserves diagnostic-looking fallback lines not represented by parsed errors', () => {
    const runState = createXcodebuildRunState({ operation: 'BUILD' });
    runState.push({
      kind: 'build-result',
      fragment: 'compiler-diagnostic',
      operation: 'BUILD',
      severity: 'error',
      location: '/tmp/App.swift:8',
      message: 'type mismatch',
      rawLine: '/tmp/App.swift:8:17: error: type mismatch',
    });
    const parsedLine = '/tmp/App.swift:8:17: error: type mismatch';
    const unparsedLine =
      '2026-04-23 12:00:00.000 xcodebuild[123:456] error: IDE operation failed\n  additional details';

    const result = createBuildDomainResult({
      started: createStartedPipelineWithState(runState.finalize(false, 1000)),
      succeeded: false,
      target: 'simulator',
      artifacts: { buildLogPath: '/tmp/build.log' },
      request: { scheme: 'App' },
      fallbackErrorMessages: [
        parsedLine,
        unparsedLine,
        '/tmp/Bridge.cpp:4:2: warning: quoted execution error: message',
        '    4 | log("execution error: message");',
        '/tmp/Bridge.cpp:2:3: note: quoted execution error: message',
        'ordinary progress line',
      ],
    });

    expect(result.diagnostics).toMatchObject({
      errors: [{ location: '/tmp/App.swift:8', message: 'type mismatch' }],
      rawOutput: [unparsedLine],
    });
  });
});
