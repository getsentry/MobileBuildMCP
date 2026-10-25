/**
 * Video capture utility for simulator recordings using AXe.
 *
 * Manages long-running AXe "record-video" processes keyed by simulator UUID.
 * It aggregates stdout/stderr to parse the generated MP4 path on stop.
 */

import { open } from 'node:fs/promises';
import type { ChildProcess } from 'child_process';
import { log } from './logging/index.ts';
import { getAxePath, getBundledAxeEnvironment } from './axe-helpers.ts';
import type { CommandExecutor } from './execution/index.ts';
import { acquireDaemonActivity } from '../daemon/activity-registry.ts';

type Session = {
  process: unknown;
  sessionId: string;
  startedAt: number;
  buffer: string;
  ended: boolean;
  forcedKill?: boolean;
  releaseActivity?: () => void;
};

const sessions = new Map<string, Session>();
let signalHandlersAttached = false;

export interface AxeHelpers {
  getAxePath: () => string | null;
  getBundledAxeEnvironment: () => Record<string, string>;
}

export type StartVideoCaptureResult =
  | { started: true; sessionId: string; warning?: string }
  | { started: false; error: string };

export type StopVideoCaptureResult =
  | {
      stopped: true;
      sessionId: string;
      stdout?: string;
      parsedPath?: string;
      forcedKill?: boolean;
      exitCode?: number | null;
      signal?: string | null;
    }
  | { stopped: false; error: string };

function createTimeoutPromise(timeoutMs: number): Promise<'timed_out'> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timed_out'), timeoutMs);
    timer.unref?.();
  });
}

async function waitForChildToStop(session: Session, timeoutMs: number): Promise<void> {
  const child = session.process as ChildProcess | undefined;
  if (!child) {
    return;
  }

  const alreadyEnded = session.ended || child.exitCode !== null;
  const hasSignal = (child as unknown as { signalCode?: string | null }).signalCode != null;
  if (alreadyEnded || hasSignal) {
    session.ended = true;
    return;
  }

  const closePromise = new Promise<'closed'>((resolve) => {
    let resolved = false;
    const finish = (): void => {
      if (!resolved) {
        resolved = true;
        session.ended = true;
        resolve('closed');
      }
    };

    child.once('close', finish);
    child.once('exit', finish);
  }).catch(() => 'closed' as const);

  const outcome = await Promise.race([closePromise, createTimeoutPromise(timeoutMs)]);
  if (outcome === 'timed_out') {
    session.forcedKill = true;
    try {
      child.kill('SIGKILL');
    } catch {
      // ignore
    }
  }
}

type StopSessionSuccess = {
  sessionId: string;
  stdout: string;
  parsedPath?: string;
  forcedKill: boolean;
  exitCode: number | null;
  signal: string | null;
};
type StopSessionError = { error: string };
type StopSessionResult = StopSessionSuccess | StopSessionError;

async function stopSession(
  simulatorUuid: string,
  options: { timeoutMs?: number } = {},
): Promise<StopSessionResult> {
  const session = sessions.get(simulatorUuid);
  if (!session) {
    return { error: 'No active video recording session for this simulator' };
  }

  sessions.delete(simulatorUuid);
  const child = session.process as ChildProcess | undefined;

  try {
    child?.kill?.('SIGINT');
  } catch {
    try {
      child?.kill?.();
    } catch {
      // ignore
    }
  }

  await waitForChildToStop(session, options.timeoutMs ?? 5000);

  const combinedOutput = session.buffer;
  const parsedPath = parseLastAbsoluteMp4Path(combinedOutput) ?? undefined;

  session.releaseActivity?.();

  return {
    sessionId: session.sessionId,
    stdout: combinedOutput,
    parsedPath,
    forcedKill: session.forcedKill === true,
    exitCode: child?.exitCode ?? null,
    signal: child?.signalCode ?? null,
  };
}

function ensureSignalHandlersAttached(): void {
  if (signalHandlersAttached) return;
  signalHandlersAttached = true;

  const stopAll = (): void => {
    for (const simulatorUuid of sessions.keys()) {
      void stopSession(simulatorUuid, { timeoutMs: 250 });
    }
  };

  try {
    process.on('SIGINT', stopAll);
    process.on('SIGTERM', stopAll);
    process.on('exit', stopAll);
  } catch {
    // Non-Node environments may not support process signals; ignore
  }
}

