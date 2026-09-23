import process from 'node:process';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getDefaultDebuggerManager } from '../utils/debugger/index.ts';
import { listActiveSimulatorLaunchOsLogSessions } from '../utils/log-capture/simulator-launch-oslog-sessions.ts';
import { terminateOwnedWorkspaceFilesystemArtifactsSync } from '../utils/workspace-filesystem-lifecycle.ts';
import { activeProcesses } from '../mcp/tools/swift-package/active-processes.ts';
import { getDaemonActivitySnapshot } from '../daemon/activity-registry.ts';
import { listActiveVideoCaptureSessionIds } from '../utils/video_capture.ts';
import { getDefaultCommandExecutor } from '../utils/execution/index.ts';
import type { CommandExecutor } from '../utils/execution/index.ts';
import { getWatchedPath, isWatcherRunning } from '../utils/xcode-state-watcher.ts';
import { suppressProcessStdioWrites } from '../utils/shutdown-state.ts';

export type McpStartupPhase =
  | 'initializing'
  | 'hydrating-sentry-config'
  | 'initializing-sentry'
  | 'creating-server'
  | 'bootstrapping-server'
  | 'starting-stdio-transport'
  | 'running'
  | 'deferred-initialization'
  | 'shutting-down'
  | 'stopped';

export type McpShutdownReason =
  | 'stdin-end'
  | 'stdin-close'
  | 'stdout-error'
  | 'stderr-error'
  | 'sigint'
  | 'sigterm'
  | 'startup-failure'
  | 'idle-timeout'
  | 'uncaught-exception'
  | 'unhandled-rejection';

export type McpLifecycleAnomaly =
  | 'peer-count-high'
  | 'peer-age-high'
  | 'high-rss'
  | 'long-lived-high-rss';

export interface McpPeerProcessSummary {
  pid: number;
  ageSeconds: number;
  rssKb: number;
}

export interface McpLifecycleSnapshot {
  pid: number;
  ppid: number;
  orphaned: boolean;
  phase: McpStartupPhase;
  shutdownReason: McpShutdownReason | null;
  uptimeMs: number;
  rssBytes: number;
  heapUsedBytes: number;
  watcherRunning: boolean;
  watchedPath: string | null;
  activeOperationCount: number;
  activeOperationByCategory: Record<string, number>;
  debuggerSessionCount: number;
  simulatorLaunchOsLogSessionCount: number;
  ownedSimulatorLaunchOsLogSessionCount: number;
  videoCaptureSessionCount: number;
  swiftPackageProcessCount: number;
  matchingMcpProcessCount: number | null;
  matchingMcpPeerSummary: McpPeerProcessSummary[];
  anomalies: McpLifecycleAnomaly[];
}

interface PeerProcessSample {
  count: number | null;
  peers: McpPeerProcessSummary[];
}

interface LifecycleStreamLike {
  once(event: string, listener: (...args: unknown[]) => void): this;
  removeListener(event: string, listener: (...args: unknown[]) => void): this;
}

interface LifecycleProcessLike {
  stdin: LifecycleStreamLike;
  stdout?: LifecycleStreamLike;
  stderr?: LifecycleStreamLike;
  once(event: string, listener: (...args: unknown[]) => void): this;
  removeListener(event: string, listener: (...args: unknown[]) => void): this;
}

interface McpLifecycleState {
  startedAtMs: number;
  phase: McpStartupPhase;
  shutdownReason: McpShutdownReason | null;
  shutdownPromise: Promise<void> | null;
  shutdownRequested: boolean;
  server: McpServer | null;
}

export interface McpLifecycleCoordinator {
  attachProcessHandlers(): void;
  detachProcessHandlers(): void;
  markPhase(phase: McpStartupPhase): void;
  registerServer(server: McpServer): void;
  isShutdownRequested(): boolean;
  getSnapshot(): Promise<McpLifecycleSnapshot>;
  shutdown(reason: McpShutdownReason, error?: unknown): Promise<void>;
}

