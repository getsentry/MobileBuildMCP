import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { DaemonClient, DaemonVersionMismatchError } from './daemon-client.ts';
import {
  acquireDaemonRegistryMutationLock,
  cleanupWorkspaceDaemonFiles,
  findDaemonRegistryEntryBySocketPath,
  readDaemonRegistryEntry,
  type DaemonRegistryEntry,
} from '../daemon/daemon-registry.ts';
import { isPidAlive } from '../utils/process-liveness.ts';

/**
 * Default timeout for daemon startup in milliseconds.
 */
export const DEFAULT_DAEMON_STARTUP_TIMEOUT_MS = 5000;

/**
 * Default polling interval when waiting for daemon to be ready.
 */
export const DEFAULT_POLL_INTERVAL_MS = 100;

const FORCE_STOP_SIGNAL_TIMEOUT_MS = 1500;
const FORCE_STOP_POLL_INTERVAL_MS = 50;

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      return true;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, FORCE_STOP_POLL_INTERVAL_MS));
  }
  return !isPidAlive(pid);
}

function validateCurrentRegistryEntry(
  expectedEntry: DaemonRegistryEntry,
  currentEntry: DaemonRegistryEntry | null,
  socketPath: string,
): void {
  const matchesExpectedEntry =
    currentEntry !== null &&
    currentEntry.workspaceKey === expectedEntry.workspaceKey &&
    currentEntry.socketPath === expectedEntry.socketPath &&
    currentEntry.pid === expectedEntry.pid &&
    currentEntry.instanceId === expectedEntry.instanceId;

  if (!matchesExpectedEntry) {
    throw new Error(`Cannot force-stop daemon at ${socketPath}: daemon registry metadata changed`);
  }
}

