import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  resetWorkspaceFilesystemLifecycleStateForTests,
  runWorkspaceFilesystemLifecycleSweep,
  type WorkspaceFilesystemLifecycleOptions,
} from '../workspace-filesystem-lifecycle.ts';
import {
  setSimulatorLaunchOsLogRecordActiveOverrideForTests,
  setSimulatorLaunchOsLogRegistryDirForTests,
  writeSimulatorLaunchOsLogRegistryRecord,
} from '../log-capture/simulator-launch-oslog-registry.ts';

interface PruneOptions {
  logDir?: string;
  markerPath?: string;
  lockDir?: string;
  now?: number;
  maxAgeMs?: number;
  maxFiles?: number;
  cooldownMs?: number;
  force?: boolean;
  activeGraceMs?: number;
  protectedLogPaths?: string[];
}

async function pruneLogDirectory(options: PruneOptions = {}): Promise<{
  logDir: string;
  scanned: number;
  deleted: number;
  skippedByCooldown: boolean;
  skippedByLock: boolean;
}> {
  const sweepOptions: WorkspaceFilesystemLifecycleOptions = {
    trigger: 'manual',
    logDir: options.logDir,
    markerPath: options.markerPath,
    lockDir: options.lockDir,
    now: options.now,
    maxAgeMs: options.maxAgeMs,
    maxFiles: options.maxFiles,
    cooldownMs: options.cooldownMs,
    force: options.force,
    minVisibleMs: options.activeGraceMs,
    protectedLogPaths: options.protectedLogPaths,
    lockPurpose: 'log-retention',
  };
  const result = await runWorkspaceFilesystemLifecycleSweep(sweepOptions);
  return {
    logDir: result.logDir,
    scanned: result.scanned,
    deleted: result.deleted,
    skippedByCooldown: result.skippedByCooldown,
    skippedByLock: result.skippedByLock,
  };
}

let logDir: string;

const MANAGED_LOG_TIMESTAMP = '2026-05-02T12-00-00-000Z';

function managedXcodebuildLogName(toolName: string, pid = 1234, suffix = 'abcdef12'): string {
  return `${toolName}_${MANAGED_LOG_TIMESTAMP}_pid${pid}_${suffix}.log`;
}

function managedSimulatorLogName(
  bundleId: string,
  ownerPid: number,
  suffix = 'abcdef12',
  helperPid?: number,
): string {
  const helperPart = helperPid === undefined ? '' : `helperpid${helperPid}_`;
  return `${bundleId}_${MANAGED_LOG_TIMESTAMP}_${helperPart}ownerpid${ownerPid}_${suffix}.log`;
}

function writeLogIn(targetLogDir: string, name: string, mtimeMs: number): string {
  const filePath = path.join(targetLogDir, name);
  writeFileSync(filePath, name);
  const date = new Date(mtimeMs);
  utimesSync(filePath, date, date);
  return filePath;
}

function writeLog(name: string, mtimeMs: number): string {
  return writeLogIn(logDir, name, mtimeMs);
}

