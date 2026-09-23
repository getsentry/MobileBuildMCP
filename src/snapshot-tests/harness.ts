import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { formatStructuredEnvelopeFixture } from './json-normalize.ts';
import { normalizeSnapshotOutput } from './normalize.ts';
import type {
  SnapshotInvokeOptions,
  SnapshotResult,
  SnapshotResultOutcome,
  WorkflowSnapshotHarness,
} from './contracts.ts';
import { resolveSnapshotToolManifest } from './tool-manifest-resolver.ts';

const CLI_PATH = path.resolve(process.cwd(), 'build/cli.js');
const SNAPSHOT_COMMAND_TIMEOUT_MS = 120_000;
// Snapshot suites remain serial to avoid contention for Apple tooling and connected hardware.
// Correctness must not depend on execution order; each test owns its mutable setup and cleanup.
export type SnapshotHarness = WorkflowSnapshotHarness;
export type { SnapshotResult };

export interface CreateSnapshotHarnessOptions {
  cwd?: string;
  env?: Record<string, string>;
  globalArgs?: string[];
}

interface PreparedSnapshotHarnessOptions {
  invocationOptions: CreateSnapshotHarnessOptions;
  ownedSocketDir?: string;
}

function hasExplicitSocket(globalArgs: string[]): boolean {
  return globalArgs.some((arg) => arg === '--socket' || arg.startsWith('--socket='));
}

function prepareSnapshotHarnessOptions(
  options: CreateSnapshotHarnessOptions,
): PreparedSnapshotHarnessOptions {
  const globalArgs = options.globalArgs ?? [];
  if (hasExplicitSocket(globalArgs)) {
    return { invocationOptions: options };
  }

  const ownedSocketDir = mkdtempSync(path.join(tmpdir(), 'mobilebuildmcp-snapshot-daemon-'));
  return {
    invocationOptions: {
      ...options,
      globalArgs: ['--socket', path.join(ownedSocketDir, 'daemon.sock'), ...globalArgs],
    },
    ownedSocketDir,
  };
}

function cleanupSnapshotHarness(options: PreparedSnapshotHarnessOptions): void {
  if (!options.ownedSocketDir) {
    return;
  }

  try {
    const result = spawnSync(
      'node',
      [CLI_PATH, ...(options.invocationOptions.globalArgs ?? []), 'daemon', 'stop'],
      {
        encoding: 'utf8',
        timeout: SNAPSHOT_COMMAND_TIMEOUT_MS,
        cwd: options.invocationOptions.cwd ?? process.cwd(),
        env: getSnapshotHarnessEnv(options.invocationOptions.env),
      },
    );
    if (result.error) {
      throw new Error(`Failed to stop snapshot daemon: ${result.error.message}`);
    }
    if (result.signal || result.status === null) {
      throw new Error('Snapshot daemon stop process did not exit normally.');
    }
    if (result.status !== 0) {
      const stderr = readProcessOutput(result.stderr).trim();
      throw new Error(
        `Failed to stop snapshot daemon: ${stderr || `exit status ${result.status}`}`,
      );
    }
  } finally {
    rmSync(options.ownedSocketDir, { recursive: true, force: true });
  }
}

