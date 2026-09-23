import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildClaudeArgs } from '../claude-invocation.ts';
import { compareBenchmark, diffToolSequence } from '../compare.ts';
import { renderAggregate } from '../render.ts';
import { readConfig } from '../config.ts';
import {
  extractObservedClaudeModel,
  listSuitePaths,
  requireSuitePaths,
  resolveParserPath,
  resolveSuitePath,
} from '../harness.ts';
import { analyzeClaudeJsonl } from '../transcript.ts';
import type { BenchmarkConfig, BenchmarkRunMetadata } from '../types.ts';

const toolPrefix = 'mcp__mobilebuildmcp-dev__';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

function line(value: unknown): string {
  return JSON.stringify(value);
}

function runMetadata(
  wallClockSeconds: number,
  claudeExitCode = 0,
  parserExitCode = 0,
): BenchmarkRunMetadata {
  return {
    suitePath: '/tmp/weather.yml',
    wallClockSeconds,
    claudeExitCode,
    parserExitCode,
    artifacts: {
      runDirectory: '/tmp/run',
      promptPath: '/tmp/run/prompt.md',
      mcpConfigPath: '/tmp/run/mcp-config.json',
      mcpWorkspaceDirectory: '/tmp/run/mcp-workspace',
      mcpWorkspaceConfigPath: '/tmp/run/mcp-workspace/.mobilebuildmcp/config.yaml',
      claudeJsonlPath: '/tmp/run/claude.jsonl',
      claudeStderrPath: '/tmp/run/claude.stderr',
      claudeCommandLogPath: '/tmp/run/claude-command.log',
      simulatorLifecycleLogPath: '/tmp/run/simulator-lifecycle.log',
      parsedDirectory: '/tmp/run/parsed',
      parseLogPath: '/tmp/run/parse.log',
      resultJsonPath: '/tmp/run/result.json',
    },
  };
}

