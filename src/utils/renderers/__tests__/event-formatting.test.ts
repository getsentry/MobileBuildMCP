import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  extractGroupedCompilerError,
  formatGroupedCompilerErrors,
  formatGroupedTestFailures,
  formatHumanCompilerErrorEvent,
  formatHumanCompilerWarningEvent,
  formatHeaderEvent,
  formatBuildStageEvent,
  formatTransientBuildStageEvent,
  formatStatusLineEvent,
  formatDetailTreeEvent,
  formatTestCaseResults,
  formatTransientStatusLineEvent,
} from '../event-formatting.ts';

describe('event formatting', () => {
  it('formats header events with emoji, operation, and params', () => {
    expect(
      formatHeaderEvent({
        type: 'header',
        operation: 'Build & Run',
        params: [{ label: 'Scheme', value: 'MyApp' }],
      }),
    ).toBe('\u{1F680} Build & Run\n\n   Scheme: MyApp');
  });

  it('formats compact header events without params when details are disabled', () => {
    expect(
      formatHeaderEvent(
        {
          type: 'header',
          operation: 'Build & Run',
          params: [
            { label: 'Scheme', value: 'MyApp' },
            { label: 'Derived Data', value: '/tmp/DerivedData' },
          ],
        },
        { includeDetails: false },
      ),
    ).toBe('\u{1F680} Build & Run');
  });

  it('groups test selection params with human-readable labels in header output', () => {
    expect(
      formatHeaderEvent({
        type: 'header',
        operation: 'Test',
        params: [
          { label: 'Scheme', value: 'MyApp' },
          { label: '-only-testing', value: 'MyAppTests/MyAppTests/testLaunch' },
          { label: '-skip-testing', value: 'MyAppTests/MyAppTests/testFlaky' },
          {
            label: 'Derived Data',
            value: '~/Library/Developer/MobileBuildMCP/workspaces/abc123/DerivedData',
          },
        ],
      }),
    ).toBe(
      [
        '\u{1F9EA} Test',
        '',
        '   Scheme: MyApp',
        '   Derived Data: ~/Library/Developer/MobileBuildMCP/workspaces/abc123/DerivedData',
        '   Selective Testing:',
        '     MyAppTests/MyAppTests/testLaunch',
        '     Skip Testing: MyAppTests/MyAppTests/testFlaky',
      ].join('\n'),
    );
  });

  it('formats build-stage events as durable phase lines', () => {
    expect(
      formatBuildStageEvent({
        type: 'build-stage',
        operation: 'BUILD',
        stage: 'COMPILING',
        message: 'Compiling',
      }),
    ).toBe('\u203A Compiling');
  });

  it('formats transient build-stage events for interactive runtime updates', () => {
    expect(
      formatTransientBuildStageEvent({
        type: 'build-stage',
        operation: 'BUILD',
        stage: 'COMPILING',
        message: 'Compiling',
      }),
    ).toBe('Compiling...');
  });

  it('formats compiler-style errors with a cwd-relative source location when possible', () => {
    const projectBaseDir = join(process.cwd(), 'example_projects/macOS');

    expect(
      formatHumanCompilerErrorEvent(
        {
          type: 'compiler-error',
          operation: 'BUILD',
          message: 'unterminated string literal',
          rawLine: 'ContentView.swift:16:18: error: unterminated string literal',
        },
        { baseDir: projectBaseDir },
      ),
    ).toBe(
      [
        'error: unterminated string literal',
        '  example_projects/macOS/MCPTest/ContentView.swift:16:18',
      ].join('\n'),
    );
  });

  it('keeps compiler-style error paths absolute when they are outside cwd', () => {
    expect(
      formatHumanCompilerErrorEvent({
        type: 'compiler-error',
        operation: 'BUILD',
        message: 'unterminated string literal',
        rawLine: '/tmp/MCPTest/ContentView.swift:16:18: error: unterminated string literal',
      }),
    ).toBe(
      ['error: unterminated string literal', '  /tmp/MCPTest/ContentView.swift:16:18'].join('\n'),
    );
  });

  it('treats glob metacharacters in compiler diagnostic filenames literally', () => {
    const projectBaseDir = mkdtempSync(join(tmpdir(), 'mobilebuildmcp-diagnostic-'));
    const sourceDir = join(projectBaseDir, 'Sources');
    const decoyDir = join(projectBaseDir, 'Decoy');
    const literalFile = join(sourceDir, 'ContentView[1].swift');

    try {
      mkdirSync(sourceDir, { recursive: true });
      mkdirSync(decoyDir, { recursive: true });
      writeFileSync(literalFile, '');
      writeFileSync(join(decoyDir, 'ContentView1.swift'), '');

      const rendered = formatHumanCompilerErrorEvent(
        {
          type: 'compiler-error',
          operation: 'BUILD',
          message: 'unterminated string literal',
          rawLine: 'ContentView[1].swift:16:18: error: unterminated string literal',
        },
        { baseDir: projectBaseDir },
      );

      expect(rendered).toContain(`${literalFile}:16:18`);
      expect(rendered).not.toContain('Decoy/ContentView1.swift');
    } finally {
      rmSync(projectBaseDir, { recursive: true, force: true });
    }
  });

  it('formats tool-originated errors in xcodebuild-style form', () => {
    expect(
      formatHumanCompilerErrorEvent({
        type: 'compiler-error',
        operation: 'BUILD',
        message: 'No available simulator matched: INVALID-SIM-ID-123',
        rawLine: 'No available simulator matched: INVALID-SIM-ID-123',
      }),
    ).toBe('error: No available simulator matched: INVALID-SIM-ID-123');
  });

  it('extracts compiler diagnostics for grouped sad-path rendering', () => {
    expect(
      extractGroupedCompilerError(
        {
          type: 'compiler-error',
          operation: 'BUILD',
          message: 'unterminated string literal',
          rawLine: 'ContentView.swift:16:18: error: unterminated string literal',
        },
        { baseDir: join(process.cwd(), 'example_projects/macOS') },
      ),
    ).toEqual({
      message: 'unterminated string literal',
      location: 'example_projects/macOS/MCPTest/ContentView.swift:16:18',
    });
  });

  it('formats grouped compiler errors without repeating the error prefix per line', () => {
    expect(
      formatGroupedCompilerErrors(
        [
          {
            type: 'compiler-error',
            operation: 'BUILD',
            message: 'unterminated string literal',
            rawLine: 'ContentView.swift:16:18: error: unterminated string literal',
          },
        ],
        { baseDir: join(process.cwd(), 'example_projects/macOS') },
      ),
    ).toBe(
      [
        'Compiler Errors (1):',
        '',
        '  \u2717 unterminated string literal',
        '    example_projects/macOS/MCPTest/ContentView.swift:16:18',
      ].join('\n'),
    );
  });

  it('formats tool-originated warnings with warning emoji', () => {
    expect(
      formatHumanCompilerWarningEvent({
        type: 'compiler-warning',
        operation: 'BUILD',
        message: 'Using cached build products',
        rawLine: 'Using cached build products',
      }),
    ).toBe('  \u{26A0} Using cached build products');
  });

  it('formats status events with level emojis', () => {
    expect(
      formatStatusLineEvent({
        type: 'status',
        level: 'info',
        message: 'Resolving app path',
      }),
    ).toBe('\u{2139}\u{FE0F} Resolving app path');

    expect(
      formatStatusLineEvent({
        type: 'status',
        level: 'success',
        message: 'Build & Run complete',
      }),
    ).toBe('\u{2705} Build & Run complete');
  });

  it('formats transient status events for info level', () => {
    expect(
      formatTransientStatusLineEvent({
        type: 'status',
        level: 'info',
        message: 'Resolving app path',
      }),
    ).toBe('Resolving app path...');

    expect(
      formatTransientStatusLineEvent({
        type: 'status',
        level: 'success',
        message: 'App path resolved',
      }),
    ).toBeNull();
  });

  it('formats detail-tree events as a tree section', () => {
    const rendered = formatDetailTreeEvent({
      type: 'detail-tree',
      items: [
        { label: 'App Path', path: '/tmp/build/MyApp.app' },
        { label: 'Bundle ID', value: 'com.example.myapp' },
        { label: 'App ID', value: 'A1B2C3D4' },
        { label: 'Process ID', value: '12345' },
        { label: 'Launch', value: 'Running' },
      ],
    });

    expect(rendered).toContain('  ├ Bundle ID: com.example.myapp');
    expect(rendered).toContain('  ├ App ID: A1B2C3D4');
    expect(rendered).toContain('  ├ Process ID: 12345');
    expect(rendered).toContain('  ├ Launch: Running');
    expect(rendered).toContain('  └ Files:');
    expect(rendered).toContain('     └── /tmp/build/MyApp.app — App Path');
  });

  it('formats detail-tree with single item using end branch', () => {
    expect(
      formatDetailTreeEvent({
        type: 'detail-tree',
        items: [{ label: 'App Path', path: '/tmp/build/MyApp.app' }],
      }),
    ).toBe(['  └ Files:', '     └── /tmp/build/MyApp.app — App Path'].join('\n'));
  });

  it('formats detail-tree path items as a labeled list when requested', () => {
    expect(
      formatDetailTreeEvent(
        {
          type: 'detail-tree',
          items: [
            { label: 'Bundle ID', value: 'com.example.myapp' },
            { label: 'App Path', path: '/tmp/build/MyApp.app' },
            { label: 'Build Logs', path: '/tmp/logs/build.log' },
          ],
        },
        { filePathRenderStyle: 'list' },
      ),
    ).toBe(
      [
        '  ├ Bundle ID: com.example.myapp',
        '  └ Files:',
        '     ├ App Path: /tmp/build/MyApp.app',
        '     └ Build Logs: /tmp/logs/build.log',
      ].join('\n'),
    );
  });

  it('groups test failures by test case within a suite', () => {
    const rendered = formatGroupedTestFailures([
      {
        type: 'test-failure',
        operation: 'TEST',
        suite: 'MathTests',
        test: 'testAdd',
        message: 'XCTAssertEqual failed',
        location: '/tmp/MathTests.swift:12',
      },
      {
        type: 'test-failure',
        operation: 'TEST',
        suite: 'MathTests',
        test: 'testAdd',
        message: 'Expected 4, got 5',
        location: '/tmp/MathTests.swift:13',
      },
    ]);

    expect(rendered).toContain('MathTests');
    expect(rendered).toContain('  ✗ testAdd:');
    expect(rendered).toContain('      - XCTAssertEqual failed');
    expect(rendered).toContain('      - Expected 4, got 5');
  });

  it('formats per-test-case results with status icons and durations', () => {
    const rendered = formatTestCaseResults([
      {
        type: 'test-case-result',
        operation: 'TEST',
        suite: 'Suite',
        test: 'testA',
        status: 'passed',
        durationMs: 5,
      },
      {
        type: 'test-case-result',
        operation: 'TEST',
        suite: 'Suite',
        test: 'testB',
        status: 'failed',
        durationMs: 250,
      },
      {
        type: 'test-case-result',
        operation: 'TEST',
        test: 'testC',
        status: 'skipped',
      },
    ]);

    expect(rendered).toContain('Test Results:');
    expect(rendered).toContain('Suite/testA');
    expect(rendered).toContain('(0.005s)');
    expect(rendered).toContain('Suite/testB');
    expect(rendered).toContain('(0.250s)');
    expect(rendered).toContain('testC');
    expect(rendered).not.toContain('Suite/testC');
  });

  it('returns empty string when no test results provided', () => {
    expect(formatTestCaseResults([])).toBe('');
  });
});