export interface McpLifecycleCoordinatorOptions {
  commandExecutor?: CommandExecutor;
  processRef?: LifecycleProcessLike;
  onShutdown: (context: {
    reason: McpShutdownReason;
    error?: unknown;
    snapshot: McpLifecycleSnapshot;
    server: McpServer | null;
  }) => Promise<void>;
}

const HIGH_RSS_BYTES = 512 * 1024 * 1024;
const LONG_LIVED_HIGH_RSS_BYTES = 256 * 1024 * 1024;
const LONG_LIVED_UPTIME_MS = 5 * 60 * 1000;
const PEER_AGE_HIGH_SECONDS = 120;
const PEER_COUNT_HIGH_THRESHOLD = 2;

function parseElapsedSeconds(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const daySplit = trimmed.split('-');
  const timePart = daySplit.length === 2 ? daySplit[1] : daySplit[0];
  const dayCount = daySplit.length === 2 ? Number(daySplit[0]) : 0;
  const parts = timePart.split(':').map(Number);

  if (!Number.isFinite(dayCount) || parts.some((p) => !Number.isFinite(p))) {
    return null;
  }

  const daySeconds = dayCount * 86400;
  switch (parts.length) {
    case 1:
      return daySeconds + parts[0];
    case 2:
      return daySeconds + parts[0] * 60 + parts[1];
    case 3:
      return daySeconds + parts[0] * 3600 + parts[1] * 60 + parts[2];
    default:
      return null;
  }
}

export function classifyMcpLifecycleAnomalies(
  snapshot: Pick<
    McpLifecycleSnapshot,
    'uptimeMs' | 'rssBytes' | 'matchingMcpProcessCount' | 'matchingMcpPeerSummary'
  >,
): McpLifecycleAnomaly[] {
  const anomalies: McpLifecycleAnomaly[] = [];
  const peerCount = Math.max(0, (snapshot.matchingMcpProcessCount ?? 0) - 1);

  if (peerCount >= PEER_COUNT_HIGH_THRESHOLD) {
    anomalies.push('peer-count-high');
  }
  if (snapshot.matchingMcpPeerSummary.some((peer) => peer.ageSeconds >= PEER_AGE_HIGH_SECONDS)) {
    anomalies.push('peer-age-high');
  }
  if (snapshot.rssBytes >= HIGH_RSS_BYTES) {
    anomalies.push('high-rss');
  }
  if (snapshot.uptimeMs >= LONG_LIVED_UPTIME_MS && snapshot.rssBytes >= LONG_LIVED_HIGH_RSS_BYTES) {
    anomalies.push('long-lived-high-rss');
  }

  return anomalies.sort();
}

function isLikelyMcpProcessCommand(command: string): boolean {
  const normalized = command.toLowerCase();
  if (!/(^|\s)mcp(\s|$)/.test(normalized)) {
    return false;
  }
  if (/(^|\s)daemon(\s|$)/.test(normalized)) {
    return false;
  }
  return (
    normalized.includes('mobilebuildmcp') ||
    normalized.includes('build/cli.js') ||
    normalized.includes('/cli.js')
  );
}

function isBrokenPipeLikeError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const code = String((error as NodeJS.ErrnoException).code ?? '');
  return code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED';
}

