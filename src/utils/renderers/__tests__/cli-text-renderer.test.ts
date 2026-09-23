import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StructuredToolOutput } from '../../../rendering/types.ts';
import { createCliTextRenderer, renderCliTextTranscript } from '../cli-text-renderer.ts';

const reporter = {
  update: vi.fn<(message: string) => void>(),
  clear: vi.fn<() => void>(),
};

vi.mock('../../cli-progress-reporter.ts', () => ({
  createCliProgressReporter: () => reporter,
}));

function buildOutput(
  overrides: Partial<Extract<StructuredToolOutput['result'], { kind: 'build-result' }>>,
): StructuredToolOutput {
  const result: Extract<StructuredToolOutput['result'], { kind: 'build-result' }> = {
    kind: 'build-result',
    didError: false,
    error: null,
    summary: { status: 'SUCCEEDED' },
    artifacts: { scheme: 'MyApp', buildLogPath: '/tmp/build.log' },
    diagnostics: { warnings: [], errors: [] },
    ...overrides,
  };

  return {
    schema: 'mobilebuildmcp.output.build-result',
    schemaVersion: '1.0.0',
    result,
  };
}

describe('cli-text-renderer', () => {
  const originalIsTTY = process.stdout.isTTY;
  const originalNoColor = process.env.NO_COLOR;

  beforeEach(() => {
    reporter.update.mockReset();
    reporter.clear.mockReset();
    process.env.NO_COLOR = '1';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: originalIsTTY,
    });

    if (originalNoColor === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = originalNoColor;
    }
  });

  it('renders one blank-line boundary between front matter and first runtime line', () => {
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const renderer = createCliTextRenderer({ interactive: false });

    renderer.onFragment({
      kind: 'build-run-result',
      fragment: 'invocation',
      operation: 'BUILD',
      request: {
        scheme: 'MyApp',
        projectPath: '/tmp/MyApp.xcodeproj',
        configuration: 'Debug',
        platform: 'macOS',
        derivedDataPath: '/tmp/DerivedData',
      },
    });

    renderer.onFragment({
      kind: 'build-result',
      fragment: 'build-stage',
      operation: 'BUILD',
      stage: 'COMPILING',
      message: 'Compiling',
    });

    renderer.onFragment({
      kind: 'infrastructure',
      fragment: 'status',
      level: 'info',
      message: 'Starting xcodebuild',
    });

    const output = stdoutWrite.mock.calls.flat().join('');
    expect(output).toContain(
      '  Derived Data: /tmp/DerivedData\n\n\u{2139}\u{FE0F} Starting xcodebuild\n',
    );
    expect(output).not.toContain('\u203A Compiling\n');
  });

  it('uses transient interactive updates for active phases and durable writes for lasting events', () => {
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const renderer = createCliTextRenderer({ interactive: true });

    renderer.onFragment({
      kind: 'build-run-result',
      fragment: 'invocation',
      operation: 'BUILD',
      request: { scheme: 'MyApp', derivedDataPath: '/tmp/DerivedData' },
    });

    renderer.onFragment({
      kind: 'build-result',
      fragment: 'build-stage',
      operation: 'BUILD',
      stage: 'COMPILING',
      message: 'Compiling',
    });

    renderer.onFragment({
      kind: 'infrastructure',
      fragment: 'status',
      level: 'info',
      message: 'Resolving app path',
    });

    renderer.onFragment({
      kind: 'build-result',
      fragment: 'compiler-diagnostic',
      severity: 'warning',
      operation: 'BUILD',
      message: 'unused variable',
      rawLine: '/tmp/MyApp.swift:10: warning: unused variable',
    });

    renderer.onFragment({
      kind: 'infrastructure',
      fragment: 'status',
      level: 'success',
      message: 'Resolving app path',
    });

    renderer.setStructuredOutput(buildOutput({ summary: { status: 'SUCCEEDED' } }));
    renderer.finalize();

    expect(reporter.update).toHaveBeenCalledWith('Compiling...');
    expect(reporter.update).toHaveBeenCalledWith('Resolving app path...');

    const output = stdoutWrite.mock.calls.flat().join('');
    expect(output).not.toContain('\u203A Compiling\n');
    expect(output).toContain('Warnings (1):');
    expect(output).toContain('unused variable');
    expect(output).toContain('\u{2705} Resolving app path\n');
  });

  it('replaces interactive build-stage updates with test progress updates', () => {
    const renderer = createCliTextRenderer({ interactive: true });

    renderer.onFragment({
      kind: 'test-result',
      fragment: 'build-stage',
      operation: 'TEST',
      stage: 'LINKING',
      message: 'Linking',
    });

    renderer.onFragment({
      kind: 'test-result',
      fragment: 'test-progress',
      operation: 'TEST',
      completed: 4,
      failed: 0,
      skipped: 0,
    });

    expect(reporter.update).toHaveBeenCalledWith('Linking...');
    expect(reporter.update).toHaveBeenCalledWith(
      'Running tests (4 completed, 0 failures, 0 skipped)',
    );
  });

  it('omits settled build warnings when suppressWarnings is set', () => {
    const structuredOutput = buildOutput({
      diagnostics: {
        warnings: [{ message: 'unused variable "foo"', location: 'App.swift:12' }],
        errors: [],
      },
    });

    const shown = renderCliTextTranscript({ structuredOutput });
    expect(shown).toContain('Warnings (1):');
    expect(shown).toContain('unused variable');

    const suppressed = renderCliTextTranscript({ structuredOutput, suppressWarnings: true });
    expect(suppressed).not.toContain('Warnings (1):');
    expect(suppressed).not.toContain('unused variable');
  });

  it('renders non-interactive test progress durably and deduplicates repeated counts', () => {
    const output = renderCliTextTranscript({
      items: [
        {
          kind: 'test-result',
          fragment: 'test-progress',
          operation: 'TEST',
          completed: 1,
          failed: 0,
          skipped: 0,
        },
        {
          kind: 'test-result',
          fragment: 'test-progress',
          operation: 'TEST',
          completed: 1,
          failed: 0,
          skipped: 0,
        },
        {
          kind: 'test-result',
          fragment: 'test-progress',
          operation: 'TEST',
          completed: 2,
          failed: 0,
          skipped: 0,
        },
      ],
    });

    expect(output.match(/Running tests \(1 completed, 0 failures, 0 skipped\)/g)).toHaveLength(1);
    expect(output).toContain('Running tests (2 completed, 0 failures, 0 skipped)');
  });

  it('renders grouped sad-path diagnostics before the failed summary', () => {
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const renderer = createCliTextRenderer({ interactive: false });

    renderer.onFragment({
      kind: 'build-run-result',
      fragment: 'invocation',
      operation: 'BUILD',
      request: {
        scheme: 'MyApp',
        projectPath: '/tmp/MyApp.xcodeproj',
        configuration: 'Debug',
        platform: 'iOS Simulator',
        simulatorId: 'INVALID-SIM-ID-123',
        derivedDataPath: '/tmp/DerivedData',
      },
    });

    renderer.onFragment({
      kind: 'build-result',
      fragment: 'compiler-diagnostic',
      severity: 'error',
      operation: 'BUILD',
      message: 'No available simulator matched: INVALID-SIM-ID-123',
      rawLine: 'No available simulator matched: INVALID-SIM-ID-123',
    });
    renderer.onFragment({
      kind: 'build-result',
      fragment: 'build-summary',
      operation: 'BUILD',
      status: 'FAILED',
      durationMs: 1200,
    });

    renderer.setStructuredOutput(
      buildOutput({ didError: true, summary: { status: 'FAILED', durationMs: 1200 } }),
    );
    renderer.finalize();

    const output = stdoutWrite.mock.calls.flat().join('');
    expect(output).toContain('Errors (1):');
    expect(output).not.toContain('Errors (2):');
    expect(output).toContain('  \u2717 No available simulator matched: INVALID-SIM-ID-123');
    expect(output).toContain('\u{274C} Build failed. (\u{23F1}\u{FE0F} 1.2s)');
  });

  it('does not flush buffered compiler errors after a successful final summary', () => {
    const output = renderCliTextTranscript({
      items: [
        {
          kind: 'test-result',
          fragment: 'compiler-diagnostic',
          severity: 'error',
          operation: 'TEST',
          message: 'SimCallingSelector=launchApplicationWithID:options:pid:error:,',
          rawLine: 'SimCallingSelector=launchApplicationWithID:options:pid:error:,',
        },
        {
          kind: 'test-result',
          fragment: 'build-summary',
          operation: 'TEST',
          status: 'SUCCEEDED',
          totalTests: 1,
          passedTests: 1,
          failedTests: 0,
          skippedTests: 0,
        },
      ],
    });

    expect(output).toContain('✅ 1 test passed, 0 failed, 0 skipped');
    expect(output).not.toContain('Compiler Errors (1):');
    expect(output).not.toContain('SimCallingSelector=launchApplicationWithID:options:pid:error:,');
  });

  it('flushes buffered compiler errors after a failed final summary', () => {
    const output = renderCliTextTranscript({
      items: [
        {
          kind: 'test-result',
          fragment: 'compiler-diagnostic',
          severity: 'error',
          operation: 'TEST',
          message: 'unterminated string literal',
          rawLine: '/tmp/MCPTest/ContentView.swift:16:18: error: unterminated string literal',
        },
        {
          kind: 'test-result',
          fragment: 'build-summary',
          operation: 'TEST',
          status: 'FAILED',
          totalTests: 1,
          passedTests: 0,
          failedTests: 1,
          skippedTests: 0,
        },
      ],
    });

    expect(output).toContain('Compiler Errors (1):');
    expect(output).toContain('unterminated string literal');
  });

  it('flushes buffered compiler errors when final status is unknown', () => {
    const output = renderCliTextTranscript({
      items: [
        {
          kind: 'build-result',
          fragment: 'compiler-diagnostic',
          severity: 'error',
          operation: 'BUILD',
          message: 'unknown build failure',
          rawLine: 'error: unknown build failure',
        },
      ],
    });

    expect(output).toContain('Errors (1):');
    expect(output).toContain('unknown build failure');
  });

  it('groups compiler diagnostics under a nested failure header before the failed summary', () => {
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const renderer = createCliTextRenderer({ interactive: false });

    renderer.onFragment({
      kind: 'build-run-result',
      fragment: 'invocation',
      operation: 'BUILD',
      request: {
        scheme: 'MyApp',
        projectPath: '/tmp/MyApp.xcodeproj',
        configuration: 'Debug',
        platform: 'macOS',
        derivedDataPath: '/tmp/DerivedData',
      },
    });

    renderer.onFragment({
      kind: 'build-result',
      fragment: 'build-stage',
      operation: 'BUILD',
      stage: 'COMPILING',
      message: 'Compiling',
    });

    renderer.onFragment({
      kind: 'build-result',
      fragment: 'compiler-diagnostic',
      severity: 'error',
      operation: 'BUILD',
      message: 'unterminated string literal',
      rawLine: '/tmp/MCPTest/ContentView.swift:16:18: error: unterminated string literal',
    });
    renderer.onFragment({
      kind: 'build-result',
      fragment: 'build-summary',
      operation: 'BUILD',
      status: 'FAILED',
      durationMs: 4000,
    });

    renderer.setStructuredOutput(
      buildOutput({ didError: true, summary: { status: 'FAILED', durationMs: 4000 } }),
    );
    renderer.finalize();

    const output = stdoutWrite.mock.calls.flat().join('');
    expect(output).toContain(
      '  Derived Data: /tmp/DerivedData\n\nCompiler Errors (1):\n\n  \u2717 unterminated string literal\n    /tmp/MCPTest/ContentView.swift:16:18',
    );
    expect(output).not.toContain('\u203A Compiling\n');
    expect(output).not.toContain('error: unterminated string literal\n  ContentView.swift:16:18');
    expect(output).toContain('\n\n\u{274C} Build failed. (\u{23F1}\u{FE0F} 4.0s)');
  });

  it('uses exactly one blank-line boundary between front matter and compiler errors when no runtime line rendered', () => {
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const renderer = createCliTextRenderer({ interactive: false });

    renderer.onFragment({
      kind: 'build-run-result',
      fragment: 'invocation',
      operation: 'BUILD',
      request: {
        scheme: 'MyApp',
        projectPath: '/tmp/MyApp.xcodeproj',
        configuration: 'Debug',
        platform: 'macOS',
        derivedDataPath: '/tmp/DerivedData',
      },
    });

    renderer.onFragment({
      kind: 'build-result',
      fragment: 'compiler-diagnostic',
      severity: 'error',
      operation: 'BUILD',
      message: 'unterminated string literal',
      rawLine: '/tmp/MCPTest/ContentView.swift:16:18: error: unterminated string literal',
    });
    renderer.onFragment({
      kind: 'build-result',
      fragment: 'build-summary',
      operation: 'BUILD',
      status: 'FAILED',
      durationMs: 2000,
    });

    renderer.setStructuredOutput(
      buildOutput({ didError: true, summary: { status: 'FAILED', durationMs: 2000 } }),
    );
    renderer.finalize();

    const output = stdoutWrite.mock.calls.flat().join('');
    expect(output).toContain(
      '  Derived Data: /tmp/DerivedData\n\nCompiler Errors (1):\n\n  \u2717 unterminated string literal\n    /tmp/MCPTest/ContentView.swift:16:18',
    );
    expect(output).not.toContain('  Derived Data: /tmp/DerivedData\n\n\nCompiler Errors (1):');
  });

  it('persists the last transient runtime phase as a durable line before grouped compiler errors', () => {
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const renderer = createCliTextRenderer({ interactive: true });

    renderer.onFragment({
      kind: 'build-run-result',
      fragment: 'invocation',
      operation: 'BUILD',
      request: { scheme: 'MyApp', derivedDataPath: '/tmp/DerivedData' },
    });

    renderer.onFragment({
      kind: 'build-result',
      fragment: 'build-stage',
      operation: 'BUILD',
      stage: 'COMPILING',
      message: 'Compiling',
    });

    renderer.onFragment({
      kind: 'build-result',
      fragment: 'build-stage',
      operation: 'BUILD',
      stage: 'LINKING',
      message: 'Linking',
    });

    renderer.onFragment({
      kind: 'build-result',
      fragment: 'compiler-diagnostic',
      severity: 'error',
      operation: 'BUILD',
      message: 'unterminated string literal',
      rawLine: '/tmp/MCPTest/ContentView.swift:16:18: error: unterminated string literal',
    });
    renderer.onFragment({
      kind: 'build-result',
      fragment: 'build-summary',
      operation: 'BUILD',
      status: 'FAILED',
      durationMs: 4000,
    });

    renderer.setStructuredOutput(
      buildOutput({ didError: true, summary: { status: 'FAILED', durationMs: 4000 } }),
    );
    renderer.finalize();

    expect(reporter.update).toHaveBeenCalledWith('Compiling...');
    expect(reporter.update).toHaveBeenCalledWith('Linking...');

    const output = stdoutWrite.mock.calls.flat().join('');
    expect(output).toContain(
      '\u203A Linking\n\nCompiler Errors (1):\n\n  \u2717 unterminated string literal\n    /tmp/MCPTest/ContentView.swift:16:18',
    );
  });

  it('renders summary, execution-derived footer, and next steps in that order', () => {
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const renderer = createCliTextRenderer({ interactive: false });

    renderer.setStructuredOutput({
      schema: 'mobilebuildmcp.output.build-run-result',
      schemaVersion: '1.0.0',
      result: {
        kind: 'build-run-result',
        didError: false,
        error: null,
        summary: {
          status: 'SUCCEEDED',
          durationMs: 7100,
        },
        artifacts: { appPath: '/tmp/build/MyApp.app' },
        diagnostics: { warnings: [], errors: [] },
      },
    });
    renderer.setNextSteps(
      [{ label: 'Get built macOS app path', cliTool: 'get-app-path', workflow: 'macos' }],
      'cli',
    );
    renderer.finalize();

    const output = stdoutWrite.mock.calls.flat().join('');
    const summaryIndex = output.indexOf('\u{2705} Build succeeded.');
    const footerIndex = output.indexOf('\u{2705} Build & Run complete');
    const nextStepsIndex = output.indexOf('Next steps:');

    expect(summaryIndex).toBeGreaterThanOrEqual(0);
    expect(footerIndex).toBeGreaterThan(summaryIndex);
    expect(nextStepsIndex).toBeGreaterThan(footerIndex);
    expect(output).toContain('\u{2705} Build & Run complete');
    expect(output).toContain('└ App Path: /tmp/build/MyApp.app');
  });

  it('replays buffered build failures once when only a header was emitted', () => {
    const output = renderCliTextTranscript({
      items: [
        {
          kind: 'build-result',
          fragment: 'invocation',
          operation: 'BUILD',
          request: { scheme: 'MyApp', derivedDataPath: '/tmp/DerivedData' },
        },
      ],
      structuredOutput: buildOutput({
        didError: true,
        error: 'Build failed',
        summary: { status: 'FAILED', durationMs: 900 },
        diagnostics: {
          warnings: [],
          errors: [{ message: 'No available simulator matched: INVALID-SIM-ID-123' }],
        },
      }),
    });

    expect(output).toContain('🔨 Build');
    expect(output).toContain('Errors (1):');
    expect(output).not.toContain('Errors (2):');
    expect(output).toContain('No available simulator matched: INVALID-SIM-ID-123');
    expect(output).toContain('❌ Build failed. (⏱️ 0.9s)');
  });

  it('renders structured output for non-streaming app-path results', () => {
    const output = renderCliTextTranscript({
      structuredOutput: {
        schema: 'mobilebuildmcp.output.app-path',
        schemaVersion: '1.0.0',
        result: {
          kind: 'app-path',
          didError: false,
          error: null,
          artifacts: { appPath: '/tmp/MyApp.app' },
        },
      },
    });

    expect(output).toContain('🔍 Get App Path');
    expect(output).toContain('✅ Success');
    expect(output).toContain('└ App Path: /tmp/MyApp.app');
  });

  it('renders runtime UI snapshots as compact target lists', () => {
    const output = renderCliTextTranscript({
      structuredOutput: {
        schema: 'mobilebuildmcp.output.capture-result',
        schemaVersion: '2',
        result: {
          kind: 'capture-result',
          didError: false,
          error: null,
          summary: { status: 'SUCCEEDED' },
          artifacts: { simulatorId: 'SIMULATOR-1' },
          capture: {
            type: 'runtime-snapshot',
            protocol: 'rs/1',
            simulatorId: 'SIMULATOR-1',
            screenHash: 'screen-hash',
            seq: 1,
            capturedAtMs: 1000,
            expiresAtMs: 61000,
            elements: [
              {
                ref: 'e1',
                role: 'button',
                label: 'Add',
                identifier: 'add-button',
                value: 'selected',
                frame: { x: 10, y: 20, width: 30, height: 40 },
                state: { enabled: true, visible: true },
                actions: ['tap', 'longPress'],
              },
              {
                ref: 'e2',
                role: 'text',
                label: 'Total',
                frame: { x: 0, y: 0, width: 100, height: 20 },
                actions: [],
              },
            ],
            actions: [{ action: 'tap', elementRef: 'e1', label: 'Add' }],
          },
        },
      },
    });

    expect(output).toContain('📷 Snapshot UI');
    expect(output).toContain('Targets (1) — ref|action|role|label|value|id');
    expect(output).toContain('e1|tap|button|Add|selected|add-button');
    expect(output).toContain(
      'Runtime UI snapshot captured with 2 elements, 1 likely target, and 0 scroll areas.',
    );
    expect(output).not.toContain('- Use scroll refs with swipe.');
    expect(output).not.toContain('Accessibility Hierarchy');
    expect(output).not.toContain('```json');
  });

  it('renders suppressed runtime evidence without callable refs', () => {
    const output = renderCliTextTranscript({
      structuredOutput: {
        schema: 'mobilebuildmcp.output.capture-result',
        schemaVersion: '2',
        renderHints: { runtimeSnapshot: { suppressedTargetRefs: ['e2'] } },
        result: {
          kind: 'capture-result',
          didError: false,
          error: null,
          summary: { status: 'SUCCEEDED' },
          artifacts: { simulatorId: 'SIMULATOR-1' },
          capture: {
            type: 'runtime-snapshot',
            protocol: 'rs/1',
            simulatorId: 'SIMULATOR-1',
            screenHash: 'screen-hash',
            seq: 1,
            capturedAtMs: 1000,
            expiresAtMs: 61000,
            elements: [
              {
                ref: 'e1',
                role: 'button',
                label: 'Add',
                frame: { x: 10, y: 20, width: 60, height: 40 },
                actions: ['tap'],
              },
              {
                ref: 'e2',
                role: 'button',
                label: 'London, England',
                value: 'not saved',
                frame: { x: 20, y: 80, width: 200, height: 72 },
                state: { visible: true },
                actions: ['tap'],
              },
            ],
            actions: [
              { action: 'tap', elementRef: 'e1', label: 'Add' },
              { action: 'tap', elementRef: 'e2', label: 'London, England' },
            ],
          },
        },
      },
    });

    expect(output).toContain('Targets (1) — ref|action|role|label|value|id');
    expect(output).toContain('e1|tap|button|Add||');
    expect(output).toContain('Evidence (1) — role|label|value|id');
    expect(output).toContain('button|London, England|not saved|');
    expect(output).not.toContain('e2|tap|button|London, England|not saved|');
  });

  it('renders unchanged runtime UI snapshots compactly', () => {
    const output = renderCliTextTranscript({
      structuredOutput: {
        schema: 'mobilebuildmcp.output.capture-result',
        schemaVersion: '2',
        result: {
          kind: 'capture-result',
          didError: false,
          error: null,
          summary: { status: 'SUCCEEDED' },
          artifacts: { simulatorId: 'SIMULATOR-1' },
          capture: {
            type: 'runtime-snapshot-unchanged',
            protocol: 'rs/1',
            simulatorId: 'SIMULATOR-1',
            screenHash: 'screen-hash',
            seq: 2,
          },
        },
      },
    });

    expect(output).toContain('📷 Snapshot UI');
    expect(output).toContain('Runtime UI snapshot unchanged (screenHash: screen-hash, seq: 2).');
    expect(output).not.toContain('Targets (');
    expect(output).not.toContain('Tips');
  });

  it('orders useful runtime targets before chrome controls in compact output', () => {
    const output = renderCliTextTranscript({
      structuredOutput: {
        schema: 'mobilebuildmcp.output.capture-result',
        schemaVersion: '2',
        result: {
          kind: 'capture-result',
          didError: false,
          error: null,
          summary: { status: 'SUCCEEDED' },
          artifacts: { simulatorId: 'SIMULATOR-1' },
          capture: {
            type: 'runtime-snapshot',
            protocol: 'rs/1',
            simulatorId: 'SIMULATOR-1',
            screenHash: 'screen-hash',
            seq: 1,
            capturedAtMs: 1000,
            expiresAtMs: 61000,
            elements: [
              {
                ref: 'e2',
                role: 'button',
                label: 'Sheet Grabber',
                value: 'Expanded',
                frame: { x: 0, y: 0, width: 100, height: 20 },
                actions: ['tap'],
              },
              {
                ref: 'e3',
                role: 'button',
                label: 'Settings',
                frame: { x: 320, y: 40, width: 40, height: 40 },
                actions: ['tap'],
              },
              {
                ref: 'e8',
                role: 'text-field',
                value: 'Portland',
                frame: { x: 20, y: 100, width: 200, height: 40 },
                actions: ['typeText'],
              },
              {
                ref: 'e9',
                role: 'button',
                label: 'Clear search',
                frame: { x: 230, y: 100, width: 40, height: 40 },
                actions: ['tap'],
              },
              {
                ref: 'e10',
                role: 'button',
                label: 'Remove',
                identifier: 'trash',
                frame: { x: 300, y: 180, width: 40, height: 40 },
                actions: ['tap'],
              },
              {
                ref: 'e82',
                role: 'button',
                label: 'PRECIP., 78%, Next 24 hours',
                identifier: 'weather.precipitationCard',
                frame: { x: 20, y: 300, width: 340, height: 140 },
                actions: ['tap'],
              },
            ],
            actions: [
              { action: 'tap', elementRef: 'e2', label: 'Sheet Grabber' },
              { action: 'tap', elementRef: 'e3', label: 'Settings' },
              { action: 'typeText', elementRef: 'e8' },
              { action: 'tap', elementRef: 'e9', label: 'Clear search' },
              { action: 'tap', elementRef: 'e10', label: 'Remove' },
              { action: 'tap', elementRef: 'e82', label: 'PRECIP., 78%, Next 24 hours' },
            ],
          },
        },
      },
    });

    const precipitationIndex = output.indexOf(
      'e82|tap|button|PRECIP., 78%, Next 24 hours||weather.precipitationCard',
    );
    const searchIndex = output.indexOf('e8|typeText|text-field||Portland|');
    const settingsIndex = output.indexOf('e3|tap|button|Settings||');
    const clearSearchIndex = output.indexOf('e9|tap|button|Clear search||');
    const removeIndex = output.indexOf('e10|tap|button|Remove||trash');

    expect(precipitationIndex).toBeGreaterThanOrEqual(0);
    expect(searchIndex).toBeGreaterThan(precipitationIndex);
    expect(settingsIndex).toBeGreaterThan(searchIndex);
    expect(output).not.toContain('e2|tap|button|Sheet Grabber|Expanded|');
    expect(clearSearchIndex).toBeGreaterThan(settingsIndex);
    expect(removeIndex).toBeGreaterThan(settingsIndex);
  });

  it('orders unselected segmented controls before already-selected controls in compact output', () => {
    const output = renderCliTextTranscript({
      structuredOutput: {
        schema: 'mobilebuildmcp.output.capture-result',
        schemaVersion: '2',
        result: {
          kind: 'capture-result',
          didError: false,
          error: null,
          summary: { status: 'SUCCEEDED' },
          artifacts: { simulatorId: 'SIMULATOR-1' },
          capture: {
            type: 'runtime-snapshot',
            protocol: 'rs/1',
            simulatorId: 'SIMULATOR-1',
            screenHash: 'screen-hash',
            seq: 1,
            capturedAtMs: 1000,
            expiresAtMs: 61000,
            elements: [
              {
                ref: 'e9',
                role: 'button',
                label: '°F',
                value: 'selected',
                frame: { x: 20, y: 40, width: 70, height: 44 },
                actions: ['tap'],
              },
              {
                ref: 'e10',
                role: 'button',
                label: '°C',
                value: 'not selected',
                frame: { x: 100, y: 40, width: 70, height: 44 },
                actions: ['tap'],
              },
            ],
            actions: [
              { action: 'tap', elementRef: 'e9', label: '°F' },
              { action: 'tap', elementRef: 'e10', label: '°C' },
            ],
          },
        },
      },
    });

    const selectedIndex = output.indexOf('e9|tap|button|°F|selected|');
    const unselectedIndex = output.indexOf('e10|tap|button|°C|not selected|');

    expect(unselectedIndex).toBeGreaterThanOrEqual(0);
    expect(selectedIndex).toBeGreaterThan(unselectedIndex);
  });

  it('does not list static text as a likely runtime target when only low-level actions are present', () => {
    const output = renderCliTextTranscript({
      structuredOutput: {
        schema: 'mobilebuildmcp.output.capture-result',
        schemaVersion: '2',
        result: {
          kind: 'capture-result',
          didError: false,
          error: null,
          summary: { status: 'SUCCEEDED' },
          artifacts: { simulatorId: 'SIMULATOR-1' },
          capture: {
            type: 'runtime-snapshot',
            protocol: 'rs/1',
            simulatorId: 'SIMULATOR-1',
            screenHash: 'screen-hash',
            seq: 1,
            capturedAtMs: 1000,
            expiresAtMs: 61000,
            elements: [
              {
                ref: 'e1',
                role: 'button',
                label: 'Settings',
                frame: { x: 10, y: 20, width: 30, height: 40 },
                actions: ['tap', 'longPress', 'touch'],
              },
              {
                ref: 'e2',
                role: 'text',
                label: 'Updated just now',
                frame: { x: 0, y: 0, width: 100, height: 20 },
                actions: ['longPress', 'touch'],
              },
            ],
            actions: [
              { action: 'tap', elementRef: 'e1', label: 'Settings' },
              { action: 'longPress', elementRef: 'e2', label: 'Updated just now' },
              { action: 'touch', elementRef: 'e2', label: 'Updated just now' },
            ],
          },
        },
      },
    });

    expect(output).toContain('Targets (1) — ref|action|role|label|value|id');
    expect(output).toContain('e1|tap|button|Settings||');
    expect(output).not.toContain('e2|');
    expect(output).toContain(
      'Runtime UI snapshot captured with 2 elements, 1 likely target, and 0 scroll areas.',
    );
  });

  it('renders runtime UI snapshot scroll areas separately from likely targets', () => {
    const output = renderCliTextTranscript({
      structuredOutput: {
        schema: 'mobilebuildmcp.output.capture-result',
        schemaVersion: '2',
        result: {
          kind: 'capture-result',
          didError: false,
          error: null,
          summary: { status: 'SUCCEEDED' },
          artifacts: { simulatorId: 'SIMULATOR-1' },
          capture: {
            type: 'runtime-snapshot',
            protocol: 'rs/1',
            simulatorId: 'SIMULATOR-1',
            screenHash: 'screen-hash',
            seq: 1,
            capturedAtMs: 1000,
            expiresAtMs: 61000,
            elements: [
              {
                ref: 'e1',
                role: 'application',
                label: 'Weather',
                frame: { x: 0, y: 0, width: 390, height: 844 },
                actions: ['swipeWithin'],
              },
              {
                ref: 'e2',
                role: 'button',
                label: 'Settings',
                frame: { x: 10, y: 20, width: 30, height: 40 },
                actions: ['tap', 'longPress', 'touch'],
              },
            ],
            actions: [
              { action: 'swipeWithin', elementRef: 'e1', label: 'Weather' },
              { action: 'tap', elementRef: 'e2', label: 'Settings' },
            ],
          },
        },
      },
    });

    expect(output).toContain('Targets (1) — ref|action|role|label|value|id');
    expect(output).toContain('e2|tap|button|Settings||');
    expect(output).toContain('Scroll (1) — ref|action|role|label|value|id');
    expect(output).toContain('e1|swipe|application|Weather||');
    expect(output).toContain('- Use scroll refs with swipe.');
    expect(output).toContain(
      'Runtime UI snapshot captured with 2 elements, 1 likely target, and 1 scroll area.',
    );
  });

  it('renders wait_for_ui output with wait-specific text', () => {
    const output = renderCliTextTranscript({
      structuredOutput: {
        schema: 'mobilebuildmcp.output.capture-result',
        schemaVersion: '2',
        renderHints: { headerTitle: 'Wait for UI' },
        result: {
          kind: 'capture-result',
          didError: false,
          error: null,
          summary: { status: 'SUCCEEDED' },
          artifacts: { simulatorId: 'SIMULATOR-1' },
          waitMatch: {
            predicate: 'exists',
            matches: [
              {
                ref: 'e1',
                role: 'button',
                label: 'Continue',
                frame: { x: 10, y: 20, width: 30, height: 40 },
                actions: ['tap'],
              },
            ],
          },
          capture: {
            type: 'runtime-snapshot',
            protocol: 'rs/1',
            simulatorId: 'SIMULATOR-1',
            screenHash: 'screen-hash',
            seq: 1,
            capturedAtMs: 1000,
            expiresAtMs: 61000,
            elements: [
              {
                ref: 'e1',
                role: 'button',
                label: 'Continue',
                frame: { x: 10, y: 20, width: 30, height: 40 },
                actions: ['tap'],
              },
            ],
            actions: [{ action: 'tap', elementRef: 'e1', label: 'Continue' }],
          },
        },
      },
    });

    expect(output).toContain('⚙️ Wait for UI');
    expect(output).toContain('Matched exists (1) — ref|action|role|label|value|id');
    expect(output).toContain('e1|tap|button|Continue||');
    expect(output).toContain(
      'Wait completed; runtime UI snapshot refreshed with 1 element, 1 likely target, and 0 scroll areas.',
    );
  });

  it('renders static wait matches with no primary action', () => {
    const output = renderCliTextTranscript({
      structuredOutput: {
        schema: 'mobilebuildmcp.output.capture-result',
        schemaVersion: '2',
        renderHints: { headerTitle: 'Wait for UI' },
        result: {
          kind: 'capture-result',
          didError: false,
          error: null,
          summary: { status: 'SUCCEEDED' },
          artifacts: { simulatorId: 'SIMULATOR-1' },
          waitMatch: {
            predicate: 'textContains',
            matches: [
              {
                ref: 'e11',
                role: 'text',
                label: 'No matches',
                frame: { x: 20, y: 240, width: 120, height: 24 },
                actions: ['longPress', 'touch'],
              },
            ],
          },
          capture: {
            type: 'runtime-snapshot',
            protocol: 'rs/1',
            simulatorId: 'SIMULATOR-1',
            screenHash: 'screen-hash',
            seq: 1,
            capturedAtMs: 1000,
            expiresAtMs: 61000,
            elements: [
              {
                ref: 'e11',
                role: 'text',
                label: 'No matches',
                frame: { x: 20, y: 240, width: 120, height: 24 },
                actions: ['longPress', 'touch'],
              },
            ],
            actions: [
              { action: 'longPress', elementRef: 'e11', label: 'No matches' },
              { action: 'touch', elementRef: 'e11', label: 'No matches' },
            ],
          },
        },
      },
    });

    expect(output).toContain('Matched textContains (1) — ref|action|role|label|value|id');
    expect(output).toContain('e11|none|text|No matches||');
    expect(output).not.toContain('e11|longPress|text|No matches||');
  });

  it('renders typed UI action recovery hints', () => {
    const output = renderCliTextTranscript({
      structuredOutput: {
        schema: 'mobilebuildmcp.output.ui-action-result',
        schemaVersion: '2',
        result: {
          kind: 'ui-action-result',
          didError: true,
          error: 'Element reference e9 was not found in the current runtime snapshot.',
          summary: { status: 'FAILED' },
          artifacts: { simulatorId: 'SIMULATOR-1' },
          action: { type: 'tap', elementRef: 'e9' },
          uiError: {
            code: 'ELEMENT_REF_NOT_FOUND',
            message: 'Element reference e9 was not found in the current runtime snapshot.',
            recoveryHint: 'Run snapshot_ui again and retry with a current element reference.',
            elementRef: 'e9',
            candidates: [
              {
                ref: 'e1',
                role: 'button',
                label: 'Add',
                frame: { x: 10, y: 20, width: 30, height: 40 },
                actions: ['tap'],
              },
            ],
          },
        },
      },
    });

    expect(output).toContain('Recovery');
    expect(output).toContain('Code: ELEMENT_REF_NOT_FOUND');
    expect(output).toContain('Element: e9');
    expect(output).toContain(
      'Hint: Run snapshot_ui again and retry with a current element reference.',
    );
    expect(output).toContain('Candidates (1):');
    expect(output).toContain('e1|tap|button|Add||');
    expect(output).toContain(
      '❌ Element reference e9 was not found in the current runtime snapshot.',
    );
  });

  it('renders structured output path artifacts as a tree when requested', () => {
    const output = renderCliTextTranscript({
      filePathRenderStyle: 'tree',
      structuredOutput: {
        schema: 'mobilebuildmcp.output.app-path',
        schemaVersion: '1.0.0',
        result: {
          kind: 'app-path',
          didError: false,
          error: null,
          artifacts: { appPath: '/tmp/MyApp.app' },
        },
      },
    });

    expect(output).toContain('└── /tmp/MyApp.app — App Path');
    expect(output).not.toContain('└ App Path: /tmp/MyApp.app');
  });

  it('renders structured-only non-build diagnostics with a short top-level error summary', () => {
    const output = renderCliTextTranscript({
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
    });

    const errorsIndex = output.indexOf('Errors (1):');
    const warningsIndex = output.indexOf('Warnings (1):');
    const rawOutputIndex = output.indexOf('Raw Output:');
    const statusIndex = output.indexOf('❌ Failed to list schemes.');

    expect(output).toContain('🔍 List Schemes');
    expect(errorsIndex).toBeGreaterThanOrEqual(0);
    expect(warningsIndex).toBeGreaterThan(errorsIndex);
    expect(rawOutputIndex).toBeGreaterThan(warningsIndex);
    expect(statusIndex).toBeGreaterThan(rawOutputIndex);
    expect(output).toContain(
      '  ✗ xcodebuild: error: The workspace named "Missing" does not exist.',
    );
    expect(output).toContain('  ⚠ Using default destination because none was provided.');
    expect(output).toContain('Result bundle written to /tmp/result.xcresult');
    expect(output).not.toContain('🔴 Errors');
    expect(output).not.toContain('🔴 Raw Output');
    expect(output).not.toContain('❌ xcodebuild: error');
    expect(output.match(/Failed to list schemes\./g)).toHaveLength(1);
  });

  it('renders clean-style build results when no live xcodebuild output was seen', () => {
    const output = renderCliTextTranscript({
      structuredOutput: {
        schema: 'mobilebuildmcp.output.build-result',
        schemaVersion: '1.0.0',
        result: {
          kind: 'build-result',
          didError: false,
          error: null,
          summary: { status: 'SUCCEEDED' },
          artifacts: {
            workspacePath: '/tmp/MyApp.xcworkspace',
            scheme: 'MyApp',
            configuration: 'Debug',
            platform: 'iOS',
          },
          diagnostics: { warnings: [], errors: [] },
        },
      },
    });

    expect(output).toContain('🧹 Clean');
    expect(output).toContain('Scheme: MyApp');
    expect(output).toContain('Workspace: /tmp/MyApp.xcworkspace');
    expect(output).toContain('✅ Clean successful');
  });

  it('renders structured-only build-result with request and no fragments', () => {
    const output = renderCliTextTranscript({
      structuredOutput: buildOutput({
        request: {
          scheme: 'MyApp',
          projectPath: '/tmp/MyApp.xcodeproj',
          configuration: 'Debug',
          platform: 'iOS Simulator',
        },
        summary: { status: 'SUCCEEDED', durationMs: 3200 },
        artifacts: { buildLogPath: '/tmp/build.log' },
      }),
    });

    expect(output).toContain('🔨 Build');
    expect(output).toContain('Scheme: MyApp');
    expect(output).toContain('Configuration: Debug');
    expect(output).toContain('✅ Build succeeded. (⏱️ 3.2s)');
    expect(output).toContain('Build Logs: /tmp/build.log');
  });

  it('renders structured-only build-run-result with request and no fragments', () => {
    const output = renderCliTextTranscript({
      structuredOutput: {
        schema: 'mobilebuildmcp.output.build-run-result',
        schemaVersion: '1.0.0',
        result: {
          kind: 'build-run-result',
          request: {
            scheme: 'MyApp',
            projectPath: '/tmp/MyApp.xcodeproj',
            configuration: 'Debug',
            platform: 'iOS Simulator',
          },
          didError: false,
          error: null,
          summary: { status: 'SUCCEEDED', durationMs: 5000 },
          artifacts: { appPath: '/tmp/build/MyApp.app', buildLogPath: '/tmp/build.log' },
          diagnostics: { warnings: [], errors: [] },
        },
      },
    });

    expect(output).toContain('🚀 Build & Run');
    expect(output).toContain('Scheme: MyApp');
    expect(output).toContain('✅ Build succeeded. (⏱️ 5.0s)');
    expect(output).toContain('✅ Build & Run complete');
    expect(output).toContain('App Path: /tmp/build/MyApp.app');
  });

  it('renders structured-only build-run headers without frontmatter when header details are disabled', () => {
    const output = renderCliTextTranscript({
      includeHeaderDetails: false,
      structuredOutput: {
        schema: 'mobilebuildmcp.output.build-run-result',
        schemaVersion: '1.0.0',
        result: {
          kind: 'build-run-result',
          request: {
            scheme: 'MyApp',
            projectPath: '/tmp/MyApp.xcodeproj',
            configuration: 'Debug',
            platform: 'iOS Simulator',
          },
          didError: false,
          error: null,
          summary: { status: 'SUCCEEDED', durationMs: 5000 },
          artifacts: { appPath: '/tmp/build/MyApp.app', buildLogPath: '/tmp/build.log' },
          diagnostics: { warnings: [], errors: [] },
        },
      },
    });

    expect(output).toContain('🚀 Build & Run');
    expect(output).not.toContain('Scheme: MyApp');
    expect(output).not.toContain('Project: /tmp/MyApp.xcodeproj');
    expect(output).not.toContain('Configuration: Debug');
    expect(output).toContain('✅ Build succeeded. (⏱️ 5.0s)');
  });

  it('renders structured-only test-result with request and no fragments', () => {
    const output = renderCliTextTranscript({
      structuredOutput: {
        schema: 'mobilebuildmcp.output.test-result',
        schemaVersion: '1.0.0',
        result: {
          kind: 'test-result',
          request: {
            scheme: 'MyApp',
            configuration: 'Debug',
            platform: 'iOS Simulator',
          },
          didError: false,
          error: null,
          summary: {
            status: 'SUCCEEDED',
            durationMs: 2100,
            counts: { passed: 5, failed: 0, skipped: 1 },
          },
          artifacts: { buildLogPath: '/tmp/test.log' },
          diagnostics: { warnings: [], errors: [], testFailures: [] },
        },
      },
    });

    expect(output).toContain('🧪 Test');
    expect(output).toContain('Scheme: MyApp');
    expect(output).toContain('5 tests passed, 0 failed, 1 skipped');
    expect(output).toContain('Build Logs: /tmp/test.log');
  });

  it('uses finalized test-result counts instead of the streamed build-summary counts', () => {
    const output = renderCliTextTranscript({
      items: [
        {
          kind: 'test-result',
          fragment: 'test-progress',
          operation: 'TEST',
          completed: 19,
          failed: 0,
          skipped: 0,
        },
        {
          kind: 'test-result',
          fragment: 'build-summary',
          operation: 'TEST',
          status: 'SUCCEEDED',
          totalTests: 19,
          passedTests: 19,
          failedTests: 0,
          skippedTests: 0,
          durationMs: 2100,
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
            durationMs: 2100,
            counts: { passed: 16, failed: 0, skipped: 0 },
          },
          artifacts: {
            xcresultPath: '/tmp/Weather.xcresult',
            buildLogPath: '/tmp/weather-test.log',
          },
          diagnostics: { warnings: [], errors: [], testFailures: [] },
        },
      },
    });

    expect(output).toContain('Running tests (19 completed, 0 failures, 0 skipped)');
    expect(output.match(/✅ 16 tests passed, 0 failed, 0 skipped/g)).toHaveLength(1);
    expect(output).not.toContain('✅ 19 tests passed, 0 failed, 0 skipped');
    expect(output).toContain('Result Bundle: /tmp/Weather.xcresult');
    expect(output).toContain('Build Logs: /tmp/weather-test.log');
  });

  it('uses finalized build summary from structured output when streamed build-summary disagrees', () => {
    const output = renderCliTextTranscript({
      items: [
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
      structuredOutput: buildOutput({
        didError: false,
        error: null,
        summary: { status: 'SUCCEEDED', durationMs: 3200 },
        artifacts: { scheme: 'MyApp', buildLogPath: '/tmp/build.log' },
      }),
    });

    expect(output).toContain('✅ Build succeeded. (⏱️ 3.2s)');
    expect(output).not.toContain('❌ Build failed. (⏱️ 9.9s)');
    expect(output).toContain('Build Logs: /tmp/build.log');
  });

  it('omits per-test results by default and renders them when showTestTiming is true', () => {
    const fragments = [
      {
        kind: 'test-result' as const,
        fragment: 'test-case-result' as const,
        operation: 'TEST' as const,
        suite: 'Suite',
        test: 'testA',
        status: 'passed' as const,
        durationMs: 5,
      },
      {
        kind: 'test-result' as const,
        fragment: 'test-case-result' as const,
        operation: 'TEST' as const,
        suite: 'Suite',
        test: 'testB',
        status: 'failed' as const,
        durationMs: 12,
      },
      {
        kind: 'test-result' as const,
        fragment: 'build-summary' as const,
        operation: 'TEST' as const,
        status: 'FAILED' as const,
        totalTests: 2,
        passedTests: 1,
        failedTests: 1,
        skippedTests: 0,
        durationMs: 17,
      },
    ];

    const withoutFlag = renderCliTextTranscript({ items: fragments });
    expect(withoutFlag).not.toContain('Test Results:');
    expect(withoutFlag).not.toContain('Suite/testA');

    const withFlag = renderCliTextTranscript({ items: fragments, showTestTiming: true });
    expect(withFlag).toContain('Test Results:');
    expect(withFlag).toContain('Suite/testA');
    expect(withFlag).toContain('Suite/testB');
    expect(withFlag).toContain('(0.005s)');
  });
});
