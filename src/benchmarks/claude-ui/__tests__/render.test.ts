import { renderAggregate, renderSuiteReport } from '../render.ts';
import type { BenchmarkResult } from '../types.ts';

function baseResult(overrides: Partial<BenchmarkResult> = {}): BenchmarkResult {
  const runDirectory = '/repo/out.nosync/claude-benchmarks/weather/20260101T000000Z';
  return {
    name: 'weather',
    completed: true,
    metrics: [
      {
        name: 'totalToolCalls',
        actual: 13,
        baseline: 19,
      },
      {
        name: 'mcpToolCalls',
        actual: 12,
        baseline: 18,
      },
      {
        name: 'wallClockSeconds',
        actual: 98.62,
        baseline: 125,
      },
      { name: 'tool:tap', actual: 6, baseline: 9 },
      { name: 'tool:snapshot_ui', actual: 1, baseline: 1 },
    ],
    completion: { completed: true, issueCount: 0 },
    sequence: {
      matched: true,
      baseline: ['snapshot_ui', 'tap'],
      actual: ['snapshot_ui', 'tap'],
      diff: [],
      missing: [],
      additional: [],
    },
    audit: {
      records: 10,
      parseErrors: [],
      claudeDurationSeconds: 98,
      claudeApiDurationSeconds: 61.25,
      totalToolCalls: 13,
      totalToolCallsByName: {},
      trackedToolCalls: 12,
      trackedToolCallsByName: {},
      mcpToolCalls: 12,
      mcpToolCallsByName: {},
      uiAutomationCalls: 10,
      uiAutomationCallsByName: {},
      trackedSequence: [],
      mcpSequence: [],
      failures: [],
      patternFailures: [],
    },
    run: {
      suitePath: '/repo/benchmarks/claude-ui/suites/weather.yml',
      wallClockSeconds: 98.62,
      claudeExitCode: 0,
      parserExitCode: 0,
      artifacts: {
        runDirectory,
        promptPath: `${runDirectory}/prompt.md`,
        mcpConfigPath: `${runDirectory}/mcp-config.json`,
        mcpWorkspaceDirectory: `${runDirectory}/mcp-workspace`,
        mcpWorkspaceConfigPath: `${runDirectory}/mcp-workspace/.mobilebuildmcp/config.yaml`,
        claudeJsonlPath: `${runDirectory}/claude.jsonl`,
        claudeStderrPath: `${runDirectory}/claude.stderr`,
        claudeCommandLogPath: `${runDirectory}/claude-command.log`,
        simulatorLifecycleLogPath: `${runDirectory}/simulator-lifecycle.log`,
        parsedDirectory: `${runDirectory}/parsed`,
        parseLogPath: `${runDirectory}/parse.log`,
        resultJsonPath: `${runDirectory}/result.json`,
      },
    },
    ...overrides,
  };
}