function signalDaemonPid(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      return false;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to send ${signal} to daemon PID ${pid}: ${message}`);
  }
}

/**
 * Get the path to the daemon executable.
 */
export function getDaemonExecutablePath(): string {
  // In the built output, this file is build/cli/daemon-control.js and daemon is build/daemon.js.
  const currentFile = fileURLToPath(import.meta.url);
  const buildDir = dirname(currentFile);
  const candidateJs = resolve(buildDir, '..', 'daemon.js');
  if (existsSync(candidateJs)) {
    return candidateJs;
  }

  // Fallback for source/dev layouts.
  return resolve(buildDir, '..', 'daemon.ts');
}

/**
 * Force-stop a daemon that cannot be stopped gracefully (e.g. protocol version mismatch).
 * Uses registry ownership metadata to stop the process before unregistering daemon files.
 */
export async function forceStopDaemon(socketPath: string): Promise<void> {
  const entry = findDaemonRegistryEntryBySocketPath(socketPath);
  if (!entry) {
    throw new Error(
      `Cannot force-stop daemon at ${socketPath}: daemon registry metadata is missing`,
    );
  }

  const lock = acquireDaemonRegistryMutationLock(entry.workspaceKey);
  if (!lock) {
    throw new Error(`Unable to acquire daemon registry lock for ${entry.workspaceKey}`);
  }

  let termSent: boolean;
  try {
    validateCurrentRegistryEntry(entry, readDaemonRegistryEntry(entry.workspaceKey), socketPath);
    termSent = signalDaemonPid(entry.pid, 'SIGTERM');
  } finally {
    lock.release();
  }
  if (termSent && !(await waitForPidExit(entry.pid, FORCE_STOP_SIGNAL_TIMEOUT_MS))) {
    const killSent = signalDaemonPid(entry.pid, 'SIGKILL');
    if (killSent && !(await waitForPidExit(entry.pid, FORCE_STOP_SIGNAL_TIMEOUT_MS))) {
      throw new Error(`Daemon PID ${entry.pid} did not exit after SIGKILL`);
    }
  }

  cleanupWorkspaceDaemonFiles(entry.workspaceKey, {
    pid: entry.pid,
    socketPath,
    instanceId: entry.instanceId,
    allowLiveOwner: true,
  });
}

export interface StartDaemonBackgroundOptions {
  socketPath: string;
  workspaceRoot?: string;
  env?: Record<string, string>;
}

/**
 * Start the daemon in the background (detached mode).
 * Does not wait for the daemon to be ready.
 */
export function startDaemonBackground(opts: StartDaemonBackgroundOptions): void {
  const daemonPath = getDaemonExecutablePath();

  const child = spawn(process.execPath, [daemonPath], {
    detached: true,
    stdio: 'ignore',
    cwd: opts.workspaceRoot,
    env: {
      ...process.env,
      ...opts.env,
      MOBILEBUILDMCP_SOCKET: opts.socketPath,
      XCODEBUILDCLI_SOCKET: opts.socketPath,
    },
  });

  child.unref();
}

export interface WaitForDaemonReadyOptions {
  socketPath: string;
  timeoutMs: number;
  pollIntervalMs?: number;
}

/**
 * Wait for the daemon to be ready by polling status.
 * Throws if the daemon doesn't respond within the timeout.
 */
export async function waitForDaemonReady(opts: WaitForDaemonReadyOptions): Promise<void> {
  const client = new DaemonClient({
    socketPath: opts.socketPath,
    timeout: Math.min(opts.timeoutMs, 2000), // Short timeout for each status check
  });

  const pollInterval = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const startTime = Date.now();

  while (Date.now() - startTime < opts.timeoutMs) {
    try {
      // Use status() to confirm protocol handler is ready (not just connect)
      await client.status();
      return; // Success
    } catch {
      // Not ready yet, wait and retry
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
  }

  throw new Error(
    `Daemon failed to start within ${opts.timeoutMs}ms. ` +
      `Check if another daemon is running or if there are permission issues.`,
  );
}

export interface EnsureDaemonRunningOptions {
  socketPath: string;
  workspaceRoot?: string;
  startupTimeoutMs?: number;
  env?: Record<string, string>;
}

/**
 * Ensure the daemon is running, starting it if necessary.
 * Returns when the daemon is ready to accept requests.
 *
 * This is the main entry point for auto-start behavior.
 */
export async function ensureDaemonRunning(opts: EnsureDaemonRunningOptions): Promise<void> {
  const client = new DaemonClient({ socketPath: opts.socketPath });
  const timeoutMs = opts.startupTimeoutMs ?? DEFAULT_DAEMON_STARTUP_TIMEOUT_MS;

  const isRunning = await client.isRunning();
  if (isRunning) {
    try {
      await client.status();
      return;
    } catch (error) {
      if (error instanceof DaemonVersionMismatchError) {
        await forceStopDaemon(opts.socketPath);
      } else {
        return;
      }
    }
  }

  startDaemonBackground({
    socketPath: opts.socketPath,
    workspaceRoot: opts.workspaceRoot,
    env: opts.env,
  });

  await waitForDaemonReady({
    socketPath: opts.socketPath,
    timeoutMs,
  });
}

export interface StartDaemonForegroundOptions {
  socketPath: string;
  workspaceRoot?: string;
  env?: Record<string, string>;
}

/**
 * Start the daemon in the foreground (blocking).
 * Used for debugging. The function returns when the daemon exits.
 */
export function startDaemonForeground(opts: StartDaemonForegroundOptions): Promise<number> {
  const daemonPath = getDaemonExecutablePath();

  return new Promise<number>((resolve) => {
    const child = spawn(process.execPath, [daemonPath], {
      stdio: 'inherit',
      cwd: opts.workspaceRoot,
      env: {
        ...process.env,
        ...opts.env,
        MOBILEBUILDMCP_SOCKET: opts.socketPath,
        XCODEBUILDCLI_SOCKET: opts.socketPath,
      },
    });

    child.on('exit', (code) => {
      resolve(code ?? 0);
    });
  });
}
