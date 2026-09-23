import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DomainFragment } from '../../types/domain-fragments.ts';
import type { RuntimeStatusFragment } from '../../types/runtime-status.ts';
import type { StructuredToolOutput } from '../types.ts';
import { createRenderSession, renderTranscript } from '../render.ts';
import { createStructuredErrorOutput } from '../../utils/structured-error.ts';
import { createCliTextRenderer } from '../../utils/renderers/cli-text-renderer.ts';
import type { NextStep } from '../../types/common.ts';

interface TranscriptFixture {
  progressEvents: DomainFragment[];
  structuredOutput?: StructuredToolOutput;
  nextSteps?: NextStep[];
  nextStepsRuntime?: 'cli' | 'daemon' | 'mcp';
}

function captureCliText(fixture: TranscriptFixture): string {
  const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const renderer = createCliTextRenderer({ interactive: false });

  for (const event of fixture.progressEvents) {
    renderer.onFragment(event);
  }
  if (fixture.structuredOutput) {
    renderer.setStructuredOutput(fixture.structuredOutput);
  }
  if (fixture.nextSteps) {
    renderer.setNextSteps(fixture.nextSteps, fixture.nextStepsRuntime ?? 'cli');
  }
  renderer.finalize();

  return stdoutWrite.mock.calls.flat().join('');
}