describe('renderSuiteReport', () => {
  it('renders a completed suite with no sequence delta', () => {
    const output = renderSuiteReport(baseResult(), { color: false, width: 80, cwd: '/repo' });

    expect(output).toContain('COMPLETED  weather');
    expect(output).toContain('Metrics');
    expect(output).toContain('totalToolCalls');
    expect(output).toContain('METRIC            ACTUAL  BASELINE   DELTA');
    expect(output).toContain('Tool calls (baseline-observed)');
    expect(output).toContain('claude   timing api=1m 1.3s non-api=36.75s');
    expect(output).toContain('OBSERVED  stumbles: 0');
    expect(output).not.toContain('Inspect');
    expect(output).not.toContain('@@ baseline');
  });

  it('renders failure detail and inspect hints when failures present', () => {
    const result = baseResult({
      completed: false,
      completion: { completed: false, issueCount: 2 },
      audit: {
        ...baseResult().audit,
        failures: [
          {
            shortName: 'boot_sim',
            fullName: 'mcp__mobilebuildmcp-dev__boot_sim',
            line: 9,
            message: 'Boot failed: device not found',
          },
        ],
        patternFailures: [
          {
            pattern: 'STALE_ELEMENT_REF',
            line: 22,
            excerpt: 'STALE_ELEMENT_REF detected on element e8',
          },
        ],
      },
    });

    const output = renderSuiteReport(result, { color: false, width: 80, cwd: '/repo' });

    expect(output).toContain('INCOMPLETE  weather');
    expect(output).toContain('INCOMPLETE  stumbles: 2');
    expect(output).toContain('tool errors: 1');
    expect(output).toContain('boot_sim @ line 9: Boot failed');
    expect(output).toContain('pattern matches: 1');
    expect(output).toContain('STALE_ELEMENT_REF @ line 22');
    expect(output).toContain('Inspect');
    expect(output).toContain('transcript    out.nosync/claude-benchmarks/weather');
  });

  it('renders inspect hints for completed suites with stumbles', () => {
    const result = baseResult({
      completion: { completed: true, issueCount: 1 },
      audit: {
        ...baseResult().audit,
        failures: [
          {
            shortName: 'screen',
            fullName: 'Bash',
            line: 7,
            message: 'temporary probe error',
          },
        ],
      },
    });

    const output = renderSuiteReport(result, { color: false, width: 80, cwd: '/repo' });

    expect(output).toContain('COMPLETED  weather');
    expect(output).toContain('OBSERVED  stumbles: 1');
    expect(output).toContain('Inspect');
    expect(output).toContain('transcript    out.nosync/claude-benchmarks/weather');
  });

  it('renders null process exit codes as incomplete', () => {
    const result = baseResult({
      completed: false,
      completion: { completed: false, issueCount: 2 },
      run: {
        ...baseResult().run,
        claudeExitCode: null,
        parserExitCode: null,
      },
    });

    const output = renderSuiteReport(result, { color: false, width: 80, cwd: '/repo' });

    expect(output).toContain('claude exit code: null');
    expect(output).toContain('parser exit code: null');
  });

  it('renders observed sequence delta hunks with marker columns', () => {
    const result = baseResult({
      sequence: {
        matched: false,
        baseline: ['session_show_defaults', 'snapshot_ui', 'tap'],
        actual: ['session_show_defaults', 'snapshot_ui', 'screenshot', 'tap'],
        diff: [
          {
            lines: [
              {
                kind: 'context',
                tool: 'snapshot_ui',
                baselineIndex: 1,
                actualIndex: 1,
              },
              { kind: 'additional', tool: 'screenshot', actualIndex: 2 },
              {
                kind: 'context',
                tool: 'tap',
                baselineIndex: 2,
                actualIndex: 3,
              },
            ],
          },
        ],
        missing: [],
        additional: ['screenshot'],
      },
    });

    const output = renderSuiteReport(result, { color: false, width: 80, cwd: '/repo' });

    expect(output).toContain('OBSERVED  tool sequence: 0 missing from baseline, 1 additional');
    expect(output).toContain('@@ baseline[1..2] actual[1..3] @@');
    expect(output).toContain('+ screenshot');
  });

  it('uses relative paths for artifacts and suite metadata', () => {
    const output = renderSuiteReport(baseResult(), { color: false, width: 80, cwd: '/repo' });

    expect(output).toContain('suite     benchmarks/claude-ui/suites/weather.yml');
    expect(output).toContain('artifacts out.nosync/claude-benchmarks/weather/20260101T000000Z');
  });

  it('renders Claude model and version metadata when present', () => {
    const output = renderSuiteReport(
      baseResult({
        run: {
          ...baseResult().run,
          claude: {
            requestedModel: 'claude-sonnet-4-7',
            observedModel: 'claude-sonnet-4-7-20260501',
            version: {
              command: ['claude', '--version'],
              exitCode: 0,
              stdout: '1.2.3\n',
              stderr: '',
            },
          },
        },
      }),
      { color: false, width: 80, cwd: '/repo' },
    );

    expect(output).toContain(
      'claude   model requested=claude-sonnet-4-7 observed=claude-sonnet-4-7-20260501 version=1.2.3',
    );
  });

  it('renders the temporary simulator id when present', () => {
    const output = renderSuiteReport(
      baseResult({
        run: {
          ...baseResult().run,
          temporarySimulator: {
            simulatorId: 'TEMP-SIM-123',
            name: 'Claude UI weather 20260101T000000Z',
            lifecycleLogPath:
              '/repo/out.nosync/claude-benchmarks/weather/20260101T000000Z/simulator-lifecycle.log',
            setupDurationSeconds: 23.4,
            deletionAttempted: true,
            deletionSucceeded: true,
            deleteExitCode: 0,
          },
        },
      }),
      { color: false, width: 80, cwd: '/repo' },
    );

    expect(output).toContain('simulator TEMP-SIM-123');
    expect(output).toContain('setup     23.40s before Claude');
  });
});

describe('renderAggregate', () => {
  it('summarizes completion counts and lists each suite', () => {
    const completed = baseResult();
    const sequenceDelta = baseResult({
      name: 'contacts',
      sequence: {
        ...baseResult().sequence,
        matched: false,
        missing: ['tap'],
        additional: [],
      },
      run: {
        ...baseResult().run,
        wallClockSeconds: 72.1,
        artifacts: {
          ...baseResult().run.artifacts,
          runDirectory: '/repo/out.nosync/claude-benchmarks/contacts/20260101T000000Z',
        },
      },
    });
    const incomplete = baseResult({
      name: 'reminders',
      completed: false,
      completion: { completed: false, issueCount: 1 },
      metrics: [
        {
          name: 'mcpToolCalls',
          actual: 30,
          baseline: 18,
        },
      ],
      sequence: {
        ...baseResult().sequence,
        matched: false,
        missing: ['open_sim', 'tap'],
        additional: ['batch'],
      },
      run: {
        ...baseResult().run,
        wallClockSeconds: 145,
        artifacts: {
          ...baseResult().run.artifacts,
          runDirectory: '/repo/out.nosync/claude-benchmarks/reminders/20260101T000000Z',
        },
      },
    });

    const output = renderAggregate([completed, sequenceDelta, incomplete], {
      color: false,
      width: 80,
      cwd: '/repo',
    });

    expect(output).toContain('Claude UI Benchmarks · Summary');
    expect(output).toContain('Suites:    3 total · 2 completed · 1 incomplete');
    expect(output).toContain('total ');
    expect(output).toContain('slowest reminders (2m 25.0s)');
    expect(output).toContain('Artifacts: out.nosync/claude-benchmarks/');
    expect(output).toContain('COMPLETED   weather');
    expect(output).toContain('COMPLETED   contacts');
    expect(output).toContain('INCOMPLETE  reminders');
    expect(output).toContain('sequence delta: 2m/1a');
    expect(output).not.toContain('metric warning');
  });
});
