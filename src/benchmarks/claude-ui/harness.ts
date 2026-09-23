import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, cp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { finished } from 'node:stream/promises';
import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';
import {
  benchmarkContextEnv,
  buildClaudeArgs,
  parserToolArgs,
  usesMcpServer,
} from './claude-invocation.ts';
import { compareBenchmark } from './compare.ts';
import { loadSuite } from './config.ts';
import {
  bundledParserPath,
  localSuitesDir,
  mcpToolPrefix,
  repoRoot,
  suitesDir,
} from './constants.ts';
import { dismissFirstRunPrompts } from './first-run-preflight.ts';
import {
  claudeBenchmarkEnv,
  requireFirstRunPreflightSimulatorId,
  writeClaudeMcpConfig,
} from './mcp-config.ts';
import { runPreflightCommands } from './preflight-commands.ts';
import { createProgressReporter, type ProgressReporter } from './progress.ts';
import { renderAggregate, renderSuiteReport } from './render.ts';
import { deleteTemporarySimulator } from './simulator-deletion.ts';
import {
  prepareTemporarySimulator,
  resolveTemporarySimulatorPlan,
  type CreatedTemporarySimulator,
  type LifecycleCommandExecutor,
  type PreparedSimulator,
} from './simulator-lifecycle.ts';
import { analyzeClaudeJsonl } from './transcript.ts';
import type {
  BenchmarkArtifacts,
  BenchmarkConfig,
  BenchmarkResult,
  BenchmarkRunMetadata,
  ClaudeVersionProbe,
  TemporarySimulatorRunMetadata,
  ToolAnalysisConfig,
} from './types.ts';

const parserEnvName = 'CLAUDE_UI_BENCHMARK_PARSER';
interface CommandResult {
  exitCode: number | null;
  durationSeconds: number;
}
interface StreamJsonResult {
  type?: unknown;
  is_error?: unknown;
}
interface CapturedCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}
interface SuiteDirectories {
  suitesDir: string;
  localSuitesDir: string;
}
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function resolveSuitePath(
  suite: string,
  directories: SuiteDirectories = { suitesDir, localSuitesDir },
): Promise<string> {
  if (
    path.isAbsolute(suite) ||
    suite.includes(path.sep) ||
    suite.endsWith('.yml') ||
    suite.endsWith('.yaml')
  ) {
    return path.resolve(suite);
  }

  const candidates = [
    path.join(directories.suitesDir, `${suite}.yml`),
    path.join(directories.localSuitesDir, `${suite}.yml`),
  ];
  const matches = [];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) matches.push(candidate);
  }
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new Error(
      `suite name '${suite}' matches multiple suite files; pass an explicit path:\n${matches.join('\n')}`,
    );
  }
  return candidates[0]!;
}

async function listYamlFiles(directory: string, required: boolean): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (!required) return [];
    throw error;
  }
  return entries
    .filter(
      (entry) => entry.isFile() && (entry.name.endsWith('.yml') || entry.name.endsWith('.yaml')),
    )
    .map((entry) => path.join(directory, entry.name))
    .sort();
}

export async function listSuitePaths(
  directories: SuiteDirectories = { suitesDir, localSuitesDir },
): Promise<string[]> {
  return [
    ...(await listYamlFiles(directories.suitesDir, true)),
    ...(await listYamlFiles(directories.localSuitesDir, false)),
  ];
}

export function requireSuitePaths(suitePaths: string[]): string[] {
  if (suitePaths.length === 0) {
    throw new Error('no suite files found in benchmarks/claude-ui/suites');
  }
  return suitePaths;
}

function suiteSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-|-$/g, '');
  if (!slug) throw new Error(`invalid suite name '${name}'`);
  return slug;
}

