import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setRuntimeInstanceForTests } from '../runtime-instance.ts';
import {
  clearAllSimulatorLaunchOsLogSessionsForTests,
  listActiveSimulatorLaunchOsLogSessions,
  reconcileSimulatorLaunchOsLogOrphansForWorkspace,
  registerSimulatorLaunchOsLogSession,
  setSimulatorLaunchOsLogOwnerPidAliveOverrideForTests,
  setSimulatorLaunchOsLogRegistryDirOverrideForTests,
  stopAllSimulatorLaunchOsLogSessions,
  stopOwnedSimulatorLaunchOsLogSessions,
  stopSimulatorLaunchOsLogSessionsForApp,
  terminateLiveSimulatorLaunchOsLogSessionsSync,
} from '../log-capture/simulator-launch-oslog-sessions.ts';
import { setSimulatorLaunchOsLogRecordActiveOverrideForTests } from '../log-capture/simulator-launch-oslog-registry.ts';

let registryDir: string;
let nextPid = 1000;
const trackedChildren = new Map<number, ChildProcess>();

function createMockChild(options?: {
  pid?: number;
  exitCode?: number | null;
  killImplementation?: (signal?: NodeJS.Signals | number) => boolean;
}): ChildProcess {
  const emitter = new EventEmitter();
  const child = emitter as ChildProcess;
  let exitCode = options?.exitCode ?? null;
  const pid = options?.pid ?? nextPid++;

  Object.defineProperty(child, 'pid', { value: pid, configurable: true });
  Object.defineProperty(child, 'exitCode', {
    configurable: true,
    get: () => exitCode,
    set: (value: number | null) => {
      exitCode = value;
    },
  });

  trackedChildren.set(pid, child);

  child.kill = vi.fn((signal?: NodeJS.Signals | number) => {
    if (options?.killImplementation) {
      return options.killImplementation(signal);
    }
    if (signal === 'SIGTERM' || signal === 'SIGKILL') {
      exitCode = 0;
      queueMicrotask(() => {
        emitter.emit('exit', 0, signal);
        emitter.emit('close', 0, signal);
      });
    }
    return true;
  }) as ChildProcess['kill'];

  return child;
}