function parseLastAbsoluteMp4Path(buffer: string | undefined): string | null {
  if (!buffer) return null;
  const matches = [...buffer.matchAll(/(\s|^)(\/[^\s'"]+\.mp4)\b/gi)];
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1];
  return last?.[2] ?? null;
}

function createSessionId(simulatorUuid: string): string {
  return `${simulatorUuid}:${Date.now()}`;
}

export function listActiveVideoCaptureSessionIds(): string[] {
  return Array.from(sessions.keys()).sort();
}

export async function startSimulatorVideoCapture(
  params: { simulatorUuid: string; fps?: number },
  executor: CommandExecutor,
  axeHelpers?: AxeHelpers,
): Promise<StartVideoCaptureResult> {
  const simulatorUuid = params.simulatorUuid;
  if (!simulatorUuid) {
    return { started: false, error: 'simulatorUuid is required' };
  }

  if (sessions.has(simulatorUuid)) {
    return {
      started: false,
      error: 'A video recording session is already active for this simulator. Stop it first.',
    };
  }

  const helpers = axeHelpers ?? {
    getAxePath,
    getBundledAxeEnvironment,
  };

  const axeBinary = helpers.getAxePath();
  if (!axeBinary) {
    return { started: false, error: 'Bundled AXe binary not found' };
  }

  const fps = Number.isFinite(params.fps as number) ? Number(params.fps) : 30;
  const command = [axeBinary, 'record-video', '--udid', simulatorUuid, '--fps', String(fps)];
  const env = helpers.getBundledAxeEnvironment?.() ?? {};

  log('info', `Starting AXe video recording for simulator ${simulatorUuid} at ${fps} fps`);

  const result = await executor(command, 'Start Simulator Video Capture', false, { env }, true);

  if (!result.success || !result.process) {
    return {
      started: false,
      error: result.error ?? 'Failed to start video capture process',
    };
  }

  const child = result.process as ChildProcess;
  const session: Session = {
    process: child,
    sessionId: createSessionId(simulatorUuid),
    startedAt: Date.now(),
    buffer: '',
    ended: false,
    releaseActivity: acquireDaemonActivity('video.capture'),
  };

  try {
    child.stdout?.on('data', (d: unknown) => {
      session.buffer += String(d ?? '');
    });
    child.stderr?.on('data', (d: unknown) => {
      session.buffer += String(d ?? '');
    });
  } catch {
    // ignore stream listener setup failures
  }

  try {
    child.once?.('exit', () => {
      session.ended = true;
    });
    child.once?.('close', () => {
      session.ended = true;
    });
  } catch {
    // ignore
  }

  sessions.set(simulatorUuid, session);
  ensureSignalHandlersAttached();

  return {
    started: true,
    sessionId: session.sessionId,
    warning: fps !== (params.fps ?? 30) ? `FPS coerced to ${fps}` : undefined,
  };
}

export async function stopSimulatorVideoCapture(
  params: { simulatorUuid: string },
  executor: CommandExecutor,
): Promise<StopVideoCaptureResult> {
  void executor;

  const simulatorUuid = params.simulatorUuid;
  if (!simulatorUuid) {
    return { stopped: false, error: 'simulatorUuid is required' };
  }

  const result = await stopSession(simulatorUuid, { timeoutMs: 5000 });
  if ('error' in result) {
    return { stopped: false, error: result.error };
  }

  log(
    'info',
    `Stopped AXe video recording for simulator ${simulatorUuid}. ${result.parsedPath ? `Detected file: ${result.parsedPath}` : 'No file detected in output.'}`,
  );

  return {
    stopped: true,
    sessionId: result.sessionId,
    stdout: result.stdout,
    parsedPath: result.parsedPath,
    forcedKill: result.forcedKill,
    exitCode: result.exitCode,
    signal: result.signal,
  };
}

export type Mp4FinalizationResult = { finalized: true } | { finalized: false; reason: string };

/**
 * Walks the top-level MP4 boxes and requires a `moov` box with every declared box
 * fully present, so a recording cut off before the writer finalized it is rejected.
 */
export async function checkMp4Finalized(path: string): Promise<Mp4FinalizationResult> {
  const handle = await open(path, 'r');
  try {
    const size = (await handle.stat()).size;
    const header = Buffer.alloc(16);
    let offset = 0;
    let sawMoov = false;
    let sawFtyp = false;

    while (offset < size) {
      const { bytesRead } = await handle.read(header, 0, 16, offset);
      if (bytesRead < 8) {
        return { finalized: false, reason: `truncated box header at byte ${offset}` };
      }
      let boxSize = header.readUInt32BE(0);
      let headerSize = 8;
      const type = header.toString('latin1', 4, 8);
      if (boxSize === 1) {
        if (bytesRead < 16) {
          return { finalized: false, reason: `truncated box header at byte ${offset}` };
        }
        boxSize = Number(header.readBigUInt64BE(8));
        headerSize = 16;
      } else if (boxSize === 0) {
        boxSize = size - offset;
      }
      if (boxSize < headerSize || offset + boxSize > size) {
        return {
          finalized: false,
          reason: `'${type}' box at byte ${offset} declares ${boxSize} bytes but the file ends at ${size}`,
        };
      }
      if (type === 'ftyp') sawFtyp = true;
      if (type === 'moov') sawMoov = true;
      offset += boxSize;
    }

    if (!sawFtyp) return { finalized: false, reason: 'no ftyp box found' };
    if (!sawMoov) return { finalized: false, reason: 'no moov box found' };
    return { finalized: true };
  } finally {
    await handle.close();
  }
}

export async function stopAllVideoCaptureSessions(timeoutMs = 1000): Promise<{
  stoppedSessionCount: number;
  errorCount: number;
  errors: string[];
}> {
  const simulatorIds = Array.from(sessions.keys());
  const errors: string[] = [];

  for (const simulatorUuid of simulatorIds) {
    const result = await stopSession(simulatorUuid, { timeoutMs });
    if ('error' in result) {
      errors.push(`${simulatorUuid}: ${result.error}`);
    }
  }

  return {
    stoppedSessionCount: simulatorIds.length - errors.length,
    errorCount: errors.length,
    errors,
  };
}