function timestamp(): string {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

function resolveFrom(baseDir: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(baseDir, filePath);
}

async function installProjectSkills(opts: {
  skillDirs: string[] | undefined;
  claudeWorkingDirectory: string;
}): Promise<string[]> {
  if (!opts.skillDirs || opts.skillDirs.length === 0) return [];
  const projectSkillsDirectory = path.join(opts.claudeWorkingDirectory, '.claude', 'skills');
  await mkdir(projectSkillsDirectory, { recursive: true });
  const installed: string[] = [];
  for (const skillDir of opts.skillDirs) {
    const skillName = path.basename(skillDir);
    const target = path.join(projectSkillsDirectory, skillName);
    await cp(skillDir, target, { recursive: true, force: true });
    installed.push(target);
  }
  return installed;
}

async function readActivatedSkillPrompt(opts: {
  skillName: string;
  installedSkillDirs: string[];
}): Promise<{ prompt: string; skillPath: string }> {
  const installedSkillDir = opts.installedSkillDirs.find(
    (skillDir) => path.basename(skillDir) === opts.skillName,
  );
  if (!installedSkillDir) {
    throw new Error(
      `claude.activateSkill '${opts.skillName}' was not installed from claude.skillDirs`,
    );
  }
  const skillPath = path.join(installedSkillDir, 'SKILL.md');
  const skillBody = await readFile(skillPath, 'utf8');
  return {
    skillPath,
    prompt: [
      `Load this Claude Code skill for the benchmark session: ${opts.skillName}.`,
      'Use these instructions as the active skill context for subsequent turns.',
      'Do not begin the benchmark task yet; only acknowledge that the skill context is loaded.',
      '',
      `<skill name="${opts.skillName}" source="${skillPath}">`,
      skillBody,
      '</skill>',
      '',
    ].join('\n'),
  };
}

export async function resolveParserPath(parserPath: string | undefined): Promise<string> {
  const configured = parserPath ?? process.env[parserEnvName] ?? bundledParserPath;
  const resolved = path.resolve(configured);
  try {
    await access(resolved);
  } catch {
    throw new Error(`Claude UI benchmark parser does not exist: ${resolved}`);
  }
  return resolved;
}

function runCapturedCommand(opts: {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<CapturedCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.on('error', reject);
    child.on('close', (exitCode) => {
      resolve({
        exitCode: exitCode ?? null,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
  });
}

async function probeClaudeVersion(opts: {
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<ClaudeVersionProbe> {
  const command = ['claude', '--version'];
  const result = await runCapturedCommand({
    command: command[0]!,
    args: command.slice(1),
    cwd: opts.cwd,
    env: opts.env,
  });
  return { command, ...result };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function extractObservedClaudeModel(
  summary: Record<string, unknown> | undefined,
  requestedModel?: string | null,
): string | null {
  const raw = summary?.model ?? summary?.model_name;
  if (typeof raw === 'string' && raw.length > 0) return raw;

  const modelUsage = summary?.modelUsage;
  if (!isRecord(modelUsage)) return null;

  const modelNames = Object.keys(modelUsage).filter((name) => name.length > 0);
  if (modelNames.length === 0) return null;

  if (requestedModel) {
    const requested = modelNames.find(
      (name) => name === requestedModel || name.startsWith(`${requestedModel}-`),
    );
    if (requested) return requested;
  }

  const primaryModels = modelNames.filter((name) => !name.includes('haiku'));
  if (primaryModels.length === 1) return primaryModels[0]!;
  if (modelNames.length === 1) return modelNames[0]!;
  return modelNames.join(', ');
}

function runCommand(opts: {
  command: string;
  args: string[];
  cwd: string;
  stdin?: string;
  stdoutPath: string;
  stderrPath: string;
  env?: NodeJS.ProcessEnv;
  terminalJsonResultGraceMs?: number;
  timeoutMs?: number;
}): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const stdout = createWriteStream(opts.stdoutPath);
    const stderr = createWriteStream(opts.stderrPath);
    const started = process.hrtime.bigint();
    let stdoutBuffer = '';
    let terminalResultExitCode: number | undefined;
    let terminalResultRequestedTermination = false;
    let terminalResultTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let hardKillTimer: NodeJS.Timeout | undefined;
    let timedOut = false;
    let settled = false;
    const child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: opts.terminalJsonResultGraceMs !== undefined || opts.timeoutMs !== undefined,
    });

    const clearTerminalResultTimer = (): void => {
      if (terminalResultTimer) clearTimeout(terminalResultTimer);
      terminalResultTimer = undefined;
    };

    const clearTimeoutTimer = (): void => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      timeoutTimer = undefined;
    };

    const clearHardKillTimer = (): void => {
      if (hardKillTimer) clearTimeout(hardKillTimer);
      hardKillTimer = undefined;
    };

    const killChild = (signal: NodeJS.Signals): void => {
      if (child.exitCode !== null || child.killed || child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // Ignore termination races; the close handler will resolve once stdio closes.
        }
      }
    };

    const terminateChild = (): void => {
      if (child.exitCode !== null || child.killed || child.pid === undefined) return;
      killChild('SIGTERM');
      if (hardKillTimer !== undefined) return;
      hardKillTimer = setTimeout(() => {
        killChild('SIGKILL');
      }, 5_000);
      hardKillTimer.unref();
    };

    const rejectCommand = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTerminalResultTimer();
      clearTimeoutTimer();
      clearHardKillTimer();
      terminateChild();
      stdout.destroy();
      stderr.destroy();
      reject(error);
    };

    const recordTerminalResult = (result: StreamJsonResult): void => {
      if (terminalResultExitCode !== undefined || opts.terminalJsonResultGraceMs === undefined)
        return;
      terminalResultExitCode = result.is_error === true ? 1 : 0;
      terminalResultTimer = setTimeout(() => {
        terminalResultRequestedTermination = true;
        terminateChild();
      }, opts.terminalJsonResultGraceMs);
      terminalResultTimer.unref();
    };

    if (opts.timeoutMs !== undefined) {
      timeoutTimer = setTimeout(() => {
        if (terminalResultExitCode === undefined) {
          timedOut = true;
        } else {
          terminalResultRequestedTermination = true;
        }
        terminateChild();
      }, opts.timeoutMs);
      timeoutTimer.unref();
    }

    const scanStdoutForTerminalResult = (chunk: Buffer): void => {
      if (opts.terminalJsonResultGraceMs === undefined || terminalResultExitCode !== undefined)
        return;
      stdoutBuffer += chunk.toString('utf8');
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim().length === 0) continue;
        try {
          const record = JSON.parse(line) as StreamJsonResult;
          if (record.type === 'result') recordTerminalResult(record);
        } catch {
          // Claude stream-json records are newline-delimited JSON. Ignore non-JSON fragments.
        }
      }
    };

    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return;
      stdout.write(chunk);
      scanStdoutForTerminalResult(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (settled) return;
      stderr.write(chunk);
    });
    child.on('error', (error) => {
      rejectCommand(error);
    });
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EPIPE') return;
      rejectCommand(error);
    });
    child.on('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTerminalResultTimer();
      clearTimeoutTimer();
      clearHardKillTimer();
      const durationSeconds = Number(process.hrtime.bigint() - started) / 1_000_000_000;
      const resolvedExitCode =
        terminalResultExitCode !== undefined &&
        (terminalResultRequestedTermination || exitCode === 0 || exitCode === null)
          ? terminalResultExitCode
          : timedOut
            ? 143
            : (exitCode ?? null);
      stdout.end();
      stderr.end();
      Promise.all([finished(stdout), finished(stderr)])
        .then(() =>
          resolve({
            exitCode: resolvedExitCode,
            durationSeconds,
          }),
        )
        .catch(reject);
    });

    if (opts.stdin !== undefined) {
      child.stdin.end(opts.stdin);
    } else {
      child.stdin.end();
    }
  });
}

