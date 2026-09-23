import { DEFAULT_IDLE_CHECK_INTERVAL_MS, parseIdleTimeoutEnv } from '../utils/idle-timeout.ts';
import type { DaemonActivitySnapshot } from './activity-registry.ts';

export const DAEMON_IDLE_TIMEOUT_ENV_KEY = 'MOBILEBUILDMCP_DAEMON_IDLE_TIMEOUT_MS';
export const DEFAULT_DAEMON_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_DAEMON_IDLE_CHECK_INTERVAL_MS = DEFAULT_IDLE_CHECK_INTERVAL_MS;

export function resolveDaemonIdleTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
  fallbackMs: number = DEFAULT_DAEMON_IDLE_TIMEOUT_MS,
): number {
  return parseIdleTimeoutEnv({
    env,
    envKey: DAEMON_IDLE_TIMEOUT_ENV_KEY,
    defaultTimeoutMs: fallbackMs,
  }).timeoutMs;
}

export function hasActiveRuntimeSessions(snapshot: DaemonActivitySnapshot): boolean {
  return snapshot.activeOperationCount > 0;
}