describe('Claude UI benchmark harness', () => {
  const parserEnvName = 'CLAUDE_UI_BENCHMARK_PARSER';
  const originalParserEnv = process.env[parserEnvName];

  afterEach(() => {
    if (originalParserEnv === undefined) {
      delete process.env[parserEnvName];
    } else {
      process.env[parserEnvName] = originalParserEnv;
    }
  });

  it('defaults to the bundled parser path', async () => {
    delete process.env[parserEnvName];

    await expect(resolveParserPath(undefined)).resolves.toBe(
      path.join(repoRoot, 'benchmarks/claude-ui/parse_claude_conversation.py'),
    );
  });

  it('prefers configured parser paths and rejects missing files', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'claude-ui-parser-'));
    try {
      const parserPath = path.join(dir, 'parse_claude_conversation.py');
      await writeFile(parserPath, '# parser\n', 'utf8');

      await expect(resolveParserPath(parserPath)).resolves.toBe(parserPath);
      await expect(resolveParserPath(path.join(dir, 'missing.py'))).rejects.toThrow(
        'Claude UI benchmark parser does not exist',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects empty --all suite discovery', () => {
    expect(() => requireSuitePaths([])).toThrow(
      'no suite files found in benchmarks/claude-ui/suites',
    );
  });

  it('discovers local private suites when present', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'claude-ui-suites-'));
    try {
      const suiteDirectories = {
        suitesDir: path.join(dir, 'suites'),
        localSuitesDir: path.join(dir, 'local-suites'),
      };
      const suiteName = `unit-private-suite-${process.pid}`;
      const suitePath = path.join(suiteDirectories.localSuitesDir, `${suiteName}.yml`);
      await mkdir(suiteDirectories.suitesDir, { recursive: true });
      await mkdir(suiteDirectories.localSuitesDir, { recursive: true });
      await writeFile(suitePath, `name: ${suiteName}\nprompt: ../prompts/weather.md\n`, 'utf8');

      await expect(resolveSuitePath(suiteName, suiteDirectories)).resolves.toBe(suitePath);
      await expect(listSuitePaths(suiteDirectories)).resolves.toContain(suitePath);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('Claude UI benchmark analysis', () => {
  it('keeps task prompts deterministic', async () => {
    const [contacts, reminders, weather] = await Promise.all([
      readFile(path.join(repoRoot, 'benchmarks/claude-ui/prompts/contacts.md'), 'utf8'),
      readFile(path.join(repoRoot, 'benchmarks/claude-ui/prompts/reminders.md'), 'utf8'),
      readFile(path.join(repoRoot, 'benchmarks/claude-ui/prompts/weather.md'), 'utf8'),
    ]);

    for (const prompt of [contacts, reminders, weather]) {
      expect(prompt).not.toContain('Use only the MobileBuildMCP MCP tools');
    }

    expect(contacts).toContain('First name: `MCP`');
    expect(contacts).toContain('Last name: `Contact Benchmark`');
    expect(contacts).toContain('Organization: `MobileBuildMCP Benchmark`');
    expect(contacts).toContain('Phone: `555-010-4242`');
    expect(contacts).toContain('Email: `mcp.contact.benchmark@example.com`');

    expect(reminders).toContain('Create a new list named `MCP Benchmark List`');
    expect(reminders).toContain(
      'two completed reminders (`Buy milk benchmark`, `Call team benchmark`)',
    );
    expect(reminders).toContain('one incomplete reminder (`File report benchmark`)');

    expect(weather).toContain('Search by typing exactly `London`, then select the London result.');
    expect(weather).toContain('`London`, `11°`, precipitation `78%`, and visibility `9.7 km`');
    expect(weather).toContain('`10.7 mm` total expected');
    expect(weather).toContain('lightning `None`');
  });

  it('counts Claude, MCP, and UI automation tool calls from stream JSONL', () => {
    const transcript = [
      line({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tool-1', name: 'ToolSearch', input: { query: 'x' } },
            { type: 'tool_use', id: 'tool-2', name: `${toolPrefix}snapshot_ui`, input: {} },
          ],
        },
      }),
      line({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-2',
              content: JSON.stringify({
                schema: 'x',
                didError: false,
                data: { summary: { status: 'SUCCEEDED' } },
              }),
            },
          ],
        },
      }),
      line({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-3',
              name: `${toolPrefix}tap`,
              input: { elementRef: 'e1' },
            },
          ],
        },
      }),
      line({
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 1000,
        duration_api_ms: 750,
        result: 'done',
        model: 'claude-sonnet-4-7',
      }),
    ].join('\n');

    const audit = analyzeClaudeJsonl(transcript, { mcpToolPrefix: toolPrefix });

    expect(audit.totalToolCalls).toBe(3);
    expect(audit.mcpToolCalls).toBe(2);
    expect(audit.uiAutomationCalls).toBe(2);
    expect(audit.mcpSequence.map((call) => call.shortName)).toEqual(['snapshot_ui', 'tap']);
    expect(audit.failures).toEqual([]);
    expect(audit.claudeDurationSeconds).toBe(1);
    expect(audit.claudeApiDurationSeconds).toBe(0.75);
    expect(audit.finalText).toBe('done');
    expect(extractObservedClaudeModel(audit.resultSummary)).toBe('claude-sonnet-4-7');
  });

  it('extracts observed Claude model from model usage metadata', () => {
    expect(
      extractObservedClaudeModel(
        {
          modelUsage: {
            'claude-haiku-4-5-20251001': {},
            'claude-opus-4-8': {},
          },
        },
        'claude-opus-4-8',
      ),
    ).toBe('claude-opus-4-8');
  });

  it('reports tool failures and configured failure patterns', () => {
    const transcript = [
      line({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tool-1', name: `${toolPrefix}wait_for_ui`, input: {} },
          ],
        },
      }),
      line({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tool-1', is_error: true, content: 'WAIT_TIMEOUT' },
          ],
        },
      }),
      line({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'stale element ref observed' }] },
      }),
    ].join('\n');

    const audit = analyzeClaudeJsonl(transcript, {
      mcpToolPrefix: toolPrefix,
      failurePatterns: ['WAIT_TIMEOUT'],
    });

    expect(audit.failures).toHaveLength(1);
    expect(audit.patternFailures).toHaveLength(1);

    const result = compareBenchmark(
      { name: 'weather', prompt: 'prompt.md' },
      audit,
      runMetadata(10),
    );

    expect(result.completion.issueCount).toBe(1);
    expect(result.completion.completed).toBe(false);
    expect(result.completed).toBe(false);
  });

  it('marks the benchmark incomplete when configured failure patterns match', () => {
    const transcript = [
      line({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tool-1', name: `${toolPrefix}wait_for_ui`, input: {} },
          ],
        },
      }),
      line({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-1',
              is_error: false,
              content: 'BUILD FAILED',
            },
          ],
        },
      }),
    ].join('\n');

    const audit = analyzeClaudeJsonl(transcript, {
      mcpToolPrefix: toolPrefix,
      failurePatterns: ['BUILD FAILED'],
    });

    expect(audit.failures).toEqual([]);
    expect(audit.patternFailures).toHaveLength(1);

    const result = compareBenchmark(
      { name: 'weather', prompt: 'prompt.md' },
      audit,
      runMetadata(10),
    );

    expect(result.completion.issueCount).toBe(1);
    expect(result.completion.completed).toBe(false);
    expect(result.completed).toBe(false);
  });

  it('counts parser failures once when malformed JSONL also records parse errors', () => {
    const audit = analyzeClaudeJsonl('{broken\n', { mcpToolPrefix: toolPrefix });

    const result = compareBenchmark(
      { name: 'weather', prompt: 'prompt.md' },
      audit,
      runMetadata(10, 0, 1),
    );

    expect(audit.parseErrors).toHaveLength(1);
    expect(result.completion.issueCount).toBe(1);
    expect(result.completed).toBe(false);
  });

  it('rejects removed old suite config keys', () => {
    expect(() =>
      readConfig(
        {
          name: 'weather',
          prompt: 'prompt.md',
          expectedToolSequence: ['snapshot_ui'],
        },
        'weather.yml',
      ),
    ).toThrow('weather.yml.expectedToolSequence: renamed to baselineToolSequence');

    expect(() =>
      readConfig(
        {
          name: 'weather',
          prompt: 'prompt.md',
          allowedVariance: { totalToolCalls: 2 },
        },
        'weather.yml',
      ),
    ).toThrow('weather.yml.allowedVariance: removed; baselines are observed data only');

    expect(() =>
      readConfig(
        {
          name: 'weather',
          prompt: 'prompt.md',
          sequence: { mode: 'fail' },
        },
        'weather.yml',
      ),
    ).toThrow(
      'weather.yml.sequence: removed; use baselineToolSequence for observed sequence reporting',
    );
  });

  it('accepts first-class Claude model config', () => {
    const config = readConfig(
      {
        name: 'weather',
        prompt: 'prompt.md',
        claude: { model: 'claude-sonnet-4-7' },
      },
      'weather.yml',
    );

    expect(config.claude?.model).toBe('claude-sonnet-4-7');
  });

  it('rejects Claude model flags in extraArgs', () => {
    for (const extraArgs of [['--model', 'sonnet'], ['--model=sonnet']]) {
      expect(() =>
        readConfig(
          {
            name: 'weather',
            prompt: 'prompt.md',
            claude: { extraArgs },
          },
          'weather.yml',
        ),
      ).toThrow('weather.yml.claude.extraArgs: use claude.model instead of --model');
    }
  });

  it('builds Claude args with suite model and CLI model override', () => {
    const config: BenchmarkConfig = {
      name: 'weather',
      prompt: 'prompt.md',
      claude: { model: 'suite-model' },
    };

    const fromSuite = buildClaudeArgs({
      config,
      artifacts: runMetadata(10).artifacts,
      workingDirectory: '/tmp/project',
    });
    const suiteModelFlagIndex = fromSuite.indexOf('--model');
    expect(fromSuite[suiteModelFlagIndex + 1]).toBe('suite-model');

    const overridden = buildClaudeArgs({
      config,
      artifacts: runMetadata(10).artifacts,
      workingDirectory: '/tmp/project',
      model: 'cli-model',
    });
    const modelFlagIndex = overridden.indexOf('--model');
    expect(overridden[modelFlagIndex + 1]).toBe('cli-model');
  });

  it('rejects invalid Claude timeout values when loading config', () => {
    for (const maxClaudeSeconds of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        readConfig(
          {
            name: 'weather',
            prompt: 'prompt.md',
            claude: { maxClaudeSeconds },
          },
          'weather.yml',
        ),
      ).toThrow('weather.yml.claude.maxClaudeSeconds: expected finite positive number');
    }
  });

  it('rejects malformed failure pattern regexes when loading config', () => {
    expect(() =>
      readConfig(
        {
          name: 'weather',
          prompt: 'prompt.md',
          failurePatterns: ['stale element ref', '[unclosed'],
        },
        'weather.yml',
      ),
    ).toThrow('weather.yml.failurePatterns[1]: invalid regular expression');
  });

  it('rejects activateSkill without skillDirs when loading config', () => {
    expect(() =>
      readConfig(
        {
          name: 'weather',
          prompt: 'prompt.md',
          claude: {
            activateSkill: 'vendor-cli',
            isolatedWorkingDirectory: true,
          },
        },
        'weather.yml',
      ),
    ).toThrow('weather.yml.claude.activateSkill: requires skillDirs');
  });

  it('rejects activateSkill that does not match skillDirs when loading config', () => {
    expect(() =>
      readConfig(
        {
          name: 'weather',
          prompt: 'prompt.md',
          claude: {
            skillDirs: ['benchmarks/claude-ui/local/skills/vendor-cli'],
            activateSkill: 'other-skill',
            isolatedWorkingDirectory: true,
          },
        },
        'weather.yml',
      ),
    ).toThrow('weather.yml.claude.activateSkill: must match a basename from skillDirs');
  });

  it('rejects duplicate skillDir basenames when loading config', () => {
    expect(() =>
      readConfig(
        {
          name: 'weather',
          prompt: 'prompt.md',
          claude: {
            skillDirs: [
              'benchmarks/claude-ui/local/skills/vendor-cli',
              'benchmarks/claude-ui/fixtures/skills/vendor-cli',
            ],
            isolatedWorkingDirectory: true,
          },
        },
        'weather.yml',
      ),
    ).toThrow("weather.yml.claude.skillDirs: duplicate basename 'vendor-cli'");
  });

  it('rejects invalid session defaults when loading config', () => {
    expect(() =>
      readConfig(
        {
          name: 'weather',
          prompt: 'prompt.md',
          sessionDefaults: {
            simulatorTypo: 'iPhone 17 Pro Max',
          },
        },
        'weather.yml',
      ),
    ).toThrow('Unrecognized key: "simulatorTypo"');

    expect(() =>
      readConfig(
        {
          name: 'weather',
          prompt: 'prompt.md',
          sessionDefaults: {
            projectPath: true,
          },
        },
        'weather.yml',
      ),
    ).toThrow('projectPath: Invalid input: expected string');

    expect(() =>
      readConfig(
        {
          name: 'weather',
          prompt: 'prompt.md',
          sessionDefaults: {
            arch: 'ppc',
          },
        },
        'weather.yml',
      ),
    ).toThrow('arch: Invalid option');
  });

  it('accepts session default env values supported by the runtime schema', () => {
    const config = readConfig(
      {
        name: 'weather',
        prompt: 'prompt.md',
        sessionDefaults: {
          env: { FEATURE_FLAG: '1' },
        },
      },
      'weather.yml',
    );

    expect(config.sessionDefaults?.env).toEqual({ FEATURE_FLAG: '1' });
  });

  it('reports observed metric and tool sequence deltas without affecting completion', () => {
    const config: BenchmarkConfig = {
      name: 'weather',
      prompt: 'prompt.md',
      baseline: {
        totalToolCalls: 4,
        mcpToolCalls: 3,
        uiAutomationCalls: 2,
        wallClockSeconds: 120,
      },
      baselineToolSequence: ['session_show_defaults', 'snapshot_ui', 'tap'],
    };
    const audit = analyzeClaudeJsonl(
      [
        line({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'tool-1',
                name: `${toolPrefix}session_show_defaults`,
                input: {},
              },
              { type: 'tool_use', id: 'tool-2', name: `${toolPrefix}snapshot_ui`, input: {} },
              { type: 'tool_use', id: 'tool-3', name: `${toolPrefix}screenshot`, input: {} },
              { type: 'tool_use', id: 'tool-4', name: `${toolPrefix}tap`, input: {} },
              { type: 'tool_use', id: 'tool-5', name: 'Read', input: {} },
            ],
          },
        }),
      ].join('\n'),
      { mcpToolPrefix: toolPrefix },
    );

    const result = compareBenchmark(config, audit, runMetadata(145));

    expect(result.metrics.find((item) => item.name === 'totalToolCalls')).toEqual({
      name: 'totalToolCalls',
      actual: 5,
      baseline: 4,
    });
    expect(result.metrics.find((item) => item.name === 'mcpToolCalls')).toEqual({
      name: 'mcpToolCalls',
      actual: 4,
      baseline: 3,
    });
    expect(result.sequence.matched).toBe(false);
    expect(result.sequence.additional).toEqual(['screenshot']);
    expect(result.completed).toBe(true);
  });

  it('reports actual and baseline metrics without variance classification', () => {
    const config: BenchmarkConfig = readConfig(
      {
        name: 'weather',
        prompt: 'prompt.md',
        baseline: {
          totalToolCalls: 3,
          wallClockSeconds: 120,
        },
      },
      'weather.yml',
    );
    const audit = analyzeClaudeJsonl(
      [
        line({
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', id: 'tool-1', name: 'Read', input: {} },
              { type: 'tool_use', id: 'tool-2', name: 'Edit', input: {} },
              { type: 'tool_use', id: 'tool-3', name: 'Write', input: {} },
            ],
          },
        }),
      ].join('\n'),
      { mcpToolPrefix: toolPrefix },
    );

    const result = compareBenchmark(config, audit, runMetadata(145));

    expect(result.metrics).toEqual([
      {
        name: 'totalToolCalls',
        actual: 3,
        baseline: 3,
      },
      {
        name: 'wallClockSeconds',
        actual: 145,
        baseline: 120,
      },
    ]);
  });

  it('reports tool sequence deltas without affecting completion', () => {
    const config: BenchmarkConfig = {
      name: 'weather',
      prompt: 'prompt.md',
      baselineToolSequence: ['session_show_defaults', 'snapshot_ui', 'tap'],
    };
    const audit = analyzeClaudeJsonl(
      [
        line({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'tool-1',
                name: `${toolPrefix}session_show_defaults`,
                input: {},
              },
              { type: 'tool_use', id: 'tool-2', name: `${toolPrefix}snapshot_ui`, input: {} },
              { type: 'tool_use', id: 'tool-3', name: `${toolPrefix}screenshot`, input: {} },
              { type: 'tool_use', id: 'tool-4', name: `${toolPrefix}tap`, input: {} },
            ],
          },
        }),
      ].join('\n'),
      { mcpToolPrefix: toolPrefix },
    );

    const result = compareBenchmark(config, audit, runMetadata(10));

    expect(result.sequence.matched).toBe(false);
    expect(result.sequence.additional).toEqual(['screenshot']);
    expect(result.completed).toBe(true);
  });

  it('marks the benchmark incomplete when the external parser exits non-zero', () => {
    const config: BenchmarkConfig = {
      name: 'weather',
      prompt: 'prompt.md',
    };
    const audit = analyzeClaudeJsonl('', { mcpToolPrefix: toolPrefix });

    const result = compareBenchmark(config, audit, runMetadata(10, 0, 1));

    expect(result.completion.completed).toBe(false);
    expect(result.completion.issueCount).toBe(1);
    expect(result.completed).toBe(false);
  });

  it('renders path-aware aggregate artifact roots', () => {
    const first = compareBenchmark(
      { name: 'first', prompt: 'prompt.md' },
      analyzeClaudeJsonl('', { mcpToolPrefix: toolPrefix }),
      {
        ...runMetadata(10),
        artifacts: {
          ...runMetadata(10).artifacts,
          runDirectory: '/tmp/run/first/20260101T000000Z',
        },
      },
    );
    const second = compareBenchmark(
      { name: 'second', prompt: 'prompt.md' },
      analyzeClaudeJsonl('', { mcpToolPrefix: toolPrefix }),
      {
        ...runMetadata(20),
        artifacts: {
          ...runMetadata(20).artifacts,
          runDirectory: '/tmp/run-extra/second/20260101T000000Z',
        },
      },
    );

    expect(renderAggregate([first, second], { color: false, cwd: '/tmp' })).toContain(
      'Artifacts: /tmp/',
    );
  });

  it('returns no sequence hunks when expected and actual match', () => {
    expect(diffToolSequence(['a', 'b'], ['a', 'b'])).toEqual([]);
  });
});