function claudeTaskTimeoutMs(config: BenchmarkConfig): number | undefined {
  if (config.claude?.maxClaudeSeconds !== undefined) return config.claude.maxClaudeSeconds * 1000;
  return undefined;
}

async function runParser(
  artifacts: BenchmarkArtifacts,
  parserPath: string,
  toolAnalysis: ToolAnalysisConfig | undefined,
): Promise<number | null> {
  const result = await runCommand({
    command: 'python3',
    args: [
      parserPath,
      artifacts.claudeJsonlPath,
      artifacts.parsedDirectory,
      ...parserToolArgs(toolAnalysis),
    ],
    cwd: repoRoot,
    stdoutPath: artifacts.parseLogPath,
    stderrPath: `${artifacts.parseLogPath}.stderr`,
  });
  return result.exitCode;
}

function normalizeStoredResult(result: BenchmarkResult): BenchmarkResult {
  if (
    !result.sequence ||
    !Array.isArray(result.sequence.missing) ||
    !Array.isArray(result.sequence.additional)
  ) {
    throw new Error(
      'unsupported result.json: expected sequence.missing and sequence.additional arrays',
    );
  }

  const matched =
    result.sequence.matched ??
    (result.sequence.missing.length === 0 && result.sequence.additional.length === 0);

  if (typeof result.completed !== 'boolean' || !result.completion) {
    throw new Error('unsupported result.json: expected completed and completion fields');
  }

  return {
    ...result,
    sequence: {
      ...result.sequence,
      matched,
    },
  };
}

