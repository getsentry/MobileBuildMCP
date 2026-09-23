import { performance } from 'node:perf_hooks';
import { log } from '../utils/logger.ts';

const PROFILE_ENV = 'MOBILEBUILDMCP_STARTUP_PROFILE';

function isEnabled(): boolean {
  const value = process.env[PROFILE_ENV]?.toLowerCase();
  return value === '1' || value === 'true';
}

export interface StartupProfiler {
  readonly enabled: boolean;
  readonly startedAtMs: number;
  mark(stage: string, startedAtMs: number): void;
}

export function createStartupProfiler(scope: string): StartupProfiler {
  const enabled = isEnabled();
  const startedAtMs = performance.now();

  return {
    enabled,
    startedAtMs,
    mark(stage: string, stageStartedAtMs: number): void {
      if (!enabled) return;
      const elapsedMs = performance.now() - stageStartedAtMs;
      const totalMs = performance.now() - startedAtMs;
      log(
        'info',
        `[startup-profile] scope=${scope} stage=${stage} ms=${elapsedMs.toFixed(1)} totalMs=${totalMs.toFixed(1)}`,
      );
    },
  };
}

export function getStartupProfileNowMs(): number {
  return performance.now();
}
