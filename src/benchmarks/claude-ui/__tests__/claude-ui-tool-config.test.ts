import path from 'node:path';
import { buildClaudeArgs } from '../claude-invocation.ts';
import { compareBenchmark } from '../compare.ts';
import { readConfig } from '../config.ts';
import { analyzeClaudeJsonl } from '../transcript.ts';
import type { BenchmarkArtifacts, BenchmarkRunMetadata } from '../types.ts';

function line(value: unknown): string {
  return JSON.stringify(value);
}

function artifacts(runDirectory: string): BenchmarkArtifacts {
  return {
    runDirectory,
    promptPath: path.join(runDirectory, 'prompt.md'),
    mcpConfigPath: path.join(runDirectory, 'mcp-config.json'),
    mcpWorkspaceDirectory: path.join(runDirectory, 'mcp-workspace'),
    mcpWorkspaceConfigPath: path.join(runDirectory, 'mcp-workspace/.mobilebuildmcp/config.yaml'),
    claudeJsonlPath: path.join(runDirectory, 'claude.jsonl'),
    claudeStderrPath: path.join(runDirectory, 'claude.stderr'),
    claudeCommandLogPath: path.join(runDirectory, 'claude-command.log'),
    simulatorLifecycleLogPath: path.join(runDirectory, 'simulator-lifecycle.log'),
    parsedDirectory: path.join(runDirectory, 'parsed'),
    parseLogPath: path.join(runDirectory, 'parse.log'),
    resultJsonPath: path.join(runDirectory, 'result.json'),
  };
}

function runMetadata(wallClockSeconds: number): BenchmarkRunMetadata {
  return {
    suitePath: '/tmp/vendor-cli.yml',
    wallClockSeconds,
    claudeExitCode: 0,
    parserExitCode: 0,
    artifacts: artifacts('/tmp/run'),
  };
}