async function readStoredResult(
  resultPathOrDirectory: string,
): Promise<BenchmarkResult | BenchmarkResult[]> {
  const resolved = path.resolve(resultPathOrDirectory);
  const resultPath = (await stat(resolved)).isDirectory()
    ? path.join(resolved, 'result.json')
    : resolved;
  const raw = JSON.parse(await readFile(resultPath, 'utf8')) as BenchmarkResult | BenchmarkResult[];
  return Array.isArray(raw) ? raw.map(normalizeStoredResult) : normalizeStoredResult(raw);
}
function temporarySimulatorMetadata(
  temporarySimulator: CreatedTemporarySimulator | undefined,
  setupDurationSeconds: number,
): TemporarySimulatorRunMetadata | undefined {
  if (!temporarySimulator) return undefined;
  return {
    simulatorId: temporarySimulator.simulatorId,
    name: temporarySimulator.name,
    lifecycleLogPath: temporarySimulator.logPath,
    setupDurationSeconds,
    deletionAttempted: false,
  };
}

function recordTemporarySimulatorDeletion(
  metadata: TemporarySimulatorRunMetadata | undefined,
  deletion: Awaited<ReturnType<typeof deleteTemporarySimulator>>,
): void {
  if (!metadata) return;
  metadata.deletionAttempted = deletion.attempted;
  metadata.deletionSucceeded = deletion.succeeded;
  metadata.deleteExitCode = deletion.exitCode;
  if (deletion.error) metadata.deleteError = deletion.error;
}

