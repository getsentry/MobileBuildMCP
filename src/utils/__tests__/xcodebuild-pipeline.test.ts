import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  createXcodebuildPipeline,
  invocationRequestToHeaderParams,
} from '../xcodebuild-pipeline.ts';
import { STAGE_RANK } from '../../types/domain-fragments.ts';
import type { AnyFragment, DomainFragment } from '../../types/domain-fragments.ts';
import { renderCliTextTranscript } from '../renderers/cli-text-renderer.ts';
import type { StructuredToolOutput } from '../../rendering/types.ts';

describe('xcodebuild-pipeline', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.MOBILEBUILDMCP_RUNTIME = 'mcp';
    delete process.env.MOBILEBUILDMCP_CLI_OUTPUT_FORMAT;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('produces MCP content from xcodebuild test output', () => {
    const emittedEvents: AnyFragment[] = [];
    const pipeline = createXcodebuildPipeline({
      operation: 'TEST',
      toolName: 'test_sim',
      params: { scheme: 'MyApp' },
      emit: (event) => emittedEvents.push(event),
    });

    pipeline.emitFragment({
      kind: 'test-result',
      fragment: 'invocation',
      operation: 'TEST',
      request: { scheme: 'MyApp' },
    });

    pipeline.onStdout('Resolve Package Graph\n');
    pipeline.onStdout('CompileSwift normal arm64 /tmp/App.swift\n');
    pipeline.onStdout("Test Case '-[Suite testA]' passed (0.001 seconds)\n");
    pipeline.onStdout("Test Case '-[Suite testB]' failed (0.002 seconds)\n");

    const result = pipeline.finalize(false, 2345);

    expect(result.state.finalStatus).toBe('FAILED');
    expect(result.state.completedTests).toBe(2);
    expect(result.state.failedTests).toBe(1);
    expect(result.state.milestones.map((m) => m.stage)).toContain('RESOLVING_PACKAGES');
    expect(result.state.milestones.map((m) => m.stage)).toContain('COMPILING');

    const structuredOutput: StructuredToolOutput = {
      schema: 'mobilebuildmcp.output.test-result',
      schemaVersion: '1.0.0',
      result: {
        kind: 'test-result',
        didError: true,
        error: 'Tests failed',
        summary: {
          status: 'FAILED',
          durationMs: 2345,
          target: 'simulator',
          counts: {
            passed: 1,
            failed: 1,
            skipped: 0,
          },
        },
        artifacts: { buildLogPath: pipeline.logPath },
        diagnostics: {
          warnings: [],
          errors: [],
          testFailures: [],
        },
      },
    };

    const text = renderCliTextTranscript({
      items: emittedEvents,
      structuredOutput,
    });
    expect(text).toContain('Test');
    expect(text).not.toContain('Resolving packages');

    expect(emittedEvents.length).toBeGreaterThan(0);
    const fragmentTypes = emittedEvents.map((e) => e.fragment);
    expect(fragmentTypes).toContain('invocation');
    expect(fragmentTypes).toContain('build-stage');
    expect(fragmentTypes).toContain('test-progress');
    expect(fragmentTypes).toContain('build-summary');
    expect(text.match(/1 test failed, 1 passed, 0 skipped/g)).toHaveLength(1);
  });

  it('detects xcresult paths from xcodebuild result bundle output', () => {
    const pipeline = createXcodebuildPipeline({
      operation: 'TEST',
      toolName: 'test_sim',
      params: { scheme: 'MyApp' },
      emit: () => {},
    });

    pipeline.onStderr(
      '2026-05-06 10:00:00.000 xcodebuild[123:456] Writing error result bundle to /tmp/My App Tests.xcresult\n',
    );

    expect(pipeline.xcresultPath).toBe('/tmp/My App Tests.xcresult');
  });

  it('detects result bundle written messages and standalone xcresult paths', () => {
    const pipeline = createXcodebuildPipeline({
      operation: 'TEST',
      toolName: 'test_sim',
      params: { scheme: 'MyApp' },
      emit: () => {},
    });

    pipeline.onStdout('Result bundle written to: /tmp/First Tests.xcresult\n');
    expect(pipeline.xcresultPath).toBe('/tmp/First Tests.xcresult');

    pipeline.onStdout('/tmp/Second Tests.xcresult\n');
    expect(pipeline.xcresultPath).toBe('/tmp/Second Tests.xcresult');
  });

  it('does not treat xcodebuild command invocations as standalone xcresult paths', () => {
    const pipeline = createXcodebuildPipeline({
      operation: 'TEST',
      toolName: 'test_sim',
      params: { scheme: 'MyApp' },
      emit: () => {},
    });

    pipeline.onStdout(
      '/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild -scheme MyApp -resultBundlePath /tmp/MyApp.xcresult\n',
    );

    expect(pipeline.xcresultPath).toBeNull();
  });

  it('handles build output with warnings and errors', () => {
    const emittedEvents: AnyFragment[] = [];
    const pipeline = createXcodebuildPipeline({
      operation: 'BUILD',
      toolName: 'build_sim',
      params: { scheme: 'MyApp' },
      emit: (event) => emittedEvents.push(event),
    });

    pipeline.onStdout('CompileSwift normal arm64 /tmp/App.swift\n');
    pipeline.onStdout('/tmp/App.swift:10:5: warning: variable unused\n');
    pipeline.onStdout("/tmp/App.swift:20:3: error: type 'Foo' has no member 'bar'\n");

    const result = pipeline.finalize(false, 500);

    expect(result.state.warnings).toHaveLength(1);
    expect(result.state.errors).toHaveLength(1);
    expect(result.state.finalStatus).toBe('FAILED');
    expect(
      emittedEvents.some(
        (event) =>
          event.fragment === 'build-summary' &&
          event.operation === 'BUILD' &&
          event.status === 'FAILED' &&
          event.durationMs === 500,
      ),
    ).toBe(true);
  });

  it('supports multi-phase with minimumStage', () => {
    // Phase 1: build-for-testing
    const phase1Events: AnyFragment[] = [];
    const phase1 = createXcodebuildPipeline({
      operation: 'TEST',
      toolName: 'test_sim',
      params: {},
      emit: (event) => phase1Events.push(event),
    });

    phase1.onStdout('Resolve Package Graph\n');
    phase1.onStdout('CompileSwift normal arm64 /tmp/App.swift\n');

    const phase1Rank = phase1.highestStageRank();
    expect(phase1Rank).toBe(STAGE_RANK.COMPILING);

    phase1.finalize(true, 1000);

    // Phase 2: test-without-building, skipping stages already seen
    const stageEntries = Object.entries(STAGE_RANK) as Array<[string, number]>;
    const minStage = stageEntries.find(([, rank]) => rank === phase1Rank)?.[0] as
      | 'COMPILING'
      | undefined;

    const phase2Events: AnyFragment[] = [];
    const phase2 = createXcodebuildPipeline({
      operation: 'TEST',
      toolName: 'test_sim',
      params: {},
      minimumStage: minStage,
      emit: (event) => phase2Events.push(event),
    });

    // These should be suppressed
    phase2.onStdout('Resolve Package Graph\n');
    phase2.onStdout('CompileSwift normal arm64 /tmp/App.swift\n');
    // This should pass through
    phase2.onStdout("Test Case '-[Suite testA]' passed (0.001 seconds)\n");

    const result = phase2.finalize(true, 2000);

    // Only RUN_TESTS milestone (auto-inserted from test-progress), not RESOLVING_PACKAGES or COMPILING
    const milestoneStages = result.state.milestones.map((m) => m.stage);
    expect(milestoneStages).not.toContain('RESOLVING_PACKAGES');
    expect(milestoneStages).not.toContain('COMPILING');
    expect(milestoneStages).toContain('RUN_TESTS');
    expect(result.state.completedTests).toBe(1);
  });

  it('emitFragment passes tool-originated events through the pipeline', () => {
    const emittedEvents: AnyFragment[] = [];
    const pipeline = createXcodebuildPipeline({
      operation: 'TEST',
      toolName: 'test_sim',
      params: {},
      emit: (event) => emittedEvents.push(event),
    });

    pipeline.emitFragment({
      kind: 'test-result',
      fragment: 'test-discovery',
      operation: 'TEST',
      total: 3,
      tests: ['testA', 'testB', 'testC'],
      truncated: false,
    });

    pipeline.finalize(true, 100);

    const discoveryEvents = emittedEvents.filter((e) => e.fragment === 'test-discovery');
    expect(discoveryEvents).toHaveLength(1);

    const text = renderCliTextTranscript({
      items: emittedEvents,
      structuredOutput: {
        schema: 'mobilebuildmcp.output.test-result',
        schemaVersion: '1.0.0',
        result: {
          kind: 'test-result',
          didError: false,
          error: null,
          summary: {
            status: 'SUCCEEDED',
            durationMs: 100,
            target: 'simulator',
            counts: { passed: 3, failed: 0, skipped: 0 },
          },
          artifacts: { buildLogPath: pipeline.logPath },
          diagnostics: {
            warnings: [],
            errors: [],
            testFailures: [],
          },
        },
      },
    });
    expect(text).toContain('Discovered 3 test(s):');
    expect(text).toContain('✅ 3 tests passed, 0 failed, 0 skipped');
  });

  it('renders test discovery in cli-text mode', () => {
    const emittedEvents: AnyFragment[] = [
      {
        kind: 'test-result',
        fragment: 'test-discovery',
        operation: 'TEST',
        total: 8,
        tests: ['testA', 'testB', 'testC', 'testD', 'testE', 'testF', 'testG', 'testH'],
        truncated: false,
      },
    ];

    const writes: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    try {
      process.stdout.write(
        renderCliTextTranscript({
          items: emittedEvents,
          structuredOutput: {
            schema: 'mobilebuildmcp.output.test-result',
            schemaVersion: '1.0.0',
            result: {
              kind: 'test-result',
              didError: false,
              error: null,
              summary: {
                status: 'SUCCEEDED',
                durationMs: 100,
                target: 'simulator',
                counts: { passed: 8, failed: 0, skipped: 0 },
              },
              artifacts: { buildLogPath: '/tmp/Test.xcresult' },
              diagnostics: {
                warnings: [],
                errors: [],
                testFailures: [],
              },
            },
          },
        }),
      );
    } finally {
      writeSpy.mockRestore();
    }

    const output = writes.join('');
    expect(output).toContain('Discovered 8 test(s):');
    expect(output).toContain('   testA\n');
    expect(output).toContain('   testF\n');
    expect(output).not.toContain('   testG\n');
    expect(output).toContain('   (...and 2 more)');
  });

  it('derives header DerivedData from request workspacePath', () => {
    const params = invocationRequestToHeaderParams({
      scheme: 'MyApp',
      workspacePath: '/path/to/MyApp.xcworkspace',
    });

    expect(params).toContainEqual({ label: 'Workspace', value: '/path/to/MyApp.xcworkspace' });
    expect(params).toContainEqual({
      label: 'Derived Data',
      value: expect.stringMatching(/MyApp-[a-f0-9]{12}$/),
    });
  });

  it('does not add DerivedData header rows for package-only requests', () => {
    const params = invocationRequestToHeaderParams({
      target: 'swift-package',
      packagePath: '/path/to/Package',
    });

    expect(params.some((param) => param.label === 'Derived Data')).toBe(false);
  });

  it('produces JSONL output in CLI json mode', () => {
    process.env.MOBILEBUILDMCP_RUNTIME = 'cli';
    process.env.MOBILEBUILDMCP_CLI_OUTPUT_FORMAT = 'json';

    const emittedEvents: AnyFragment[] = [];
    const pipeline = createXcodebuildPipeline({
      operation: 'BUILD',
      toolName: 'build_sim',
      params: {},
      emit: (event) => emittedEvents.push(event),
    });

    pipeline.onStdout('CompileSwift normal arm64 /tmp/App.swift\n');
    pipeline.finalize(true, 100);

    expect(emittedEvents.length).toBeGreaterThan(0);

    // Each emitted fragment should be valid JSON-serializable with required fields
    for (const event of emittedEvents) {
      const parsed = JSON.parse(JSON.stringify(event));
      expect(parsed).toHaveProperty('fragment');
    }
  });
});