describe('log retention', () => {
  beforeEach(() => {
    logDir = mkdtempSync(path.join(tmpdir(), 'mobilebuildmcp-log-retention-'));
    resetWorkspaceFilesystemLifecycleStateForTests();
  });

  afterEach(async () => {
    resetWorkspaceFilesystemLifecycleStateForTests();
    setSimulatorLaunchOsLogRecordActiveOverrideForTests(null);
    setSimulatorLaunchOsLogRegistryDirForTests(null);
    await rm(logDir, { recursive: true, force: true });
  });

  it('deletes logs older than the retention window and keeps recent logs', async () => {
    const now = Date.UTC(2026, 4, 2, 12);
    const oldLog = writeLog(
      managedXcodebuildLogName('old', 1234, 'abcdef12'),
      now - 4 * 24 * 60 * 60 * 1000,
    );
    const recentLog = writeLog(
      managedXcodebuildLogName('recent', 1234, 'abcdef13'),
      now - 2 * 24 * 60 * 60 * 1000,
    );

    const result = await pruneLogDirectory({ logDir, now, force: true });

    expect(result).toMatchObject({ scanned: 2, deleted: 1, skippedByCooldown: false });
    expect(existsSync(oldLog)).toBe(false);
    expect(existsSync(recentLog)).toBe(true);
  });

  it('enforces a max file cap after age pruning', async () => {
    const now = Date.UTC(2026, 4, 2, 12);
    const oldest = writeLog(managedXcodebuildLogName('oldest', 1234, 'abcdef12'), now - 30_000);
    const middle = writeLog(managedXcodebuildLogName('middle', 1234, 'abcdef13'), now - 20_000);
    const newest = writeLog(managedXcodebuildLogName('newest', 1234, 'abcdef14'), now - 10_000);

    const result = await pruneLogDirectory({
      logDir,
      now,
      maxAgeMs: 24 * 60 * 60 * 1000,
      maxFiles: 2,
      activeGraceMs: 0,
      force: true,
    });

    expect(result).toMatchObject({ scanned: 3, deleted: 1, skippedByCooldown: false });
    expect(existsSync(oldest)).toBe(false);
    expect(existsSync(middle)).toBe(true);
    expect(existsSync(newest)).toBe(true);
  });

  it('uses the cooldown marker to skip repeated sweeps', async () => {
    const now = Date.UTC(2026, 4, 2, 12);
    writeLog(managedXcodebuildLogName('old'), now - 4 * 24 * 60 * 60 * 1000);

    await pruneLogDirectory({ logDir, now, force: true });
    const result = await pruneLogDirectory({ logDir, now: now + 1000 });

    expect(result).toEqual({
      logDir,
      scanned: 0,
      deleted: 0,
      skippedByCooldown: true,
      skippedByLock: false,
    });
  });

  it('skips a recent ownerless retention lock', async () => {
    const now = Date.UTC(2026, 4, 2, 12);
    const lockDir = path.join(logDir, 'recent-ownerless.lock');
    mkdirSync(lockDir);
    const recentDate = new Date(now - 30 * 1000);
    utimesSync(lockDir, recentDate, recentDate);
    const oldLog = writeLog(managedXcodebuildLogName('old'), now - 4 * 24 * 60 * 60 * 1000);

    const result = await pruneLogDirectory({ logDir, lockDir, now, force: true });

    expect(result).toMatchObject({ scanned: 0, deleted: 0, skippedByLock: true });
    expect(existsSync(oldLog)).toBe(true);
  });

  it('recovers an expired ownerless retention lock', async () => {
    const now = Date.UTC(2026, 4, 2, 12);
    const lockDir = path.join(logDir, 'expired-ownerless.lock');
    mkdirSync(lockDir);
    const staleDate = new Date(now - 20 * 60 * 1000);
    utimesSync(lockDir, staleDate, staleDate);
    const oldLog = writeLog(managedXcodebuildLogName('old'), now - 4 * 24 * 60 * 60 * 1000);

    const result = await pruneLogDirectory({ logDir, lockDir, now, force: true });

    expect(result).toMatchObject({ scanned: 1, deleted: 1, skippedByLock: false });
    expect(existsSync(oldLog)).toBe(false);
  });

  it('recovers an expired retention lock owned by a crashed process', async () => {
    const now = Date.UTC(2026, 4, 2, 12);
    const lockDir = path.join(logDir, 'crashed-owner.lock');
    mkdirSync(lockDir);
    writeFileSync(
      path.join(lockDir, 'owner.json'),
      `${JSON.stringify({
        token: 'stale-token',
        pid: 999_999_999,
        purpose: 'log-retention',
        acquiredAtMs: now - 20 * 60 * 1000,
        expiresAtMs: now - 10 * 60 * 1000,
      })}\n`,
    );
    const oldLog = writeLog(managedXcodebuildLogName('old'), now - 4 * 24 * 60 * 60 * 1000);

    const result = await pruneLogDirectory({ logDir, lockDir, now, force: true });

    expect(result).toMatchObject({ scanned: 1, deleted: 1, skippedByLock: false });
    expect(existsSync(oldLog)).toBe(false);
  });

  it('skips when another process owns the retention lock', async () => {
    const now = Date.UTC(2026, 4, 2, 12);
    const lockDir = path.join(logDir, 'held.lock');
    mkdirSync(lockDir);
    writeLog(managedXcodebuildLogName('old'), now - 4 * 24 * 60 * 60 * 1000);

    const result = await pruneLogDirectory({ logDir, lockDir, now, force: true });

    expect(result).toEqual({
      logDir,
      scanned: 0,
      deleted: 0,
      skippedByCooldown: false,
      skippedByLock: true,
    });
  });

  it('does not treat creator pid names as active after the grace window', async () => {
    const now = Date.UTC(2026, 4, 2, 12);
    const oldLog = writeLog(
      managedXcodebuildLogName('build', process.pid),
      now - 4 * 24 * 60 * 60 * 1000,
    );

    const result = await pruneLogDirectory({ logDir, now, force: true });

    expect(result).toMatchObject({ scanned: 1, deleted: 1, skippedByLock: false });
    expect(existsSync(oldLog)).toBe(false);
  });

  it('does not delete logs protected by live helper pid names', async () => {
    const now = Date.UTC(2026, 4, 2, 12);
    const activeLog = writeLog(
      managedSimulatorLogName('app', 1234, 'abcdef12', process.pid),
      now - 4 * 24 * 60 * 60 * 1000,
    );

    const result = await pruneLogDirectory({ logDir, now, force: true });

    expect(result).toMatchObject({ scanned: 1, deleted: 0, skippedByLock: false });
    expect(existsSync(activeLog)).toBe(true);
  });

  it('keeps protected logs out of max-file cap pruning', async () => {
    const now = Date.UTC(2026, 4, 2, 12);
    const protectedLog = writeLog(
      managedSimulatorLogName('protected', 1234, 'abcdef12', process.pid),
      now - 30_000,
    );
    const oldDeletable = writeLog(
      managedXcodebuildLogName('old-deletable', 1234, 'abcdef13'),
      now - 20_000,
    );
    const newDeletable = writeLog(
      managedXcodebuildLogName('new-deletable', 1234, 'abcdef14'),
      now - 10_000,
    );

    const result = await pruneLogDirectory({
      logDir,
      now,
      maxAgeMs: 24 * 60 * 60 * 1000,
      maxFiles: 1,
      activeGraceMs: 0,
      force: true,
    });

    expect(result).toMatchObject({ scanned: 3, deleted: 1 });
    expect(existsSync(protectedLog)).toBe(true);
    expect(existsSync(oldDeletable)).toBe(false);
    expect(existsSync(newDeletable)).toBe(true);
  });

  it('allows only one same-directory concurrent sweep to acquire the retention lock', async () => {
    const now = Date.UTC(2026, 4, 2, 12);
    const lockDir = path.join(logDir, 'same-dir.lock');
    const markerPath = path.join(logDir, 'same-dir.marker');
    writeLog(managedXcodebuildLogName('old-a', 1234, 'abcdef12'), now - 4 * 24 * 60 * 60 * 1000);
    writeLog(managedXcodebuildLogName('old-b', 1234, 'abcdef13'), now - 4 * 24 * 60 * 60 * 1000);

    const results = await Promise.all([
      pruneLogDirectory({ logDir, lockDir, markerPath, now, force: true }),
      pruneLogDirectory({ logDir, lockDir, markerPath, now, force: true }),
    ]);

    expect(results.filter((result) => result.skippedByLock)).toHaveLength(1);
    expect(results.filter((result) => !result.skippedByLock)).toHaveLength(1);
    expect(results.reduce((count, result) => count + result.deleted, 0)).toBe(2);
  });

  it('allows concurrent sweeps for different log directories', async () => {
    const now = Date.UTC(2026, 4, 2, 12);
    const otherLogDir = mkdtempSync(path.join(tmpdir(), 'mobilebuildmcp-log-retention-other-'));
    try {
      const oldLog = writeLog(
        managedXcodebuildLogName('old-a', 1234, 'abcdef12'),
        now - 4 * 24 * 60 * 60 * 1000,
      );
      const otherOldLog = writeLogIn(
        otherLogDir,
        managedXcodebuildLogName('old-b', 1234, 'abcdef13'),
        now - 4 * 24 * 60 * 60 * 1000,
      );

      const [left, right] = await Promise.all([
        pruneLogDirectory({
          logDir,
          lockDir: path.join(logDir, 'lock'),
          markerPath: path.join(logDir, 'marker'),
          now,
          force: true,
        }),
        pruneLogDirectory({
          logDir: otherLogDir,
          lockDir: path.join(otherLogDir, 'lock'),
          markerPath: path.join(otherLogDir, 'marker'),
          now,
          force: true,
        }),
      ]);

      expect(left).toMatchObject({ deleted: 1, skippedByLock: false });
      expect(right).toMatchObject({ deleted: 1, skippedByLock: false });
      expect(existsSync(oldLog)).toBe(false);
      expect(existsSync(otherOldLog)).toBe(false);
    } finally {
      await rm(otherLogDir, { recursive: true, force: true });
    }
  });

  it('protects OSLog registry paths without mutating registry records', async () => {
    const now = Date.UTC(2026, 4, 2, 12);
    const registryDir = mkdtempSync(path.join(tmpdir(), 'mobilebuildmcp-oslog-protect-'));
    const protectedLog = writeLog(
      managedSimulatorLogName('io.sentry.app_oslog', process.pid, 'abcdef12', process.pid),
      now - 4 * 24 * 60 * 60 * 1000,
    );
    const malformedRecord = path.join(registryDir, 'malformed.json');
    const staleRecord = path.join(registryDir, 'stale.json');
    setSimulatorLaunchOsLogRegistryDirForTests(registryDir);
    setSimulatorLaunchOsLogRecordActiveOverrideForTests(async (record) => {
      return record.sessionId === 'protected';
    });

    try {
      writeFileSync(malformedRecord, '{not-json');
      await writeSimulatorLaunchOsLogRegistryRecord({
        sessionId: 'protected',
        owner: { instanceId: 'instance-1', pid: process.pid, workspaceKey: 'workspace-a' },
        simulatorUuid: 'sim-1',
        bundleId: 'io.sentry.app',
        helperPid: process.pid,
        logFilePath: protectedLog,
        startedAtMs: now,
        expectedCommandParts: ['node'],
      });
      writeFileSync(
        staleRecord,
        `${JSON.stringify({
          sessionId: 'stale',
          owner: { instanceId: 'instance-2', pid: process.pid, workspaceKey: 'workspace-a' },
          simulatorUuid: 'sim-1',
          bundleId: 'io.sentry.app',
          helperPid: 999999,
          logFilePath: path.join(
            logDir,
            managedSimulatorLogName('io.sentry.app_oslog', process.pid, 'abcdef13', 999999),
          ),
          startedAtMs: now,
          expectedCommandParts: ['not-active'],
        })}\n`,
      );

      const result = await pruneLogDirectory({ logDir, now, force: true });

      expect(result).toMatchObject({ scanned: 1, deleted: 0, skippedByLock: false });
      expect(existsSync(protectedLog)).toBe(true);
      expect(existsSync(malformedRecord)).toBe(true);
      expect(existsSync(staleRecord)).toBe(true);
    } finally {
      await rm(registryDir, { recursive: true, force: true });
      setSimulatorLaunchOsLogRegistryDirForTests(null);
      setSimulatorLaunchOsLogRecordActiveOverrideForTests(null);
    }
  });

  it('ignores non-log files and unknown log files', async () => {
    const now = Date.UTC(2026, 4, 2, 12);
    const note = path.join(logDir, 'note.txt');
    const unknownLog = writeLog('unknown.log', now - 4 * 24 * 60 * 60 * 1000);
    const managedLog = writeLog(
      managedXcodebuildLogName('old', 1234, 'abcdef12'),
      now - 4 * 24 * 60 * 60 * 1000,
    );
    writeFileSync(note, 'keep');

    const result = await pruneLogDirectory({ logDir, now, force: true });

    expect(result).toMatchObject({ scanned: 1, deleted: 1 });
    expect(existsSync(note)).toBe(true);
    expect(existsSync(unknownLog)).toBe(true);
    expect(existsSync(managedLog)).toBe(false);
  });
});