async function sampleMcpPeerProcesses(
  commandExecutor: CommandExecutor,
  currentPid: number,
): Promise<PeerProcessSample> {
  try {
    const result = await commandExecutor(
      ['ps', '-axo', 'pid=,etime=,rss=,command='],
      'Sample MCP lifecycle peer processes',
      false,
    );
    if (!result.success) {
      return { count: null, peers: [] };
    }

    const matched = result.output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^(\d+)\s+(\S+)\s+(\d+)\s+(.+)$/);
        if (!match) {
          return null;
        }
        const [, pidRaw, elapsedRaw, rssRaw, command] = match;
        const ageSeconds = parseElapsedSeconds(elapsedRaw);
        return {
          pid: Number(pidRaw),
          ageSeconds,
          rssKb: Number(rssRaw),
          command,
        };
      })
      .filter(
        (entry): entry is { pid: number; ageSeconds: number; rssKb: number; command: string } => {
          return (
            entry !== null &&
            Number.isFinite(entry.pid) &&
            Number.isFinite(entry.ageSeconds) &&
            Number.isFinite(entry.rssKb) &&
            isLikelyMcpProcessCommand(entry.command)
          );
        },
      );

    const peers = matched
      .filter((entry) => entry.pid !== currentPid)
      .map(({ pid, ageSeconds, rssKb }) => ({ pid, ageSeconds, rssKb }))
      .sort((left, right) => right.ageSeconds - left.ageSeconds || right.rssKb - left.rssKb)
      .slice(0, 5);

    return {
      count: matched.length,
      peers,
    };
  } catch {
    return { count: null, peers: [] };
  }
}

const TRANSPORT_DISCONNECT_REASONS: ReadonlySet<McpShutdownReason> = new Set([
  'stdin-end',
  'stdin-close',
  'stdout-error',
  'stderr-error',
]);

export function isTransportDisconnectReason(reason: McpShutdownReason): boolean {
  return TRANSPORT_DISCONNECT_REASONS.has(reason);
}

export async function buildMcpLifecycleSnapshot(options: {
  phase: McpStartupPhase;
  shutdownReason: McpShutdownReason | null;
  startedAtMs: number;
  commandExecutor?: CommandExecutor;
}): Promise<McpLifecycleSnapshot> {
  const memoryUsage = process.memoryUsage();
  const activitySnapshot = getDaemonActivitySnapshot();
  const peerSample = await sampleMcpPeerProcesses(
    options.commandExecutor ?? getDefaultCommandExecutor(),
    process.pid,
  );
  const simulatorLaunchOsLogSessions = await listActiveSimulatorLaunchOsLogSessions();

  const snapshotWithoutAnomalies = {
    pid: process.pid,
    ppid: process.ppid,
    orphaned: process.ppid === 1,
    phase: options.phase,
    shutdownReason: options.shutdownReason,
    uptimeMs: Math.max(0, Date.now() - options.startedAtMs),
    rssBytes: memoryUsage.rss,
    heapUsedBytes: memoryUsage.heapUsed,
    watcherRunning: isWatcherRunning(),
    watchedPath: getWatchedPath(),
    activeOperationCount: activitySnapshot.activeOperationCount,
    activeOperationByCategory: activitySnapshot.byCategory,
    debuggerSessionCount: getDefaultDebuggerManager().listSessions().length,
    simulatorLaunchOsLogSessionCount: simulatorLaunchOsLogSessions.length,
    ownedSimulatorLaunchOsLogSessionCount: simulatorLaunchOsLogSessions.filter(
      (session) => session.ownedByCurrentProcess,
    ).length,
    videoCaptureSessionCount: listActiveVideoCaptureSessionIds().length,
    swiftPackageProcessCount: activeProcesses.size,
    matchingMcpProcessCount: peerSample.count,
    matchingMcpPeerSummary: peerSample.peers,
  };

  return {
    ...snapshotWithoutAnomalies,
    anomalies: classifyMcpLifecycleAnomalies(snapshotWithoutAnomalies),
  };
}