export function getSnapshotHarnessEnv(
  overrides: Record<string, string> = {},
): Record<string, string> {
  const { VITEST: _vitest, NODE_ENV: _nodeEnv, ...rest } = process.env;
  const env = Object.fromEntries(
    Object.entries(rest).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  return { ...env, ...overrides };
}

function runSnapshotCli(
  workflow: string,
  cliToolName: string,
  args: Record<string, unknown>,
  output: 'text' | 'json' = 'text',
  options: CreateSnapshotHarnessOptions = {},
  invokeOptions: SnapshotInvokeOptions = {},
): ReturnType<typeof spawnSync> {
  const commandArgs = [
    CLI_PATH,
    ...(options.globalArgs ?? []),
    workflow,
    cliToolName,
    '--json',
    JSON.stringify(args),
  ];
  if (output !== 'text') {
    commandArgs.push('--output', output);
  }
  if (invokeOptions.verbose === true) {
    commandArgs.push('--verbose');
  }

  return spawnSync('node', commandArgs, {
    encoding: 'utf8',
    timeout: SNAPSHOT_COMMAND_TIMEOUT_MS,
    cwd: options.cwd ?? process.cwd(),
    env: getSnapshotHarnessEnv(options.env),
  });
}

function readProcessOutput(output: string | Buffer | null | undefined): string {
  return typeof output === 'string' ? output : (output?.toString('utf8') ?? '');
}

export function assertCliSnapshotProcessResult(
  result: Pick<ReturnType<typeof spawnSync>, 'error' | 'signal' | 'status' | 'stderr'>,
  label: string,
): void {
  if (result.error) {
    throw new Error(`CLI process failed for ${label}: ${result.error.message}`);
  }

  if (result.signal) {
    throw new Error(`CLI process for ${label} was terminated by signal ${result.signal}.`);
  }

  if (result.status === null) {
    throw new Error(
      `CLI process exit status was null for ${label}; the process may have timed out or been killed by a signal.`,
    );
  }

  const stderr = readProcessOutput(result.stderr).trim();
  if (stderr.length > 0) {
    throw new Error(`CLI process emitted unexpected stderr for ${label}:\n${stderr}`);
  }
}

function parseStructuredEnvelope(
  stdout: string,
  label: string,
): NonNullable<SnapshotResult['structuredEnvelope']> {
  try {
    return JSON.parse(stdout) as NonNullable<SnapshotResult['structuredEnvelope']>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse CLI JSON output for ${label}: ${message}`);
  }
}

export function resolveCliJsonSnapshotErrorState(
  status: number | null,
  envelope: NonNullable<SnapshotResult['structuredEnvelope']>,
  label: string,
): boolean {
  if (status === null) {
    throw new Error(
      `CLI process exit status was null for ${label}; the process may have timed out or been killed by a signal.`,
    );
  }

  const processDidError = status !== 0;
  if (processDidError !== envelope.didError) {
    throw new Error(
      `${label}: CLI process exit status (${status ?? 'null'}) disagrees with envelope.didError (${envelope.didError}).`,
    );
  }

  return processDidError;
}

export function resolveCliJsonSnapshotOutcome(
  status: number | null,
  envelope: NonNullable<SnapshotResult['structuredEnvelope']>,
  label: string,
): SnapshotResultOutcome {
  return resolveCliJsonSnapshotErrorState(status, envelope, label) ? 'domain-error' : 'success';
}

export async function createSnapshotHarness(
  options: CreateSnapshotHarnessOptions = {},
): Promise<SnapshotHarness> {
  const preparedOptions = prepareSnapshotHarnessOptions(options);

  async function invoke(
    workflow: string,
    cliToolName: string,
    args: Record<string, unknown>,
    invokeOptions: SnapshotInvokeOptions = {},
  ): Promise<SnapshotResult> {
    const resolved = resolveSnapshotToolManifest(workflow, cliToolName);

    if (!resolved) {
      throw new Error(`Tool '${cliToolName}' not found in workflow '${workflow}'`);
    }

    if (resolved.isMcpOnly) {
      throw new Error(`Tool '${cliToolName}' in workflow '${workflow}' is not CLI-available`);
    }

    const label = `${workflow}/${cliToolName}`;
    const result = runSnapshotCli(
      workflow,
      cliToolName,
      args,
      'text',
      preparedOptions.invocationOptions,
      invokeOptions,
    );
    assertCliSnapshotProcessResult(result, label);
    const stdout = readProcessOutput(result.stdout);

    return {
      text: normalizeSnapshotOutput(stdout),
      rawText: stdout,
      isError: result.status !== 0,
      outcome: result.status === 0 ? 'success' : 'domain-error',
    };
  }

  async function cleanup(): Promise<void> {
    cleanupSnapshotHarness(preparedOptions);
  }

  return { invoke, cleanup };
}

export async function createCliJsonSnapshotHarness(
  options: CreateSnapshotHarnessOptions = {},
): Promise<SnapshotHarness> {
  const preparedOptions = prepareSnapshotHarnessOptions(options);

  async function invoke(
    workflow: string,
    cliToolName: string,
    args: Record<string, unknown>,
    invokeOptions: SnapshotInvokeOptions = {},
  ): Promise<SnapshotResult> {
    const resolved = resolveSnapshotToolManifest(workflow, cliToolName);

    if (!resolved) {
      throw new Error(`Tool '${cliToolName}' not found in workflow '${workflow}'`);
    }

    if (resolved.isMcpOnly) {
      throw new Error(`Tool '${cliToolName}' in workflow '${workflow}' is not CLI-available`);
    }

    const label = `${workflow}/${cliToolName}`;
    const result = runSnapshotCli(
      workflow,
      cliToolName,
      args,
      'json',
      preparedOptions.invocationOptions,
      invokeOptions,
    );
    assertCliSnapshotProcessResult(result, label);
    const stdout = readProcessOutput(result.stdout);
    const envelope = parseStructuredEnvelope(stdout, label);

    const outcome = resolveCliJsonSnapshotOutcome(result.status, envelope, label);
    return {
      text: formatStructuredEnvelopeFixture(envelope),
      rawText: stdout,
      isError: outcome !== 'success',
      outcome,
      structuredEnvelope: envelope,
    };
  }

  async function cleanup(): Promise<void> {
    cleanupSnapshotHarness(preparedOptions);
  }

  return { invoke, cleanup };
}

type SimctlRuntime = {
  identifier?: unknown;
  version?: unknown;
  isAvailable?: unknown;
};

type SimctlRuntimes = {
  runtimes: SimctlRuntime[];
};

function parseIosRuntimeVersion(runtime: SimctlRuntime): number[] | null {
  if (typeof runtime.identifier !== 'string') {
    return null;
  }

  const identifierMatch = runtime.identifier.match(/\.SimRuntime\.iOS-(\d+(?:-\d+)*)$/);
  if (!identifierMatch) {
    return null;
  }

  return identifierMatch[1].split('-').map(Number);
}

function compareRuntimeVersions(left: number[], right: number[]): number {
  const maxLength = Math.max(left.length, right.length);
  for (let index = 0; index < maxLength; index += 1) {
    const leftPart = left[index] ?? 0;
    const rightPart = right[index] ?? 0;
    if (leftPart !== rightPart) {
      return leftPart - rightPart;
    }
  }
  return 0;
}

export function selectLatestAvailableIosRuntimeIdentifier(data: SimctlRuntimes): string {
  const latest = data.runtimes
    .filter(
      (runtime): runtime is SimctlRuntime & { identifier: string } =>
        typeof runtime.identifier === 'string' && runtime.isAvailable !== false,
    )
    .map((runtime) => ({ runtime, version: parseIosRuntimeVersion(runtime) }))
    .filter(
      (item): item is { runtime: SimctlRuntime & { identifier: string }; version: number[] } =>
        item.version !== null,
    )
    .sort((left, right) => compareRuntimeVersions(right.version, left.version))[0];

  if (!latest) {
    throw new Error('No available iOS simulator runtime found');
  }

  return latest.runtime.identifier;
}