describe('text render parity', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not mark emitted error fragments as final render errors', () => {
    const session = createRenderSession('text');
    const fragment: RuntimeStatusFragment = {
      kind: 'infrastructure',
      fragment: 'status',
      level: 'error',
      message: 'Transient progress error',
    };

    session.emit(fragment);

    expect(session.isError()).toBe(false);
  });

  it('marks explicit structured error output as a final render error', () => {
    const session = createRenderSession('text');

    session.setStructuredOutput?.(
      createStructuredErrorOutput({
        category: 'runtime',
        code: 'TEST_ERROR',
        message: 'Final error',
      }),
    );

    expect(session.isError()).toBe(true);
  });

  it('renders structured-only error output text', () => {
    const fixture: TranscriptFixture = {
      progressEvents: [],
      structuredOutput: createStructuredErrorOutput({
        category: 'runtime',
        code: 'TEST_ERROR',
        message: 'Final error',
      }),
    };

    const rendered = renderTranscript(
      {
        items: fixture.progressEvents,
        structuredOutput: fixture.structuredOutput,
      },
      'text',
    );

    expect(rendered).toBe(captureCliText(fixture));
    expect(rendered).toContain('Final error');
    expect(rendered).toContain('Category: runtime');
    expect(rendered).toContain('Code: TEST_ERROR');
  });

  it('matches non-interactive cli text for discovery and summary output', () => {
    const fixture: TranscriptFixture = {
      progressEvents: [
        {
          kind: 'test-result',
          fragment: 'invocation',
          operation: 'TEST',
          request: { scheme: 'CalculatorApp', configuration: 'Debug', platform: 'iOS Simulator' },
        },
        {
          kind: 'test-result',
          fragment: 'test-discovery',
          operation: 'TEST',
          total: 1,
          tests: ['CalculatorAppTests/CalculatorAppTests/testAddition'],
          truncated: false,
        },
      ],
      structuredOutput: {
        schema: 'mobilebuildmcp.output.test-result',
        schemaVersion: '1.0.0',
        result: {
          kind: 'test-result',
          didError: false,
          error: null,
          summary: {
            status: 'SUCCEEDED',
            durationMs: 1500,
            counts: { passed: 1, failed: 0, skipped: 0 },
          },
          artifacts: { deviceId: 'SIMULATOR-1' },
          diagnostics: { warnings: [], errors: [], testFailures: [] },
        },
      },
    };

    expect(
      renderTranscript(
        {
          items: fixture.progressEvents,
          structuredOutput: fixture.structuredOutput,
          nextSteps: fixture.nextSteps,
          nextStepsRuntime: fixture.nextStepsRuntime,
        },
        'text',
      ),
    ).toBe(captureCliText(fixture));
  });

  it('matches non-interactive cli text for failure diagnostics and summary spacing', () => {
    const fixture: TranscriptFixture = {
      progressEvents: [
        {
          kind: 'test-result',
          fragment: 'invocation',
          operation: 'TEST',
          request: { scheme: 'MCPTest', configuration: 'Debug', platform: 'macOS' },
        },
        {
          kind: 'test-result',
          fragment: 'test-discovery',
          operation: 'TEST',
          total: 2,
          tests: [
            'MCPTestTests/MCPTestTests/appNameIsCorrect',
            'MCPTestTests/MCPTestsXCTests/testAppNameIsCorrect',
          ],
          truncated: false,
        },
        {
          kind: 'test-result',
          fragment: 'test-failure',
          operation: 'TEST',
          suite: 'MCPTestsXCTests',
          test: 'testDeliberateFailure()',
          message: 'XCTAssertTrue failed',
          location: 'MCPTestsXCTests.swift:11',
        },
      ],
      structuredOutput: {
        schema: 'mobilebuildmcp.output.test-result',
        schemaVersion: '1.0.0',
        result: {
          kind: 'test-result',
          didError: true,
          error: null,
          summary: {
            status: 'FAILED',
            durationMs: 2200,
            counts: { passed: 1, failed: 1, skipped: 0 },
          },
          artifacts: { deviceId: 'MAC-1' },
          diagnostics: { warnings: [], errors: [], testFailures: [] },
        },
      },
    };

    expect(
      renderTranscript(
        {
          items: fixture.progressEvents,
          structuredOutput: fixture.structuredOutput,
          nextSteps: fixture.nextSteps,
          nextStepsRuntime: fixture.nextStepsRuntime,
        },
        'text',
      ),
    ).toBe(captureCliText(fixture));
  });

  it('does not duplicate streamed test discovery, failures, or summary from structured output fallback', () => {
    const fixture: TranscriptFixture = {
      progressEvents: [
        {
          kind: 'test-result',
          fragment: 'invocation',
          operation: 'TEST',
          request: { scheme: 'MCPTest' },
        },
        {
          kind: 'test-result',
          fragment: 'test-discovery',
          operation: 'TEST',
          total: 2,
          tests: ['MCPTestTests/testOne', 'MCPTestTests/testTwo'],
          truncated: false,
        },
        {
          kind: 'test-result',
          fragment: 'test-failure',
          operation: 'TEST',
          suite: 'MCPTestTests',
          test: 'testTwo()',
          message: 'XCTAssertTrue failed',
          location: 'MCPTestTests.swift:11',
        },
        {
          kind: 'test-result',
          fragment: 'build-summary',
          operation: 'TEST',
          status: 'FAILED',
          totalTests: 2,
          passedTests: 1,
          failedTests: 1,
          skippedTests: 0,
          durationMs: 2200,
        },
      ],
      structuredOutput: {
        schema: 'mobilebuildmcp.output.test-result',
        schemaVersion: '1.0.0',
        result: {
          kind: 'test-result',
          didError: true,
          error: null,
          summary: {
            status: 'FAILED',
            durationMs: 2200,
            counts: { passed: 1, failed: 1, skipped: 0 },
          },
          artifacts: {
            buildLogPath: '/tmp/Test.log',
            xcresultPath: '/tmp/App Tests.xcresult',
          },
          diagnostics: {
            warnings: [],
            errors: [],
            testFailures: [
              {
                suite: 'MCPTestTests',
                test: 'testTwo()',
                message: 'XCTAssertTrue failed',
                location: 'MCPTestTests.swift:11',
              },
            ],
          },
          tests: {
            discovered: {
              total: 2,
              items: ['MCPTestTests/testOne', 'MCPTestTests/testTwo'],
            },
          },
        },
      },
    };

    const output = renderTranscript(
      {
        items: fixture.progressEvents,
        structuredOutput: fixture.structuredOutput,
      },
      'text',
    );

    expect(output).toBe(captureCliText(fixture));
    expect(output.match(/Discovered 2 test\(s\):/g)).toHaveLength(1);
    expect(output.match(/MCPTestTests\n {2}✗ testTwo\(\):/g)).toHaveLength(1);
    expect(output.match(/1 test failed, 1 passed, 0 skipped/g)).toHaveLength(1);
    expect(output).toContain('Result Bundle: /tmp/App Tests.xcresult');
    expect(output).toContain('Build Logs: /tmp/Test.log');
  });

  it('matches cli text and uses structured build summary when streamed build-summary disagrees', () => {
    const fixture: TranscriptFixture = {
      progressEvents: [
        {
          kind: 'build-result',
          fragment: 'invocation',
          operation: 'BUILD',
          request: {
            scheme: 'MyApp',
            projectPath: '/tmp/MyApp.xcodeproj',
            configuration: 'Debug',
            platform: 'iOS Simulator',
          },
        },
        {
          kind: 'build-result',
          fragment: 'build-summary',
          operation: 'BUILD',
          status: 'FAILED',
          durationMs: 9900,
        },
      ],
      structuredOutput: {
        schema: 'mobilebuildmcp.output.build-result',
        schemaVersion: '1.0.0',
        result: {
          kind: 'build-result',
          didError: false,
          error: null,
          summary: { status: 'SUCCEEDED', durationMs: 3200 },
          artifacts: { scheme: 'MyApp', buildLogPath: '/tmp/build.log' },
          diagnostics: { warnings: [], errors: [] },
        },
      },
    };

    const rendered = renderTranscript(
      {
        items: fixture.progressEvents,
        structuredOutput: fixture.structuredOutput,
      },
      'text',
    );

    expect(rendered).toBe(captureCliText(fixture));
    expect(rendered).toContain('✅ Build succeeded. (⏱️ 3.2s)');
    expect(rendered).not.toContain('❌ Build failed. (⏱️ 9.9s)');
  });

  it('omits header frontmatter for minimal style text transcripts', () => {
    const input = {
      items: [],
      structuredOutput: {
        schema: 'mobilebuildmcp.output.build-run-result',
        schemaVersion: '1.0.0',
        result: {
          kind: 'build-run-result' as const,
          request: {
            scheme: 'MyApp',
            projectPath: '/tmp/MyApp.xcodeproj',
            configuration: 'Debug',
            platform: 'iOS Simulator',
          },
          didError: false,
          error: null,
          summary: { status: 'SUCCEEDED' as const, durationMs: 5000 },
          artifacts: { appPath: '/tmp/build/MyApp.app', buildLogPath: '/tmp/build.log' },
          diagnostics: { warnings: [], errors: [] },
        },
      },
    };

    const output = renderTranscript(input, 'text', { outputStyle: 'minimal' });
    const mcpDefaultOutput = renderTranscript(input, 'text', { runtime: 'mcp' });
    const cliOverrideOutput = renderTranscript(input, 'text', {
      runtime: 'cli',
      outputStyle: 'minimal',
    });

    for (const rendered of [output, mcpDefaultOutput, cliOverrideOutput]) {
      expect(rendered).toContain('🚀 Build & Run');
      expect(rendered).not.toContain('Scheme: MyApp');
      expect(rendered).not.toContain('Project: /tmp/MyApp.xcodeproj');
      expect(rendered).not.toContain('Configuration: Debug');
      expect(rendered).toContain('✅ Build succeeded. (⏱️ 5.0s)');
    }
  });

  it('defaults minimal style text transcripts to tree artifact paths unless explicitly overridden', () => {
    const input = {
      items: [],
      structuredOutput: {
        schema: 'mobilebuildmcp.output.app-path',
        schemaVersion: '1.0.0',
        result: {
          kind: 'app-path' as const,
          request: {
            scheme: 'MyApp',
            projectPath: '/tmp/MyApp.xcodeproj',
          },
          didError: false,
          error: null,
          artifacts: { appPath: '/tmp/build/MyApp.app' },
        },
      },
    };

    const minimalOutput = renderTranscript(input, 'text', { outputStyle: 'minimal' });
    const overriddenOutput = renderTranscript(input, 'text', {
      outputStyle: 'minimal',
      filePathRenderStyle: 'list',
    });

    expect(minimalOutput).toContain('└── /tmp/build/MyApp.app — App Path');
    expect(minimalOutput).not.toContain('└ App Path: /tmp/build/MyApp.app');
    expect(overriddenOutput).toContain('└ App Path: /tmp/build/MyApp.app');
    expect(overriddenOutput).not.toContain('└── /tmp/build/MyApp.app — App Path');
  });

  it('renders next steps in MCP tool-call syntax for MCP runtime text transcripts', () => {
    const fixture: TranscriptFixture = {
      progressEvents: [],
      structuredOutput: {
        schema: 'mobilebuildmcp.output.build-result',
        schemaVersion: '1.0.0',
        result: {
          kind: 'build-result',
          didError: false,
          error: null,
          summary: {
            status: 'SUCCEEDED',
            durationMs: 7100,
          },
          artifacts: { scheme: 'MCPTest' },
          diagnostics: { warnings: [], errors: [] },
        },
      },
      nextStepsRuntime: 'mcp',
      nextSteps: [
        {
          label: 'Get built macOS app path',
          tool: 'get_mac_app_path',
          cliTool: 'get-app-path',
          workflow: 'macos',
          params: {
            scheme: 'MCPTest',
          },
        },
      ],
    };

    const output = renderTranscript(
      {
        items: fixture.progressEvents,
        structuredOutput: fixture.structuredOutput,
        nextSteps: fixture.nextSteps,
        nextStepsRuntime: fixture.nextStepsRuntime,
      },
      'text',
    );
    expect(output).toBe(captureCliText(fixture));
    expect(output).toContain('get_mac_app_path({ scheme: "MCPTest" })');
    expect(output).not.toContain('mobilebuildmcp macos get-app-path');
  });

  it('does not capture streaming fragments for render session final text', () => {
    const session = createRenderSession('text');
    const request = {
      scheme: 'MyApp',
      projectPath: '/tmp/MyApp.xcodeproj',
      configuration: 'Debug',
      platform: 'iOS Simulator',
    };
    const invocation: DomainFragment = {
      kind: 'build-result',
      fragment: 'invocation',
      operation: 'BUILD',
      request,
    };
    const buildStage: DomainFragment = {
      kind: 'build-result',
      fragment: 'build-stage',
      operation: 'BUILD',
      stage: 'COMPILING',
      message: 'Compiling App.swift',
    };
    const streamedWarning: DomainFragment = {
      kind: 'build-result',
      fragment: 'warning',
      message: 'streamed warning should stay transient',
    };
    const buildSummary: DomainFragment = {
      kind: 'build-result',
      fragment: 'build-summary',
      operation: 'BUILD',
      status: 'SUCCEEDED',
      durationMs: 3200,
    };
    const transcriptLine: DomainFragment = {
      kind: 'transcript',
      fragment: 'process-line',
      stream: 'stderr',
      line: 'raw xcodebuild line\n',
    };

    session.emit(invocation);
    session.emit(buildStage);
    session.emit(streamedWarning);
    session.emit(buildSummary);
    session.emit(transcriptLine);
    session.setStructuredOutput?.({
      schema: 'mobilebuildmcp.output.build-result',
      schemaVersion: '1.0.0',
      result: {
        kind: 'build-result',
        request,
        didError: false,
        error: null,
        summary: { status: 'SUCCEEDED', durationMs: 3200 },
        artifacts: { buildLogPath: '/tmp/build.log' },
        diagnostics: {
          warnings: [{ message: 'final warning from structured output' }],
          errors: [],
        },
      },
    });

    const rendered = session.finalize();

    expect(rendered).toContain('Scheme: MyApp');
    expect(rendered).toContain('Build succeeded');
    expect(rendered).toContain('final warning from structured output');
    expect(rendered).toContain('Build Logs: /tmp/build.log');
    expect(rendered).not.toContain('Compiling App.swift');
    expect(rendered).not.toContain('streamed warning should stay transient');
    expect(rendered).not.toContain('raw xcodebuild line');
  });

  it('matches for structured-only build-result with request and no fragments', () => {
    const fixture: TranscriptFixture = {
      progressEvents: [],
      structuredOutput: {
        schema: 'mobilebuildmcp.output.build-result',
        schemaVersion: '1.0.0',
        result: {
          kind: 'build-result',
          request: {
            scheme: 'MyApp',
            projectPath: '/tmp/MyApp.xcodeproj',
            configuration: 'Debug',
            platform: 'iOS Simulator',
          },
          didError: false,
          error: null,
          summary: { status: 'SUCCEEDED', durationMs: 3200 },
          artifacts: { buildLogPath: '/tmp/build.log' },
          diagnostics: { warnings: [], errors: [] },
        },
      },
    };

    const rendered = renderTranscript(
      {
        items: fixture.progressEvents,
        structuredOutput: fixture.structuredOutput,
      },
      'text',
    );
    expect(rendered).toBe(captureCliText(fixture));
    expect(rendered).toContain('Build');
    expect(rendered).toContain('Scheme: MyApp');
    expect(rendered).toContain('Build succeeded');
  });

  it('matches non-interactive cli text for structured-only non-build error diagnostics', () => {
    const fixture: TranscriptFixture = {
      progressEvents: [],
      structuredOutput: {
        schema: 'mobilebuildmcp.output.scheme-list',
        schemaVersion: '1.0.0',
        result: {
          kind: 'scheme-list',
          didError: true,
          error: 'Failed to list schemes.',
          artifacts: { workspacePath: '/tmp/Missing.xcworkspace' },
          schemes: [],
          diagnostics: {
            warnings: [{ message: 'Using default destination because none was provided.' }],
            errors: [
              { message: 'xcodebuild: error: The workspace named "Missing" does not exist.' },
            ],
            rawOutput: ['Result bundle written to /tmp/result.xcresult'],
          },
        },
      },
    };

    const rendered = renderTranscript(
      {
        items: fixture.progressEvents,
        structuredOutput: fixture.structuredOutput,
      },
      'text',
    );

    const errorsIndex = rendered.indexOf('Errors (1):');
    const warningsIndex = rendered.indexOf('Warnings (1):');
    const rawOutputIndex = rendered.indexOf('Raw Output:');
    const statusIndex = rendered.indexOf('❌ Failed to list schemes.');

    expect(rendered).toBe(captureCliText(fixture));
    expect(errorsIndex).toBeGreaterThanOrEqual(0);
    expect(warningsIndex).toBeGreaterThan(errorsIndex);
    expect(rawOutputIndex).toBeGreaterThan(warningsIndex);
    expect(statusIndex).toBeGreaterThan(rawOutputIndex);
    expect(rendered).toContain(
      '  ✗ xcodebuild: error: The workspace named "Missing" does not exist.',
    );
    expect(rendered).toContain('  ⚠ Using default destination because none was provided.');
    expect(rendered).not.toContain('🔴 Errors');
    expect(rendered).not.toContain('🔴 Raw Output');
    expect(rendered).not.toContain('❌ xcodebuild: error');
  });

  it('renders next steps in CLI syntax for CLI runtime text transcripts', () => {
    const fixture: TranscriptFixture = {
      progressEvents: [],
      structuredOutput: {
        schema: 'mobilebuildmcp.output.build-result',
        schemaVersion: '1.0.0',
        result: {
          kind: 'build-result',
          didError: false,
          error: null,
          summary: {
            status: 'SUCCEEDED',
            durationMs: 7100,
          },
          artifacts: { scheme: 'MCPTest' },
          diagnostics: { warnings: [], errors: [] },
        },
      },
      nextStepsRuntime: 'cli',
      nextSteps: [
        {
          label: 'Get built macOS app path',
          tool: 'get_mac_app_path',
          cliTool: 'get-app-path',
          workflow: 'macos',
          params: {
            scheme: 'MCPTest',
          },
        },
      ],
    };

    const output = renderTranscript(
      {
        items: fixture.progressEvents,
        structuredOutput: fixture.structuredOutput,
        nextSteps: fixture.nextSteps,
        nextStepsRuntime: fixture.nextStepsRuntime,
      },
      'text',
    );
    expect(output).toBe(captureCliText(fixture));
    expect(output).toContain('mobilebuildmcp macos get-app-path --scheme MCPTest');
    expect(output).not.toContain('get_mac_app_path({');
  });
});