export function createMcpLifecycleCoordinator(
  options: McpLifecycleCoordinatorOptions,
): McpLifecycleCoordinator {
  const processRef = options.processRef ?? (process as LifecycleProcessLike);
  const state: McpLifecycleState = {
    startedAtMs: Date.now(),
    phase: 'initializing',
    shutdownReason: null,
    shutdownPromise: null,
    shutdownRequested: false,
    server: null,
  };

  const handleSigterm = (): void => {
    void coordinator.shutdown('sigterm');
  };
  const handleSigint = (): void => {
    void coordinator.shutdown('sigint');
  };
  const handleStdinEnd = (): void => {
    suppressProcessStdioWrites();
    void coordinator.shutdown('stdin-end');
  };
  const handleStdinClose = (): void => {
    suppressProcessStdioWrites();
    void coordinator.shutdown('stdin-close');
  };
  const handleStdoutError = (error: unknown): void => {
    if (!isBrokenPipeLikeError(error)) {
      return;
    }
    suppressProcessStdioWrites();
    void coordinator.shutdown('stdout-error', error);
  };
  const handleStderrError = (error: unknown): void => {
    if (!isBrokenPipeLikeError(error)) {
      return;
    }
    suppressProcessStdioWrites();
    void coordinator.shutdown('stderr-error', error);
  };
  const handleUncaughtException = (error: unknown): void => {
    void coordinator.shutdown('uncaught-exception', error);
  };
  const handleUnhandledRejection = (reason: unknown): void => {
    void coordinator.shutdown('unhandled-rejection', reason);
  };
  const handleExit = (): void => {
    terminateOwnedWorkspaceFilesystemArtifactsSync();
  };

  let handlersAttached = false;

  const coordinator: McpLifecycleCoordinator = {
    attachProcessHandlers(): void {
      if (handlersAttached) {
        return;
      }
      handlersAttached = true;

      processRef.once('SIGTERM', handleSigterm);
      processRef.once('SIGINT', handleSigint);
      processRef.stdin.once('end', handleStdinEnd);
      processRef.stdin.once('close', handleStdinClose);
      processRef.stdout?.once('error', handleStdoutError);
      processRef.stderr?.once('error', handleStderrError);
      processRef.once('uncaughtException', handleUncaughtException);
      processRef.once('unhandledRejection', handleUnhandledRejection);
      processRef.once('exit', handleExit);
    },

    detachProcessHandlers(): void {
      if (!handlersAttached) {
        return;
      }
      handlersAttached = false;

      processRef.removeListener('SIGTERM', handleSigterm);
      processRef.removeListener('SIGINT', handleSigint);
      processRef.stdin.removeListener('end', handleStdinEnd);
      processRef.stdin.removeListener('close', handleStdinClose);
      processRef.stdout?.removeListener('error', handleStdoutError);
      processRef.stderr?.removeListener('error', handleStderrError);
      processRef.removeListener('uncaughtException', handleUncaughtException);
      processRef.removeListener('unhandledRejection', handleUnhandledRejection);
      processRef.removeListener('exit', handleExit);
    },

    markPhase(phase: McpStartupPhase): void {
      state.phase = phase;
    },

    registerServer(server: McpServer): void {
      state.server = server;
    },

    isShutdownRequested(): boolean {
      return state.shutdownRequested;
    },

    async getSnapshot(): Promise<McpLifecycleSnapshot> {
      return buildMcpLifecycleSnapshot({
        phase: state.phase,
        shutdownReason: state.shutdownReason,
        startedAtMs: state.startedAtMs,
        commandExecutor: options.commandExecutor,
      });
    },

    async shutdown(reason: McpShutdownReason, error?: unknown): Promise<void> {
      if (state.shutdownPromise) {
        return state.shutdownPromise;
      }

      state.shutdownRequested = true;
      state.shutdownReason = reason;
      const phaseAtShutdown = state.phase;
      state.phase = 'shutting-down';

      state.shutdownPromise = (async (): Promise<void> => {
        const snapshot = await buildMcpLifecycleSnapshot({
          phase: phaseAtShutdown,
          shutdownReason: state.shutdownReason,
          startedAtMs: state.startedAtMs,
          commandExecutor: options.commandExecutor,
        });
        await options.onShutdown({
          reason,
          error,
          snapshot,
          server: state.server,
        });
        state.phase = 'stopped';
      })();

      return state.shutdownPromise;
    },
  };

  return coordinator;
}
