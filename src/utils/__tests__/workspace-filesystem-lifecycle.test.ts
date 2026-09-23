import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  cleanupOwnedWorkspaceFilesystemArtifacts,
  getManagedResultBundleOwnerPid,
  getXcodeIdeCallToolTransientOwnerPid,
  isStaleXcodeIdeCallToolTransientDirectoryName,
  isMobileBuildMCPManagedLogName,
  isMobileBuildMCPManagedResultBundleName,
  resetWorkspaceFilesystemLifecycleStateForTests,
  runWorkspaceFilesystemLifecycleSweep,
  scheduleWorkspaceFilesystemLifecycleSweep,
} from '../workspace-filesystem-lifecycle.ts';
import {
  getWorkspaceFilesystemLayout,
  setMobileBuildMCPAppDirOverrideForTests,
} from '../log-paths.ts';
import { getResultBundleCompletionMarkerPath } from '../result-bundle-path.ts';
import { getTestProductsCompletionMarkerPath } from '../test-products-path.ts';
import { TEST_PRODUCTS_MAX_COUNT } from '../test-products-lifecycle.ts';
import { writeDaemonRegistryEntry } from '../../daemon/daemon-registry.ts';
import { setRuntimeInstanceForTests } from '../runtime-instance.ts';
import {
  clearAllSimulatorLaunchOsLogSessionsForTests,
  registerSimulatorLaunchOsLogSession,
} from '../log-capture/simulator-launch-oslog-sessions.ts';
import { setSimulatorLaunchOsLogRecordActiveOverrideForTests } from '../log-capture/simulator-launch-oslog-registry.ts';

let appDir: string;
const DEAD_OWNER_PID = 999_999_999;

function writeFileWithMtime(filePath: string, content: string, mtimeMs: number): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  const mtime = new Date(mtimeMs);
  utimesSync(filePath, mtime, mtime);
}

function managedXcodebuildLogName(name = 'build_sim'): string {
  return `${name}_2026-05-02T12-00-00-000Z_pid123_abcdef12.log`;
}

function managedResultBundleName(name = 'test', pid = DEAD_OWNER_PID): string {
  return `${name}_2026-05-02T12-00-00-000Z_pid${pid}_abcdef12.xcresult`;
}

function writeResultBundleWithMtime(bundlePath: string, mtimeMs: number): void {
  mkdirSync(bundlePath, { recursive: true });
  writeFileSync(path.join(bundlePath, 'Info.plist'), 'stub');
  const mtime = new Date(mtimeMs);
  utimesSync(bundlePath, mtime, mtime);
}

function managedTestProductsName(name: string): string {
  return `${name}_2026-05-02T12-00-00-000Z_pid${DEAD_OWNER_PID}_abcdef12.xctestproducts`;
}

function writeTestProductsWithMtime(productsPath: string, mtimeMs: number): void {
  mkdirSync(productsPath, { recursive: true });
  writeFileSync(path.join(productsPath, 'Info.plist'), 'stub');
  const mtime = new Date(mtimeMs);
  utimesSync(productsPath, mtime, mtime);
}

function createTrackedChild(pid: number, onKill: () => void): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.defineProperty(child, 'pid', { value: pid, configurable: true });
  Object.defineProperty(child, 'exitCode', { value: null, writable: true, configurable: true });
  child.kill = vi.fn(() => {
    onKill();
    return true;
  }) as ChildProcess['kill'];
  return child;
}