describe('simulator launch OSLog sessions', () => {
  beforeEach(() => {
    nextPid = 1000;
    trackedChildren.clear();
    registryDir = mkdtempSync(path.join(tmpdir(), 'mobilebuildmcp-oslog-sessions-'));
    setSimulatorLaunchOsLogRegistryDirOverrideForTests(registryDir);
    setRuntimeInstanceForTests({
      instanceId: 'current-instance',
      pid: process.pid,
      workspaceKey: 'workspace-a',
    });
    setSimulatorLaunchOsLogRecordActiveOverrideForTests(async (record) => {
      const child = trackedChildren.get(record.helperPid);
      return child ? child.exitCode == null : true;
    });
  });

  afterEach(async () => {
    await clearAllSimulatorLaunchOsLogSessionsForTests();
    setSimulatorLaunchOsLogRecordActiveOverrideForTests(null);
    setSimulatorLaunchOsLogOwnerPidAliveOverrideForTests(null);
    setRuntimeInstanceForTests(null);
    setSimulatorLaunchOsLogRegistryDirOverrideForTests(null);
    trackedChildren.clear();
    await rm(registryDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('registers and lists active sessions', async () => {
    await registerSimulatorLaunchOsLogSession({
      process: createMockChild({ pid: 101 }),
      simulatorUuid: 'sim-1',
      bundleId: 'app.a',
      logFilePath: '/tmp/a.log',
    });

    await expect(listActiveSimulatorLaunchOsLogSessions()).resolves.toEqual([
      expect.objectContaining({
        simulatorUuid: 'sim-1',
        bundleId: 'app.a',
        pid: 101,
        logFilePath: '/tmp/a.log',
        ownedByCurrentProcess: true,
      }),
    ]);
  });

  it('lists only sessions from the current workspace', async () => {
    await registerSimulatorLaunchOsLogSession({
      process: createMockChild({ pid: 151 }),
      simulatorUuid: 'sim-1',
      bundleId: 'app.current',
      logFilePath: '/tmp/current.log',
    });
    setRuntimeInstanceForTests({
      instanceId: 'other-instance',
      pid: 4242,
      workspaceKey: 'workspace-b',
    });
    await registerSimulatorLaunchOsLogSession({
      process: createMockChild({ pid: 152 }),
      simulatorUuid: 'sim-1',
      bundleId: 'app.other',
      logFilePath: '/tmp/other.log',
    });
    setRuntimeInstanceForTests({
      instanceId: 'current-instance',
      pid: process.pid,
      workspaceKey: 'workspace-a',
    });

    await expect(listActiveSimulatorLaunchOsLogSessions()).resolves.toEqual([
      expect.objectContaining({ bundleId: 'app.current', pid: 151 }),
    ]);
  });

  it('returns empty status and no-ops owner cleanup before runtime workspace configuration', async () => {
    await registerSimulatorLaunchOsLogSession({
      process: createMockChild({ pid: 161 }),
      simulatorUuid: 'sim-1',
      bundleId: 'app.current',
      logFilePath: '/tmp/current.log',
    });
    setRuntimeInstanceForTests(null);

    await expect(listActiveSimulatorLaunchOsLogSessions()).resolves.toEqual([]);
    await expect(stopOwnedSimulatorLaunchOsLogSessions()).resolves.toEqual({
      stoppedSessionCount: 0,
      errorCount: 0,
      errors: [],
    });
  });

  it('removes sessions when the child exits', async () => {
    const child = createMockChild({ pid: 202 });
    await registerSimulatorLaunchOsLogSession({
      process: child,
      simulatorUuid: 'sim-1',
      bundleId: 'app.a',
      logFilePath: '/tmp/a.log',
    });

    Object.defineProperty(child, 'exitCode', { value: 0, writable: true, configurable: true });
    child.emit('exit', 0);
    await Promise.resolve();
    await Promise.resolve();

    await expect(listActiveSimulatorLaunchOsLogSessions()).resolves.toEqual([]);
  });

  it('stops only matching app sessions', async () => {
    const matching = createMockChild({ pid: 301 });
    const other = createMockChild({ pid: 302 });

    await registerSimulatorLaunchOsLogSession({
      process: matching,
      simulatorUuid: 'sim-1',
      bundleId: 'app.a',
      logFilePath: '/tmp/a.log',
    });
    await registerSimulatorLaunchOsLogSession({
      process: other,
      simulatorUuid: 'sim-1',
      bundleId: 'app.b',
      logFilePath: '/tmp/b.log',
    });

    const result = await stopSimulatorLaunchOsLogSessionsForApp('sim-1', 'app.a');

    expect(result).toEqual({ stoppedSessionCount: 1, errorCount: 0, errors: [] });
    expect(matching.kill).toHaveBeenCalledWith('SIGTERM');
    expect(other.kill).not.toHaveBeenCalled();
    await expect(listActiveSimulatorLaunchOsLogSessions()).resolves.toEqual([
      expect.objectContaining({ bundleId: 'app.b', pid: 302 }),
    ]);
  });

  it('stops only owned sessions during owner-scoped cleanup', async () => {
    const currentChild = createMockChild({ pid: 401 });
    await registerSimulatorLaunchOsLogSession({
      process: currentChild,
      simulatorUuid: 'sim-1',
      bundleId: 'app.current',
      logFilePath: '/tmp/current.log',
    });

    setRuntimeInstanceForTests({
      instanceId: 'foreign-instance',
      pid: process.pid,
      workspaceKey: 'workspace-a',
    });
    await registerSimulatorLaunchOsLogSession({
      process: createMockChild({ pid: 402 }),
      simulatorUuid: 'sim-2',
      bundleId: 'app.foreign',
      logFilePath: '/tmp/foreign.log',
    });
    setRuntimeInstanceForTests({
      instanceId: 'current-instance',
      pid: process.pid,
      workspaceKey: 'workspace-a',
    });

    const result = await stopOwnedSimulatorLaunchOsLogSessions();

    expect(result).toEqual({ stoppedSessionCount: 1, errorCount: 0, errors: [] });
    expect(currentChild.kill).toHaveBeenCalledWith('SIGTERM');
    await expect(listActiveSimulatorLaunchOsLogSessions()).resolves.toEqual([
      expect.objectContaining({
        bundleId: 'app.foreign',
        pid: 402,
        ownedByCurrentProcess: false,
      }),
    ]);
  });

  it('stops all sessions and aggregates errors', async () => {
    await registerSimulatorLaunchOsLogSession({
      process: createMockChild({ pid: 501 }),
      simulatorUuid: 'sim-1',
      bundleId: 'app.a',
      logFilePath: '/tmp/a.log',
    });
    await registerSimulatorLaunchOsLogSession({
      process: createMockChild({
        pid: 502,
        killImplementation: () => {
          throw new Error('boom');
        },
      }),
      simulatorUuid: 'sim-2',
      bundleId: 'app.b',
      logFilePath: '/tmp/b.log',
    });

    const result = await stopAllSimulatorLaunchOsLogSessions();

    expect(result.stoppedSessionCount).toBe(1);
    expect(result.errorCount).toBe(1);
    expect(result.errors[0]).toContain('boom');
    await expect(listActiveSimulatorLaunchOsLogSessions()).resolves.toEqual([
      expect.objectContaining({ bundleId: 'app.b', pid: 502 }),
    ]);
  });

  it('escalates to SIGKILL after timeout', async () => {
    const child = createMockChild({
      pid: 601,
      killImplementation: (() => {
        let callCount = 0;
        return (signal?: NodeJS.Signals | number) => {
          callCount += 1;
          if (callCount === 2) {
            Object.defineProperty(child, 'exitCode', {
              value: 0,
              writable: true,
              configurable: true,
            });
            queueMicrotask(() => {
              child.emit('exit', 0, signal);
              child.emit('close', 0, signal);
            });
          }
          return true;
        };
      })(),
    });

    await registerSimulatorLaunchOsLogSession({
      process: child,
      simulatorUuid: 'sim-1',
      bundleId: 'app.a',
      logFilePath: '/tmp/a.log',
    });

    const result = await stopSimulatorLaunchOsLogSessionsForApp('sim-1', 'app.a', 1);

    expect(result).toEqual({ stoppedSessionCount: 1, errorCount: 0, errors: [] });
    expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
    expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
    await expect(listActiveSimulatorLaunchOsLogSessions()).resolves.toEqual([]);
  });

  it('keeps a session visible when termination fails', async () => {
    const child = createMockChild({
      pid: 701,
      killImplementation: () => {
        throw new Error('sigterm failed');
      },
    });

    await registerSimulatorLaunchOsLogSession({
      process: child,
      simulatorUuid: 'sim-1',
      bundleId: 'app.a',
      logFilePath: '/tmp/a.log',
    });

    const result = await stopSimulatorLaunchOsLogSessionsForApp('sim-1', 'app.a');

    expect(result.stoppedSessionCount).toBe(0);
    expect(result.errorCount).toBe(1);
    expect(result.errors[0]).toContain('sigterm failed');
    await expect(listActiveSimulatorLaunchOsLogSessions()).resolves.toEqual([
      expect.objectContaining({ bundleId: 'app.a', pid: 701 }),
    ]);
  });

  it('does not stop same-app sessions owned by a live foreign instance', async () => {
    const foreignChild = createMockChild({ pid: 801 });
    setRuntimeInstanceForTests({
      instanceId: 'foreign-instance',
      pid: 4242,
      workspaceKey: 'workspace-a',
    });
    await registerSimulatorLaunchOsLogSession({
      process: foreignChild,
      simulatorUuid: 'sim-1',
      bundleId: 'app.a',
      logFilePath: '/tmp/foreign.log',
    });
    setRuntimeInstanceForTests({
      instanceId: 'current-instance',
      pid: process.pid,
      workspaceKey: 'workspace-a',
    });
    setSimulatorLaunchOsLogOwnerPidAliveOverrideForTests((pid) => pid === 4242);

    const result = await stopSimulatorLaunchOsLogSessionsForApp('sim-1', 'app.a');

    expect(result).toEqual({ stoppedSessionCount: 0, errorCount: 0, errors: [] });
    expect(foreignChild.kill).not.toHaveBeenCalled();
    await expect(listActiveSimulatorLaunchOsLogSessions()).resolves.toEqual([
      expect.objectContaining({ bundleId: 'app.a', pid: 801, ownedByCurrentProcess: false }),
    ]);
  });

  it('reconciles same-workspace sessions owned by dead processes', async () => {
    const orphanChild = createMockChild({ pid: 901 });
    setRuntimeInstanceForTests({
      instanceId: 'dead-instance',
      pid: 4242,
      workspaceKey: 'workspace-a',
    });
    await registerSimulatorLaunchOsLogSession({
      process: orphanChild,
      simulatorUuid: 'sim-1',
      bundleId: 'app.a',
      logFilePath: '/tmp/orphan.log',
    });
    setRuntimeInstanceForTests({
      instanceId: 'current-instance',
      pid: process.pid,
      workspaceKey: 'workspace-a',
    });
    setSimulatorLaunchOsLogOwnerPidAliveOverrideForTests(() => false);

    const result = await reconcileSimulatorLaunchOsLogOrphansForWorkspace('workspace-a', 1);

    expect(result).toEqual({
      scannedSessionCount: 1,
      eligibleOrphanCount: 1,
      stoppedSessionCount: 1,
      skippedLiveOwnerCount: 0,
      skippedDifferentWorkspaceCount: 0,
      errorCount: 0,
      errors: [],
    });
    expect(orphanChild.kill).toHaveBeenCalledWith('SIGTERM');
    await expect(listActiveSimulatorLaunchOsLogSessions()).resolves.toEqual([]);
  });

  it('does not scan or reconcile sessions from a different workspace', async () => {
    const otherWorkspaceChild = createMockChild({ pid: 1001 });
    setRuntimeInstanceForTests({
      instanceId: 'dead-instance',
      pid: 4242,
      workspaceKey: 'workspace-b',
    });
    await registerSimulatorLaunchOsLogSession({
      process: otherWorkspaceChild,
      simulatorUuid: 'sim-1',
      bundleId: 'app.a',
      logFilePath: '/tmp/other.log',
    });
    setRuntimeInstanceForTests({
      instanceId: 'current-instance',
      pid: process.pid,
      workspaceKey: 'workspace-a',
    });
    setSimulatorLaunchOsLogOwnerPidAliveOverrideForTests(() => false);

    const result = await reconcileSimulatorLaunchOsLogOrphansForWorkspace('workspace-a', 1);

    expect(result).toEqual({
      scannedSessionCount: 0,
      eligibleOrphanCount: 0,
      stoppedSessionCount: 0,
      skippedLiveOwnerCount: 0,
      skippedDifferentWorkspaceCount: 0,
      errorCount: 0,
      errors: [],
    });
    expect(otherWorkspaceChild.kill).not.toHaveBeenCalled();
  });

  it('does not reconcile sessions whose owner pid is still alive', async () => {
    const liveOwnerChild = createMockChild({ pid: 1101 });
    setRuntimeInstanceForTests({
      instanceId: 'live-instance',
      pid: 4242,
      workspaceKey: 'workspace-a',
    });
    await registerSimulatorLaunchOsLogSession({
      process: liveOwnerChild,
      simulatorUuid: 'sim-1',
      bundleId: 'app.a',
      logFilePath: '/tmp/live.log',
    });
    setRuntimeInstanceForTests({
      instanceId: 'current-instance',
      pid: process.pid,
      workspaceKey: 'workspace-a',
    });
    setSimulatorLaunchOsLogOwnerPidAliveOverrideForTests((pid) => pid === 4242);

    const result = await reconcileSimulatorLaunchOsLogOrphansForWorkspace('workspace-a', 1);

    expect(result.stoppedSessionCount).toBe(0);
    expect(result.skippedLiveOwnerCount).toBe(1);
    expect(liveOwnerChild.kill).not.toHaveBeenCalled();
  });

  it('terminates only live local sessions synchronously', async () => {
    const liveChild = createMockChild({ pid: 1201 });
    const exitedChild = createMockChild({ pid: 1202, exitCode: 0 });

    await registerSimulatorLaunchOsLogSession({
      process: liveChild,
      simulatorUuid: 'sim-1',
      bundleId: 'app.live',
      logFilePath: '/tmp/live.log',
    });
    await registerSimulatorLaunchOsLogSession({
      process: exitedChild,
      simulatorUuid: 'sim-1',
      bundleId: 'app.exited',
      logFilePath: '/tmp/exited.log',
    });

    const result = terminateLiveSimulatorLaunchOsLogSessionsSync();

    expect(result).toEqual({ attemptedCount: 1, errorCount: 0, errors: [] });
    expect(liveChild.kill).toHaveBeenCalledWith('SIGTERM');
    expect(exitedChild.kill).not.toHaveBeenCalled();
  });
});