describe('Claude UI benchmark tool configuration', () => {
  it('loads Claude invocation and tool analysis from suite config', () => {
    const config = readConfig(
      {
        name: 'vendor CLI weather',
        prompt: 'weather.md',
        preflightCommands: ['open -a LocalBenchTool', 'vendorcli status'],
        failurePatternTargets: ['commands'],
        ignoredFailurePatterns: ['element_disabled'],
        claude: {
          useMcpServer: false,
          permissionMode: 'default',
          maxClaudeSeconds: 600,
          tools: ['Bash'],
          allowedTools: ['Bash(vendorcli *)', 'Bash(xcrun *)'],
          appendSystemPrompt: 'Target simulator: {simulatorId}',
          model: 'sonnet',
          pluginDirs: ['benchmarks/claude-ui/local/skills/vendor-cli'],
          skillDirs: ['benchmarks/claude-ui/local/skills/vendor-cli'],
          activateSkill: 'vendor-cli',
          isolatedWorkingDirectory: true,
        },
        toolAnalysis: {
          matchers: [
            {
              kind: 'bashCommand',
              commandPrefix: 'vendorcli ui screen',
              shortName: 'vendorcli.screen',
              uiAutomation: true,
            },
          ],
        },
      },
      'vendor-cli.yml',
    );

    expect(config.claude).toEqual({
      useMcpServer: false,
      permissionMode: 'default',
      maxClaudeSeconds: 600,
      tools: ['Bash'],
      allowedTools: ['Bash(vendorcli *)', 'Bash(xcrun *)'],
      appendSystemPrompt: 'Target simulator: {simulatorId}',
      model: 'sonnet',
      pluginDirs: ['benchmarks/claude-ui/local/skills/vendor-cli'],
      skillDirs: ['benchmarks/claude-ui/local/skills/vendor-cli'],
      activateSkill: 'vendor-cli',
      isolatedWorkingDirectory: true,
    });
    expect(config.preflightCommands).toEqual(['open -a LocalBenchTool', 'vendorcli status']);
    expect(config.failurePatternTargets).toEqual(['commands']);
    expect(config.ignoredFailurePatterns).toEqual(['element_disabled']);
    expect(config.toolAnalysis?.matchers).toEqual([
      {
        kind: 'bashCommand',
        commandPrefix: 'vendorcli ui screen',
        shortName: 'vendorcli.screen',
        uiAutomation: true,
      },
    ]);
  });

  it('builds Claude args without MCP wiring when configured for CLI tools', () => {
    const runArtifacts = artifacts('/tmp/run');
    const config = readConfig(
      {
        name: 'vendor CLI weather',
        prompt: 'weather.md',
        claude: {
          useMcpServer: false,
          permissionMode: 'default',
          tools: ['Bash'],
          allowedTools: ['Bash(vendorcli *)'],
          appendSystemPrompt: 'Use simulator {simulatorId} from {workingDirectory}',
          extraArgs: ['--setting-sources', 'project,local'],
        },
      },
      'vendor-cli.yml',
    );

    expect(
      buildClaudeArgs({
        config,
        artifacts: runArtifacts,
        workingDirectory: '/workspace',
        pluginDirs: ['/repo/benchmarks/claude-ui/local/skills/vendor-cli'],
        simulatorId: 'SIM-123',
      }),
    ).toEqual([
      '-p',
      '--verbose',
      '--output-format',
      'stream-json',
      '--disable-slash-commands',
      '--mcp-config',
      '/tmp/run/mcp-config.json',
      '--strict-mcp-config',
      '--tools',
      'Bash',
      '--allowedTools',
      'Bash(vendorcli *)',
      '--append-system-prompt',
      'Use simulator SIM-123 from /workspace',
      '--plugin-dir',
      '/repo/benchmarks/claude-ui/local/skills/vendor-cli',
      '--setting-sources',
      'project,local',
    ]);
  });

  it('tracks configured Bash command tools separately from total Claude tools', () => {
    const config = readConfig(
      {
        name: 'vendor CLI weather',
        prompt: 'weather.md',
        baseline: {
          totalToolCalls: 3,
          trackedToolCalls: 2,
          uiAutomationCalls: 1,
          tools: {
            'vendorcli.screen': 1,
            'xcodebuild.build': 1,
          },
        },
        baselineToolSequence: ['vendorcli.screen', 'xcodebuild.build'],
        toolAnalysis: {
          matchers: [
            {
              kind: 'bashCommand',
              commandPrefix: 'vendorcli ui screen',
              shortName: 'vendorcli.screen',
              uiAutomation: true,
            },
            {
              kind: 'bashCommand',
              commandPrefix: 'xcodebuild',
              shortName: 'xcodebuild.build',
            },
          ],
        },
      },
      'vendor-cli.yml',
    );
    const transcript = [
      line({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'Bash',
              input: { command: 'vendorcli ui screen --simulator SIM-123 --json' },
            },
            { type: 'tool_use', id: 'tool-2', name: 'Read', input: { file_path: 'README.md' } },
            {
              type: 'tool_use',
              id: 'tool-3',
              name: 'Bash',
              input: { command: 'xcodebuild -scheme App build' },
            },
          ],
        },
      }),
    ].join('\n');

    const audit = analyzeClaudeJsonl(transcript, { toolAnalysis: config.toolAnalysis });
    const result = compareBenchmark(config, audit, runMetadata(10));

    expect(audit.totalToolCalls).toBe(3);
    expect(audit.trackedToolCalls).toBe(2);
    expect(audit.mcpToolCalls).toBe(0);
    expect(audit.uiAutomationCalls).toBe(1);
    expect(result.sequence.actual).toEqual(['vendorcli.screen', 'xcodebuild.build']);
    expect(result.completed).toBe(true);
  });

  it('reports metric deltas when actual tool counts differ from the recorded baseline', () => {
    const config = readConfig(
      {
        name: 'vendor CLI weather',
        prompt: 'weather.md',
        baseline: {
          trackedToolCalls: 10,
          tools: {
            'vendorcli.screen': 8,
          },
        },
        toolAnalysis: {
          matchers: [
            {
              kind: 'bashCommand',
              commandPrefix: 'vendorcli ui screen',
              shortName: 'vendorcli.screen',
              uiAutomation: true,
            },
          ],
        },
      },
      'vendor-cli.yml',
    );
    const transcript = [
      line({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'Bash',
              input: { command: 'vendorcli ui screen --json' },
            },
          ],
        },
      }),
    ].join('\n');

    const audit = analyzeClaudeJsonl(transcript, { toolAnalysis: config.toolAnalysis });
    const result = compareBenchmark(config, audit, runMetadata(10));

    expect(result.completed).toBe(true);
    expect(result.metrics).toEqual([
      {
        name: 'trackedToolCalls',
        actual: 1,
        baseline: 10,
      },
      {
        name: 'tool:vendorcli.screen',
        actual: 1,
        baseline: 8,
      },
    ]);
  });

  it('uses the most specific Bash matcher once per command offset', () => {
    const config = readConfig(
      {
        name: 'vendor CLI weather',
        prompt: 'weather.md',
        toolAnalysis: {
          matchers: [
            {
              kind: 'bashCommand',
              commandPrefix: 'vendorcli',
              shortName: 'vendorcli.other',
            },
            {
              kind: 'bashCommand',
              commandPrefix: 'vendorcli ui screen',
              shortName: 'vendorcli.screen',
              uiAutomation: true,
            },
          ],
        },
      },
      'vendor-cli.yml',
    );
    const transcript = [
      line({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'Bash',
              input: { command: 'vendorcli ui screen --json && vendorcli --help' },
            },
          ],
        },
      }),
    ].join('\n');

    const audit = analyzeClaudeJsonl(transcript, { toolAnalysis: config.toolAnalysis });

    expect(audit.trackedToolCallsByName).toEqual({
      'vendorcli.screen': 1,
      'vendorcli.other': 1,
    });
    expect(audit.trackedSequence.map((call) => call.shortName)).toEqual([
      'vendorcli.screen',
      'vendorcli.other',
    ]);
  });

  it('reports real failures when ignored and reportable patterns share a result', () => {
    const config = readConfig(
      {
        name: 'private CLI weather',
        prompt: 'weather.md',
        failurePatterns: ['WAIT_TIMEOUT'],
        ignoredFailurePatterns: ['element_disabled'],
        toolAnalysis: {
          matchers: [
            {
              kind: 'bashCommand',
              commandPrefix: 'privatecli wait',
              shortName: 'privatecli.wait',
              uiAutomation: true,
            },
          ],
        },
      },
      'private-cli.yml',
    );
    const transcript = [
      line({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'Bash',
              input: { command: 'privatecli wait element --label Weather --timeout 1' },
            },
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
              is_error: true,
              content: 'Exit code 1\n{"error":{"code":"element_disabled"}}\nWAIT_TIMEOUT',
            },
          ],
        },
      }),
    ].join('\n');

    const audit = analyzeClaudeJsonl(transcript, {
      toolAnalysis: config.toolAnalysis,
      failurePatterns: config.failurePatterns,
      ignoredFailurePatterns: config.ignoredFailurePatterns,
    });
    const result = compareBenchmark(config, audit, runMetadata(10));

    expect(audit.failures).toHaveLength(1);
    expect(audit.patternFailures).toEqual([
      {
        pattern: 'WAIT_TIMEOUT',
        line: 2,
        excerpt: 'Exit code 1\n{"error":{"code":"element_disabled"}}\nWAIT_TIMEOUT',
      },
    ]);
    expect(result.completed).toBe(false);
  });

  it('ignores configured non-terminal tool failures', () => {
    const config = readConfig(
      {
        name: 'private CLI weather',
        prompt: 'weather.md',
        failurePatterns: ['WAIT_TIMEOUT'],
        ignoredFailurePatterns: ['wait_timeout', 'element_disabled'],
        toolAnalysis: {
          matchers: [
            {
              kind: 'bashCommand',
              commandPrefix: 'privatecli wait',
              shortName: 'privatecli.wait',
              uiAutomation: true,
            },
            {
              kind: 'bashCommand',
              commandPrefix: 'privatecli tap',
              shortName: 'privatecli.tap',
              uiAutomation: true,
            },
          ],
        },
      },
      'private-cli.yml',
    );
    const transcript = [
      line({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'Bash',
              input: { command: 'privatecli wait element --label Weather --timeout 1' },
            },
            {
              type: 'tool_use',
              id: 'tool-2',
              name: 'Bash',
              input: { command: 'privatecli tap --label Settings' },
            },
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
              is_error: true,
              content: 'Exit code 1\n{"error":{"code":"wait_timeout"}}',
            },
            {
              type: 'tool_result',
              tool_use_id: 'tool-2',
              is_error: true,
              content: 'Exit code 1\n{"error":{"code":"element_disabled"}}',
            },
          ],
        },
      }),
      line({ type: 'result', is_error: false, result: 'done' }),
    ].join('\n');

    const audit = analyzeClaudeJsonl(transcript, {
      toolAnalysis: config.toolAnalysis,
      failurePatterns: config.failurePatterns,
      ignoredFailurePatterns: config.ignoredFailurePatterns,
    });
    const result = compareBenchmark(config, audit, runMetadata(10));

    expect(audit.failures).toEqual([]);
    expect(audit.patternFailures).toEqual([]);
    expect(result.completed).toBe(true);
  });

  it('matches failure patterns against commands and tool results without treating final prose as a new failure', () => {
    const config = readConfig(
      {
        name: 'vendor CLI weather',
        prompt: 'weather.md',
        failurePatterns: ['idb', 'SNAPSHOT_MISSING'],
        toolAnalysis: {
          matchers: [
            {
              kind: 'bashCommand',
              commandPrefix: 'vendorcli ui screen',
              shortName: 'vendorcli.screen',
              uiAutomation: true,
            },
          ],
        },
      },
      'vendor-cli.yml',
    );
    const transcript = [
      line({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'Bash',
              input: { command: 'which idb' },
            },
            {
              type: 'tool_use',
              id: 'tool-2',
              name: 'Bash',
              input: { command: 'vendorcli ui screen --json' },
            },
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
              is_error: true,
              content: 'Exit code 1\nSNAPSHOT_MISSING',
            },
          ],
        },
      }),
      line({
        type: 'result',
        is_error: false,
        result: 'I tried idb earlier and saw SNAPSHOT_MISSING, then stopped.',
      }),
    ].join('\n');

    const audit = analyzeClaudeJsonl(transcript, {
      toolAnalysis: config.toolAnalysis,
      failurePatterns: config.failurePatterns,
    });

    expect(audit.patternFailures).toEqual([
      { pattern: 'idb', line: 1, excerpt: 'which idb' },
      { pattern: 'SNAPSHOT_MISSING', line: 2, excerpt: 'Exit code 1\nSNAPSHOT_MISSING' },
    ]);
  });

  it('can restrict failure pattern matching to commands', () => {
    const config = readConfig(
      {
        name: 'vendor CLI weather',
        prompt: 'weather.md',
        failurePatterns: ['mobilebuildmcp'],
        failurePatternTargets: ['commands'],
        toolAnalysis: {
          matchers: [
            {
              kind: 'bashCommand',
              commandPrefix: 'vendorcli',
              shortName: 'vendorcli.other',
            },
          ],
        },
      },
      'vendor-cli.yml',
    );
    const transcript = [
      line({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'Bash',
              input: { command: 'vendorcli run --json' },
            },
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
              content: 'Workspace: /Volumes/Developer/MobileBuildMCP/example_projects/Weather',
            },
          ],
        },
      }),
    ].join('\n');

    const audit = analyzeClaudeJsonl(transcript, {
      toolAnalysis: config.toolAnalysis,
      failurePatterns: config.failurePatterns,
      failurePatternTargets: config.failurePatternTargets,
    });

    expect(audit.patternFailures).toEqual([]);
  });

  it('records tool failures as benchmark stumbles', () => {
    const config = readConfig(
      {
        name: 'private CLI weather',
        prompt: 'weather.md',
        toolAnalysis: {
          matchers: [
            {
              kind: 'bashCommand',
              commandPrefix: 'privatecli',
              shortName: 'privatecli.other',
            },
          ],
        },
      },
      'private-cli.yml',
    );
    const transcript = [
      line({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'Bash',
              input: { command: 'privatecli --version' },
            },
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
              is_error: true,
              content: "Exit code 64\nError: Unknown option '--version'",
            },
          ],
        },
      }),
    ].join('\n');

    const audit = analyzeClaudeJsonl(transcript, { toolAnalysis: config.toolAnalysis });
    const result = compareBenchmark(config, audit, runMetadata(600));

    expect(result.completed).toBe(true);
    expect(result.completion).toEqual({
      completed: true,
      issueCount: 1,
    });
  });

  it('handles tracked tool results without content', () => {
    const config = readConfig(
      {
        name: 'private CLI weather',
        prompt: 'weather.md',
        failurePatterns: ['WAIT_TIMEOUT'],
        toolAnalysis: {
          matchers: [
            {
              kind: 'bashCommand',
              commandPrefix: 'privatecli',
              shortName: 'privatecli.other',
            },
          ],
        },
      },
      'private-cli.yml',
    );
    const transcript = [
      line({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'Bash',
              input: { command: 'privatecli --version' },
            },
          ],
        },
      }),
      line({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tool-1', is_error: true }],
        },
      }),
    ].join('\n');

    const audit = analyzeClaudeJsonl(transcript, {
      toolAnalysis: config.toolAnalysis,
      failurePatterns: config.failurePatterns,
    });

    expect(audit.failures).toEqual([
      {
        id: 'tool-1',
        fullName: 'Bash',
        shortName: 'privatecli.other',
        line: 2,
        message: '',
      },
    ]);
    expect(audit.patternFailures).toEqual([]);
  });

  it('counts repeated matches in one Bash failure result once', () => {
    const config = readConfig(
      {
        name: 'private CLI weather',
        prompt: 'weather.md',
        toolAnalysis: {
          matchers: [
            {
              kind: 'bashCommand',
              commandPrefix: 'privatecli',
              shortName: 'privatecli.other',
            },
          ],
        },
      },
      'private-cli.yml',
    );
    const transcript = [
      line({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'Bash',
              input: { command: 'privatecli one && privatecli two' },
            },
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
              is_error: true,
              content: 'Exit code 1',
            },
          ],
        },
      }),
    ].join('\n');

    const audit = analyzeClaudeJsonl(transcript, { toolAnalysis: config.toolAnalysis });
    const result = compareBenchmark(config, audit, runMetadata(600));

    expect(audit.trackedSequence.map((call) => call.shortName)).toEqual([
      'privatecli.other',
      'privatecli.other',
    ]);
    expect(audit.failures).toHaveLength(1);
    expect(result.completion.issueCount).toBe(1);
  });

  it('marks the benchmark incomplete when Claude exits non-zero', () => {
    const config = readConfig(
      {
        name: 'private CLI weather',
        prompt: 'weather.md',
      },
      'private-cli.yml',
    );
    const audit = analyzeClaudeJsonl('', {});
    const result = compareBenchmark(config, audit, {
      ...runMetadata(600),
      claudeExitCode: 143,
    });

    expect(result.completed).toBe(false);
    expect(result.completion).toEqual({
      completed: false,
      issueCount: 1,
    });
  });

  it('keeps configured non-MCP tool names in transcript analysis', () => {
    const config = readConfig(
      {
        name: 'vendor CLI weather',
        prompt: 'weather.md',
        toolAnalysis: {
          matchers: [
            {
              kind: 'bashCommand',
              commandPrefix: 'vendorcli ui screen',
              shortName: 'vendorcli.screen',
            },
          ],
        },
      },
      'vendor-cli.yml',
    );
    const transcript = [
      line({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'Bash',
              input: { command: 'vendorcli ui screen --json' },
            },
          ],
        },
      }),
    ].join('\n');

    const audit = analyzeClaudeJsonl(transcript, { toolAnalysis: config.toolAnalysis });

    expect(
      audit.trackedSequence.map((call) => ({
        fullName: call.fullName,
        shortName: call.shortName,
        isUiAutomation: call.isUiAutomation,
        line: call.line,
      })),
    ).toEqual([
      {
        fullName: 'Bash',
        shortName: 'vendorcli.screen',
        isUiAutomation: false,
        line: 1,
      },
    ]);
  });
});