describe('workspace filesystem lifecycle', () => {
  beforeEach(() => {
    appDir = mkdtempSync(path.join(tmpdir(), 'mobilebuildmcp-filesystem-lifecycle-'));
    setMobileBuildMCPAppDirOverrideForTests(appDir);
    setRuntimeInstanceForTests({
      instanceId: 'filesystem-lifecycle-test',
      pid: process.pid,
      workspaceKey: 'workspace-a',
    });
    resetWorkspaceFilesystemLifecycleStateForTests();
  });

  afterEach(async () => {
    resetWorkspaceFilesystemLifecycleStateForTests();
    setSimulatorLaunchOsLogRecordActiveOverrideForTests(null);
    await clearAllSimulatorLaunchOsLogSessionsForTests();
    setRuntimeInstanceForTests(null);
    setMobileBuildMCPAppDirOverrideForTests(null);
    await rm(appDir, { recursive: true, force: true });
  });

  it('exposes cleanup classification helpers without broadening managed artifact matches', () => {
    const logName = managedXcodebuildLogName();
    const resultBundleName = managedResultBundleName('test', 123);

    expect(isMobileBuildMCPManagedLogName(logName)).toBe(true);
    expect(isMobileBuildMCPManagedLogName('manual.log')).toBe(false);
    expect(isMobileBuildMCPManagedResultBundleName(resultBundleName)).toBe(true);
    expect(isMobileBuildMCPManagedResultBundleName('manual.xcresult')).toBe(false);
    expect(getManagedResultBundleOwnerPid(resultBundleName)).toBe(123);
    expect(getXcodeIdeCallToolTransientOwnerPid('ownerpid999999999_stale')).toBe(999999999);
    expect(isStaleXcodeIdeCallToolTransientDirectoryName('ownerpid999999999_stale')).toBe(true);
    expect(isStaleXcodeIdeCallToolTransientDirectoryName(`ownerpid${process.pid}_live`)).toBe(
      false,
    );
  });

  it('prunes only known workspace log files and never scans DerivedData', async () => {
    const now = Date.UTC(2026, 4, 2, 12);
    const layout = getWorkspaceFilesystemLayout('workspace-a');
    const oldLog = path.join(layout.logs, managedXcodebuildLogName());
    const derivedDataLog = path.join(layout.derivedData, 'Build', 'old.log');
    writeFileWithMtime(oldLog, 'old', now - 4 * 24 * 60 * 60 * 1000);
    writeFileWithMtime(derivedDataLog, 'xcode-owned', now - 4 * 24 * 60 * 60 * 1000);

    const result = await runWorkspaceFilesystemLifecycleSweep({
      workspaceKey: 'workspace-a',
      trigger: 'manual',
      now,
      force: true,
      minVisibleMs: 0,
    });

    expect(result).toMatchObject({ scanned: 1, deleted: 1, skippedByLock: false });
    expect(existsSync(oldLog)).toBe(false);
    expect(existsSync(derivedDataLog)).toBe(true);
  });

  it('removes owned xcode-ide call-tool transient artifacts during shutdown cleanup', async () => {
    const layout = getWorkspaceFilesystemLayout('workspace-a');
    const currentArtifact = path.join(
      layout.state,
      'xcode-ide',
      'call-tool',
      `ownerpid${process.pid}_filesystem-lifecycle-test`,
      'response.json',
    );
    const staleArtifact = path.join(
      layout.state,
      'xcode-ide',
      'call-tool',
      'ownerpid999999999_stale',
      'response.json',
    );
    const liveArtifact = path.join(
      layout.state,
      'xcode-ide',
      'call-tool',
      `ownerpid${process.pid}_other-live-instance`,
      'response.json',
    );
    writeFileWithMtime(currentArtifact, '{}', Date.now());
    writeFileWithMtime(staleArtifact, '{}', Date.now());
    writeFileWithMtime(liveArtifact, '{}', Date.now());

    const result = await cleanupOwnedWorkspaceFilesystemArtifacts({
      workspaceKey: 'workspace-a',
      trigger: 'shutdown',
    });

    expect(result.errors).toEqual([]);
    expect(existsSync(currentArtifact)).toBe(false);
    expect(existsSync(staleArtifact)).toBe(false);
    expect(existsSync(liveArtifact)).toBe(true);
  });

  it('protects active daemon logs through the existing daemon registry', async () => {
    const now = Date.UTC(2026, 4, 2, 12);
    const layout = getWorkspaceFilesystemLayout('workspace-a');
    const daemonLog = path.join(layout.logs, 'daemon.log');
    const oldLog = path.join(layout.logs, managedXcodebuildLogName());
    writeFileWithMtime(daemonLog, 'active daemon', now - 4 * 24 * 60 * 60 * 1000);
    writeFileWithMtime(oldLog, 'old', now - 4 * 24 * 60 * 60 * 1000);
    writeDaemonRegistryEntry({
      workspaceKey: 'workspace-a',
      workspaceRoot: '/tmp/workspace-a',
      socketPath: '/tmp/mobilebuildmcp.sock',
      logPath: daemonLog,
      pid: process.pid,
      startedAt: new Date(now).toISOString(),
      enabledWorkflows: [],
      version: 'test',
    });

    const result = await runWorkspaceFilesystemLifecycleSweep({
      workspaceKey: 'workspace-a',
      trigger: 'manual',
      now,
      force: true,
      minVisibleMs: 0,
    });

    expect(result).toMatchObject({ scanned: 2, deleted: 1 });
    expect(existsSync(daemonLog)).toBe(true);
    expect(existsSync(oldLog)).toBe(false);
  });

  it('removes stale xcode-ide call-tool transient artifacts at startup even when log retention is cooling down', async () => {
    const now = Date.UTC(2026, 4, 2, 12);
    const layout = getWorkspaceFilesystemLayout('workspace-a');
    const staleArtifact = path.join(
      layout.state,
      'xcode-ide',
      'call-tool',
      'ownerpid999999999_stale',
      'response.json',
    );
    const liveArtifact = path.join(
      layout.state,
      'xcode-ide',
      'call-tool',
      `ownerpid${process.pid}_other-live-instance`,
      'response.json',
    );
    writeFileWithMtime(staleArtifact, '{}', now);
    writeFileWithMtime(liveArtifact, '{}', now);
    writeFileWithMtime(layout.filesystemLifecycle.markerPath, String(now), now);

    const result = await runWorkspaceFilesystemLifecycleSweep({
      workspaceKey: 'workspace-a',
      trigger: 'startup',
      now: now + 1000,
    });

    expect(result).toMatchObject({ skippedByCooldown: true, scanned: 0 });
    expect(existsSync(staleArtifact)).toBe(false);
    expect(existsSync(liveArtifact)).toBe(true);
  });

  it('runs startup OSLog reconciliation even when log retention is cooling down', async () => {
    const now = Date.UTC(2026, 4, 2, 12);
    const layout = getWorkspaceFilesystemLayout('workspace-a');
    let helperActive = true;
    const child = createTrackedChild(901, () => {
      helperActive = false;
    });
    const sessionId = await registerSimulatorLaunchOsLogSession({
      process: child,
      simulatorUuid: 'sim-1',
      bundleId: 'io.sentry.app',
      logFilePath: path.join(layout.logs, 'oslog.log'),
    });
    writeFileSync(
      path.join(layout.simulatorLaunchOsLogRegistryDir, `${sessionId}.json`),
      `${JSON.stringify({
        sessionId,
        owner: { instanceId: 'dead-owner', pid: 999999999, workspaceKey: 'workspace-a' },
        simulatorUuid: 'sim-1',
        bundleId: 'io.sentry.app',
        helperPid: 901,
        logFilePath: path.join(layout.logs, 'oslog.log'),
        startedAtMs: now,
        expectedCommandParts: ['node'],
      })}\n`,
    );
    setSimulatorLaunchOsLogRecordActiveOverrideForTests(async () => helperActive);
    writeFileWithMtime(layout.filesystemLifecycle.markerPath, String(now), now);

    const result = await runWorkspaceFilesystemLifecycleSweep({
      workspaceKey: 'workspace-a',
      trigger: 'startup',
      now: now + 1000,
      timeoutMs: 1,
    });

    expect(result).toMatchObject({ stopped: 1, skippedByCooldown: true, scanned: 0 });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('preserves unknown log files while pruning known generated logs', async () => {
    const now = Date.UTC(2026, 4, 2, 12);
    const layout = getWorkspaceFilesystemLayout('workspace-a');
    const unknownLog = path.join(layout.logs, 'unknown.log');
    const knownLog = path.join(layout.logs, managedXcodebuildLogName());
    writeFileWithMtime(unknownLog, 'unknown', now - 4 * 24 * 60 * 60 * 1000);
    writeFileWithMtime(knownLog, 'known', now - 4 * 24 * 60 * 60 * 1000);

    const result = await runWorkspaceFilesystemLifecycleSweep({
      workspaceKey: 'workspace-a',
      trigger: 'manual',
      now,
      force: true,
      minVisibleMs: 0,
    });

    expect(result).toMatchObject({ scanned: 1, deleted: 1 });
    expect(existsSync(unknownLog)).toBe(true);
    expect(existsSync(knownLog)).toBe(false);
  });

  it('prunes only managed result bundles from workspace result-bundles', async () => {
    const now = Date.UTC(2026, 4, 2, 12);
    const layout = getWorkspaceFilesystemLayout('workspace-a');
    const managedBundle = path.join(layout.resultBundles, managedResultBundleName('test'));
    const unknownBundle = path.join(layout.resultBundles, 'manual-user-bundle.xcresult');
    writeResultBundleWithMtime(managedBundle, now - 4 * 24 * 60 * 60 * 1000);
    writeResultBundleWithMtime(unknownBundle, now - 4 * 24 * 60 * 60 * 1000);

    const result = await runWorkspaceFilesystemLifecycleSweep({
      workspaceKey: 'workspace-a',
      trigger: 'manual',
      now,
      force: true,
      minVisibleMs: 0,
    });

    expect(result).toMatchObject({ scanned: 1, deleted: 1 });
    expect(existsSync(managedBundle)).toBe(false);
    expect(existsSync(unknownBundle)).toBe(true);
  });

  it('applies maxFiles overflow pruning to managed result bundles', async () => {
    const now = Date.UTC(2026, 4, 2, 12);
    const layout = getWorkspaceFilesystemLayout('workspace-a');
    const oldBundle = path.join(layout.resultBundles, managedResultBundleName('test_old'));
    const newBundle = path.join(layout.resultBundles, managedResultBundleName('test_new'));
    writeResultBundleWithMtime(oldBundle, now - 2 * 24 * 60 * 60 * 1000);
    writeResultBundleWithMtime(newBundle, now - 1 * 24 * 60 * 60 * 1000);

    const result = await runWorkspaceFilesystemLifecycleSweep({
      workspaceKey: 'workspace-a',
      trigger: 'manual',
      now,
      force: true,
      minVisibleMs: 0,
      maxFiles: 1,
    });

    expect(result).toMatchObject({ scanned: 2, deleted: 1 });
    expect(existsSync(oldBundle)).toBe(false);
    expect(existsSync(newBundle)).toBe(true);
  });

  it('uses the dedicated test-products retention cap instead of the log cap', async () => {
    const now = Date.UTC(2026, 4, 2, 12);
    const layout = getWorkspaceFilesystemLayout('workspace-a');
    const products = Array.from({ length: TEST_PRODUCTS_MAX_COUNT + 1 }, (_, index) => {
      const productsPath = path.join(
        layout.testProducts,
        managedTestProductsName(`test_${String(index).padStart(3, '0')}`),
      );
      writeTestProductsWithMtime(productsPath, now - (TEST_PRODUCTS_MAX_COUNT - index) * 1000);
      writeFileSync(getTestProductsCompletionMarkerPath(productsPath), 'completed');
      return productsPath;
    });

    const result = await runWorkspaceFilesystemLifecycleSweep({
      workspaceKey: 'workspace-a',
      trigger: 'manual',
      now,
      force: true,
      minVisibleMs: 0,
      maxAgeMs: 3 * 24 * 60 * 60 * 1000,
      maxFiles: 1,
    });

    expect(result).toMatchObject({ scanned: TEST_PRODUCTS_MAX_COUNT + 1, deleted: 1 });
    expect(existsSync(products[0]!)).toBe(false);
    expect(existsSync(products.at(-1)!)).toBe(true);
    expect(existsSync(getTestProductsCompletionMarkerPath(products[0]!))).toBe(false);
  });

  it('protects live managed result bundles until their completion marker exists', async () => {
    const now = Date.UTC(2026, 4, 2, 12);
    const layout = getWorkspaceFilesystemLayout('workspace-a');
    const liveBundle = path.join(
      layout.resultBundles,
      managedResultBundleName('test_live', process.pid),
    );
    writeResultBundleWithMtime(liveBundle, now - 4 * 24 * 60 * 60 * 1000);

    const result = await runWorkspaceFilesystemLifecycleSweep({
      workspaceKey: 'workspace-a',
      trigger: 'manual',
      now,
      force: true,
      minVisibleMs: 0,
    });

    expect(result).toMatchObject({ scanned: 1, deleted: 0 });
    expect(existsSync(liveBundle)).toBe(true);
  });

  it('prunes completed managed result bundles even when the owner process is still alive', async () => {
    const now = Date.UTC(2026, 4, 2, 12);
    const layout = getWorkspaceFilesystemLayout('workspace-a');
    const completedBundle = path.join(
      layout.resultBundles,
      managedResultBundleName('test_completed', process.pid),
    );
    writeResultBundleWithMtime(completedBundle, now - 4 * 24 * 60 * 60 * 1000);
    writeFileWithMtime(
      getResultBundleCompletionMarkerPath(completedBundle),
      'completed',
      now - 4 * 24 * 60 * 60 * 1000,
    );

    const result = await runWorkspaceFilesystemLifecycleSweep({
      workspaceKey: 'workspace-a',
      trigger: 'manual',
      now,
      force: true,
      minVisibleMs: 0,
    });

    expect(result).toMatchObject({ scanned: 1, deleted: 1 });
    expect(existsSync(completedBundle)).toBe(false);
    expect(existsSync(getResultBundleCompletionMarkerPath(completedBundle))).toBe(false);
  });

  it('cooldowns repeat schedule calls for the same workspace', () => {
    vi.useFakeTimers();
    try {
      scheduleWorkspaceFilesystemLifecycleSweep({
        workspaceKey: 'workspace-a',
        trigger: 'artifact-created',
      });
      const firstCount = vi.getTimerCount();

      scheduleWorkspaceFilesystemLifecycleSweep({
        workspaceKey: 'workspace-a',
        trigger: 'artifact-created',
      });
      scheduleWorkspaceFilesystemLifecycleSweep({
        workspaceKey: 'workspace-a',
        trigger: 'artifact-created',
      });

      expect(firstCount).toBe(1);
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('uses the lifecycle lock to skip a held same-workspace sweep', async () => {
    const now = Date.UTC(2026, 4, 2, 12);
    const layout = getWorkspaceFilesystemLayout('workspace-a');
    const oldLog = path.join(layout.logs, managedXcodebuildLogName());
    writeFileWithMtime(oldLog, 'old', now - 4 * 24 * 60 * 60 * 1000);
    mkdirSync(layout.filesystemLifecycle.lockDir, { recursive: true });

    const result = await runWorkspaceFilesystemLifecycleSweep({
      workspaceKey: 'workspace-a',
      trigger: 'manual',
      now,
      force: true,
      minVisibleMs: 0,
    });

    expect(result).toMatchObject({ skippedByLock: true, scanned: 0, deleted: 0 });
    expect(existsSync(oldLog)).toBe(true);
  });
});
