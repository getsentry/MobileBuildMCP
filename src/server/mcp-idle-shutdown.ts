import {
  getDaemonActivitySnapshot,
  type DaemonActivitySnapshot,
} from '../daemon/activity-registry.ts';
import {
  DEFAULT_IDLE_CHECK_INTERVAL_MS,
  parseIdleTimeoutEnv,
  type IdleTimeoutParseResult,
} from '../utils/idle-timeout.ts';

export const MCP_IDLE_TIMEOUT_ENV_KEY = 'MOBILEBUILDMCP_MCP_IDLE_TIMEOUT_MS';
export const DEFAULT_MCP_IDLE_TIMEOUT_MS = 0;
export const DEFAULT_MCP_IDLE_CHECK_INTERVAL_MS = DEFAULT_IDLE_CHECK_INTERVAL_MS;
export const MIN_MCP_IDLE_CHECK_INTERVAL_MS = 100;

export interface McpIdleShutdownController {
  start(): void;
  stop(): void;
  markRequestStarted(): void;
  markRequestCompleted(): void;
  getInFlightRequestCount(): number;
}

export function resolveMcpIdleTimeoutConfig(
  env: NodeJS.ProcessEnv = process.env,
  fallbackMs: number = DEFAULT_MCP_IDLE_TIMEOUT_MS,
): IdleTimeoutParseResult {
  return parseIdleTimeoutEnv({
    env,
    envKey: MCP_IDLE_TIMEOUT_ENV_KEY,
    defaultTimeoutMs: fallbackMs,
  });
}

export function resolveMcpIdleTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
  fallbackMs: number = DEFAULT_MCP_IDLE_TIMEOUT_MS,
): number {
  return resolveMcpIdleTimeoutConfig(env, fallbackMs).timeoutMs;
}

export function resolveMcpIdleCheckIntervalMs(
  timeoutMs: number,
  defaultIntervalMs: number = DEFAULT_MCP_IDLE_CHECK_INTERVAL_MS,
): number {
  if (timeoutMs <= 0) {
    return defaultIntervalMs;
  }

  return Math.min(Math.max(timeoutMs, MIN_MCP_IDLE_CHECK_INTERVAL_MS), defaultIntervalMs);
}

export function createMcpIdleShutdownController(options: {
  timeoutMs: number;
  intervalMs?: number;
  getActivitySnapshot?: () => DaemonActivitySnapshot;
  nowMs?: () => number;
  requestShutdown: () => void | Promise<void>;
  isShutdownRequested?: () => boolean;
  logIdleMessage?: (message: string) => void;
}): McpIdleShutdownController {
  const timeoutMs = options.timeoutMs;
  const intervalMs = options.intervalMs ?? DEFAULT_MCP_IDLE_CHECK_INTERVAL_MS;
  const getActivitySnapshot = options.getActivitySnapshot ?? getDaemonActivitySnapshot;
  const nowMs = options.nowMs ?? Date.now;
  let lastRequestCompletedAtMs = nowMs();
  let inFlightRequestCount = 0;
  let timer: NodeJS.Timeout | null = null;
  let shutdownTriggered = false;

  const checkIdle = (): void => {
    if (shutdownTriggered || options.isShutdownRequested?.()) {
      return;
    }

    const idleForMs = nowMs() - lastRequestCompletedAtMs;
    if (idleForMs < timeoutMs) {
      return;
    }

    if (inFlightRequestCount > 0) {
      return;
    }

    if (getActivitySnapshot().activeOperationCount > 0) {
      return;
    }

    shutdownTriggered = true;
    options.logIdleMessage?.(
      `MCP idle timeout reached (${idleForMs}ms >= ${timeoutMs}ms); shutting down`,
    );
    void Promise.resolve(options.requestShutdown()).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      options.logIdleMessage?.(`MCP idle shutdown request failed: ${message}`);
    });
  };

  return {
    start(): void {
      if (timeoutMs <= 0 || timer) {
        return;
      }

      lastRequestCompletedAtMs = nowMs();
      timer = setInterval(checkIdle, intervalMs);
      timer.unref?.();
    },

    stop(): void {
      if (!timer) {
        return;
      }
      clearInterval(timer);
      timer = null;
    },

    markRequestStarted(): void {
      inFlightRequestCount += 1;
    },

    markRequestCompleted(): void {
      inFlightRequestCount = Math.max(0, inFlightRequestCount - 1);
      lastRequestCompletedAtMs = nowMs();
    },

    getInFlightRequestCount(): number {
      return inFlightRequestCount;
    },
  };
}