export async function runSuite(
  suitePath: string,
  opts: {
    simulatorExecutor?: LifecycleCommandExecutor;
    progress?: ProgressReporter;
    parserPath?: string;
    model?: string;
  } = {},
): Promise<BenchmarkResult> {
  const config = await loadSuite(suitePath);
  const parserPath = await resolveParserPath(opts.parserPath);
  const slug = suiteSlug(config.name);
  const runTimestamp = timestamp();
  const runDirectory = path.join(repoRoot, 'out.nosync', 'claude-benchmarks', slug, runTimestamp);
  await mkdir(runDirectory, { recursive: true });
  const progress = opts.progress;
  progress?.event(`artifacts: ${path.relative(process.cwd(), runDirectory) || runDirectory}`);

  const artifacts: BenchmarkArtifacts = {
    runDirectory,
    promptPath: path.join(runDirectory, 'prompt.md'),
    mcpConfigPath: path.join(runDirectory, 'mcp-config.json'),
    mcpWorkspaceDirectory: path.join(runDirectory, 'mcp-workspace'),
    mcpWorkspaceConfigPath: path.join(
      runDirectory,
      'mcp-workspace',
      '.mobilebuildmcp',
      'config.yaml',
    ),
    claudeJsonlPath: path.join(runDirectory, 'claude.jsonl'),
    claudeStderrPath: path.join(runDirectory, 'claude.stderr'),
    claudeCommandLogPath: path.join(runDirectory, 'claude-command.log'),
    simulatorLifecycleLogPath: path.join(runDirectory, 'simulator-lifecycle.log'),
    parsedDirectory: path.join(runDirectory, 'parsed'),
    parseLogPath: path.join(runDirectory, 'parse.log'),
    resultJsonPath: path.join(runDirectory, 'result.json'),
  };

  let temporarySimulator: PreparedSimulator | undefined;
  let temporarySimulatorRun: TemporarySimulatorRunMetadata | undefined;
  let result: BenchmarkResult | undefined;

  try {
    const simulatorPlan = resolveTemporarySimulatorPlan(config);
    if (simulatorPlan.enabled) {
      progress?.event(`creating temporary simulator (${simulatorPlan.deviceTypeName})`);
    } else if (simulatorPlan.existingSimulatorId) {
      progress?.event(`using suite simulatorId ${simulatorPlan.existingSimulatorId}`);
    } else {
      progress?.event(`temporary simulator disabled (${simulatorPlan.reason ?? 'not enabled'})`);
    }

    const simulatorSetupStarted = process.hrtime.bigint();
    temporarySimulator = await prepareTemporarySimulator({
      config,
      suiteSlug: slug,
      timestamp: runTimestamp,
      cwd: repoRoot,
      logPath: artifacts.simulatorLifecycleLogPath,
      executor: opts.simulatorExecutor,
      onEvent: (message) => progress?.event(message),
    });
    const simulatorSetupDurationSeconds =
      Number(process.hrtime.bigint() - simulatorSetupStarted) / 1_000_000_000;
    temporarySimulatorRun = temporarySimulatorMetadata(
      temporarySimulator?.createdByHarness === true ? temporarySimulator : undefined,
      simulatorSetupDurationSeconds,
    );
    if (temporarySimulator?.createdByHarness === true) {
      progress?.event(`simulator setup took ${simulatorSetupDurationSeconds.toFixed(2)}s`);
    }

    const effectiveSimulatorId = requireFirstRunPreflightSimulatorId(config, temporarySimulator);
    if (effectiveSimulatorId) {
      await dismissFirstRunPrompts({
        config,
        simulatorId: effectiveSimulatorId,
        cwd: repoRoot,
        logPath: artifacts.simulatorLifecycleLogPath,
        executor: opts.simulatorExecutor,
        onEvent: (message) => progress?.event(message),
      });
    }

    const workingDirectory = config.workingDirectory
      ? resolveFrom(repoRoot, config.workingDirectory)
      : repoRoot;
    const claudeWorkingDirectory = config.claude?.isolatedWorkingDirectory
      ? path.join(tmpdir(), 'mobilebuildmcp-claude-ui-cwd', slug, runTimestamp)
      : workingDirectory;
    if (config.claude?.isolatedWorkingDirectory) {
      await mkdir(claudeWorkingDirectory, { recursive: true });
    }
    if (config.claude?.skillDirs && config.claude.isolatedWorkingDirectory !== true) {
      throw new Error(`${config.name}: claude.skillDirs requires claude.isolatedWorkingDirectory`);
    }
    const installedSkillDirs = await installProjectSkills({
      skillDirs: config.claude?.skillDirs?.map((skillDir) => resolveFrom(repoRoot, skillDir)),
      claudeWorkingDirectory,
    });
    const contextEnv = benchmarkContextEnv({
      runDirectory,
      workingDirectory,
      simulatorId: effectiveSimulatorId,
    });
    const benchmarkEnv = claudeBenchmarkEnv(process.env, contextEnv);
    await runPreflightCommands({
      commands: config.preflightCommands,
      cwd: workingDirectory,
      env: benchmarkEnv,
      logPath: artifacts.simulatorLifecycleLogPath,
      simulatorId: effectiveSimulatorId,
      onEvent: (message) => progress?.event(message),
    });

    const suiteDirectory = path.dirname(suitePath);
    const promptPath = resolveFrom(suiteDirectory, config.prompt);
    const prompt = await readFile(promptPath, 'utf8');

    await writeFile(artifacts.promptPath, prompt, 'utf8');
    const useMcpServer = usesMcpServer(config);
    await writeClaudeMcpConfig({
      config,
      enabled: useMcpServer,
      mcpConfigPath: artifacts.mcpConfigPath,
      mcpWorkspaceDirectory: artifacts.mcpWorkspaceDirectory,
      mcpWorkspaceConfigPath: artifacts.mcpWorkspaceConfigPath,
      workingDirectory,
      temporarySimulator,
    });

    const claudeSessionId = config.claude?.activateSkill ? randomUUID() : undefined;
    const requestedClaudeModel = opts.model ?? config.claude?.model ?? null;
    const claudeVersion = await probeClaudeVersion({
      cwd: claudeWorkingDirectory,
      env: benchmarkEnv,
    });
    const baseClaudeArgs = {
      config,
      artifacts,
      workingDirectory,
      pluginDirs: config.claude?.pluginDirs?.map((pluginDir) => resolveFrom(repoRoot, pluginDir)),
      simulatorId: effectiveSimulatorId,
      model: opts.model,
    };
    const claudeArgs = buildClaudeArgs({
      ...baseClaudeArgs,
      resumeSessionId: claudeSessionId,
    });
    await writeFile(
      artifacts.claudeCommandLogPath,
      `Run dir: ${runDirectory}\nCommand: claude ${claudeArgs.join(' ')} < ${artifacts.promptPath} > ${artifacts.claudeJsonlPath} 2> ${artifacts.claudeStderrPath}\nWorking directory: ${claudeWorkingDirectory}\nBenchmark working directory: ${workingDirectory}\nMCP server enabled: ${String(useMcpServer)}\nMCP workspace: ${useMcpServer ? artifacts.mcpWorkspaceDirectory : 'disabled'}\nMCP workspace config: ${useMcpServer ? artifacts.mcpWorkspaceConfigPath : 'disabled'}\nSimulator lifecycle log: ${artifacts.simulatorLifecycleLogPath}\nSimulator ID: ${effectiveSimulatorId ?? 'suite/default'}\nClaude session ID: ${claudeSessionId ?? 'new task session'}\nRequested model: ${requestedClaudeModel ?? 'default'}\nClaude version command: ${claudeVersion.command.join(' ')}\nClaude version exit status: ${claudeVersion.exitCode}\nClaude version stdout: ${claudeVersion.stdout.trim() || '(empty)'}\nClaude version stderr: ${claudeVersion.stderr.trim() || '(empty)'}\nStarted: ${new Date().toISOString()}\n`,
      'utf8',
    );
    if (installedSkillDirs.length > 0) {
      await writeFile(
        artifacts.claudeCommandLogPath,
        `Installed project skills:\n${installedSkillDirs.map((skillDir) => `- ${skillDir}`).join('\n')}\n`,
        { flag: 'a' },
      );
    }

    if (config.claude?.activateSkill) {
      const activationArgs = buildClaudeArgs({
        ...baseClaudeArgs,
        sessionId: claudeSessionId,
      });
      const activationStdoutPath = path.join(runDirectory, 'claude-skill-activation.jsonl');
      const activationStderrPath = path.join(runDirectory, 'claude-skill-activation.stderr');
      const activationPromptPath = path.join(runDirectory, 'claude-skill-activation.md');
      const activationPrompt = await readActivatedSkillPrompt({
        skillName: config.claude.activateSkill,
        installedSkillDirs,
      });
      await writeFile(activationPromptPath, activationPrompt.prompt, 'utf8');
      await writeFile(
        artifacts.claudeCommandLogPath,
        [
          `Skill activation source: ${activationPrompt.skillPath}`,
          `Skill activation prompt: ${activationPromptPath}`,
          `Skill activation command: claude ${activationArgs.join(' ')} < ${activationPromptPath} > ${activationStdoutPath} 2> ${activationStderrPath}`,
          '',
        ].join('\n'),
        { flag: 'a' },
      );
      progress?.event(`loading skill ${config.claude.activateSkill}`);
      const activation = await runCommand({
        command: 'claude',
        args: activationArgs,
        cwd: claudeWorkingDirectory,
        stdin: activationPrompt.prompt,
        stdoutPath: activationStdoutPath,
        stderrPath: activationStderrPath,
        env: benchmarkEnv,
        terminalJsonResultGraceMs: 5_000,
        timeoutMs: 60_000,
      });
      await writeFile(
        artifacts.claudeCommandLogPath,
        `Skill activation finished: ${new Date().toISOString()}\nSkill activation exit status: ${activation.exitCode}\nSkill activation wall clock seconds: ${activation.durationSeconds.toFixed(2)}\n`,
        { flag: 'a' },
      );
      if (activation.exitCode !== 0) {
        throw new Error(
          `${config.name}: skill activation /${config.claude.activateSkill} failed with exit ${activation.exitCode}`,
        );
      }
    }

    progress?.event('launching claude');
    const claude = await runCommand({
      command: 'claude',
      args: claudeArgs,
      cwd: claudeWorkingDirectory,
      stdin: prompt,
      stdoutPath: artifacts.claudeJsonlPath,
      stderrPath: artifacts.claudeStderrPath,
      env: benchmarkEnv,
      terminalJsonResultGraceMs: 5_000,
      timeoutMs: claudeTaskTimeoutMs(config),
    });
    progress?.event(
      `claude finished in ${claude.durationSeconds.toFixed(2)}s (exit ${claude.exitCode ?? 'null'})`,
    );

    await writeFile(
      artifacts.claudeCommandLogPath,
      `Finished: ${new Date().toISOString()}\nExit status: ${claude.exitCode}\nWall clock seconds: ${claude.durationSeconds.toFixed(2)}\n`,
      { flag: 'a' },
    );

    progress?.event('parsing transcript');
    const parserExitCode = await runParser(artifacts, parserPath, config.toolAnalysis);
    progress?.event(`parser finished (exit ${parserExitCode ?? 'null'})`);

    progress?.event('evaluating result');
    const jsonl = await readFile(artifacts.claudeJsonlPath, 'utf8');
    const audit = analyzeClaudeJsonl(jsonl, {
      mcpToolPrefix,
      toolAnalysis: config.toolAnalysis,
      failurePatterns: config.failurePatterns,
      failurePatternTargets: config.failurePatternTargets,
      ignoredFailurePatterns: config.ignoredFailurePatterns,
    });
    const observedClaudeModel = extractObservedClaudeModel(
      audit.resultSummary,
      requestedClaudeModel,
    );
    await writeFile(
      artifacts.claudeCommandLogPath,
      `Observed model: ${observedClaudeModel ?? 'unknown'}\n`,
      { flag: 'a' },
    );
    const run: BenchmarkRunMetadata = {
      suitePath,
      wallClockSeconds: claude.durationSeconds,
      claudeExitCode: claude.exitCode,
      parserExitCode,
      artifacts,
      temporarySimulator: temporarySimulatorRun,
      claude: {
        requestedModel: requestedClaudeModel,
        observedModel: observedClaudeModel,
        version: claudeVersion,
      },
    };
    result = compareBenchmark(config, audit, run);
  } finally {
    if (temporarySimulator?.createdByHarness === true) {
      progress?.event(`cleaning up simulator ${temporarySimulator.simulatorId}`);
      try {
        const deletion = await deleteTemporarySimulator(temporarySimulator, {
          cwd: repoRoot,
          executor: opts.simulatorExecutor,
        });
        recordTemporarySimulatorDeletion(temporarySimulatorRun, deletion);
        progress?.event(
          deletion.succeeded
            ? 'simulator deleted'
            : `simulator delete failed (exit ${deletion.exitCode ?? 'null'})`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        recordTemporarySimulatorDeletion(temporarySimulatorRun, {
          attempted: true,
          succeeded: false,
          exitCode: null,
          error: message,
        });
        progress?.event(`simulator delete failed (${message})`);
      }
    }
  }

  if (!result) throw new Error(`${suitePath}: suite did not produce a result`);
  await writeFile(artifacts.resultJsonPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return result;
}

export async function main(argv = hideBin(process.argv)): Promise<number> {
  const args = await yargs(argv)
    .option('suite', { type: 'string', describe: 'Suite name or path to a suite YAML file' })
    .option('all', {
      type: 'boolean',
      default: false,
      describe: 'Run every YAML suite in benchmarks/claude-ui/suites',
    })
    .option('json', {
      type: 'boolean',
      default: false,
      describe: 'Print machine-readable JSON results',
    })
    .option('parser', {
      type: 'string',
      describe: `Path to parse_claude_conversation.py (defaults to benchmarks/claude-ui/parse_claude_conversation.py; can also set ${parserEnvName})`,
    })
    .option('model', {
      type: 'string',
      describe:
        'Claude model to request for benchmark runs; overrides claude.model in the suite YAML',
    })
    .option('from-result', {
      type: 'string',
      describe: 'Render an existing result.json or artifact directory without running Claude',
    })
    .strict()
    .parse();

  if (args.model !== undefined && args.model.length === 0) {
    throw new Error('--model requires a non-empty value');
  }

  if (args.fromResult) {
    if (args.all || args.suite) {
      throw new Error('pass --from-result without --suite or --all');
    }

    const storedResult = await readStoredResult(args.fromResult);
    const results = Array.isArray(storedResult) ? storedResult : [storedResult];
    if (args.json) {
      process.stdout.write(`${JSON.stringify(storedResult, null, 2)}\n`);
    } else {
      for (const item of results) process.stdout.write(renderSuiteReport(item));
      if (results.length > 1) process.stdout.write(`\n${renderAggregate(results)}`);
    }
    return results.every((item) => item.completed) ? 0 : 1;
  }

  if ((args.all && args.suite) || (!args.all && !args.suite)) {
    throw new Error('pass exactly one of --suite <name-or-path>, --all, or --from-result <path>');
  }

  const suitePaths = requireSuitePaths(
    args.all ? await listSuitePaths() : [await resolveSuitePath(args.suite as string)],
  );
  const progress = createProgressReporter({ enabled: !args.json });
  const results: BenchmarkResult[] = [];
  for (let index = 0; index < suitePaths.length; index += 1) {
    const suitePath = suitePaths[index]!;
    progress.setSuite(
      index + 1,
      suitePaths.length,
      path.basename(suitePath, path.extname(suitePath)),
    );
    const item = await runSuite(suitePath, {
      progress,
      parserPath: args.parser,
      model: args.model,
    });
    results.push(item);
    progress.event(`suite ${item.completed ? 'completed' : 'incomplete'}`);
    if (!args.json) process.stdout.write(renderSuiteReport(item));
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(args.all ? results : results[0], null, 2)}\n`);
  } else if (args.all && results.length > 1) {
    process.stdout.write(`\n${renderAggregate(results)}`);
  }

  return results.every((item) => item.completed) ? 0 : 1;
}
