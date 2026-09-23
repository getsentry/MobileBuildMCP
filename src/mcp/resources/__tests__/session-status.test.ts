import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { clearDaemonActivityRegistry } from '../../../daemon/activity-registry.ts';
import { getDefaultDebuggerManager } from '../../../utils/debugger/index.ts';
import {
  clearAllSimulatorLaunchOsLogSessionsForTests,
  registerSimulatorLaunchOsLogSession,
  setSimulatorLaunchOsLogRegistryDirOverrideForTests,
} from '../../../utils/log-capture/simulator-launch-oslog-sessions.ts';
import { setSimulatorLaunchOsLogRecordActiveOverrideForTests } from '../../../utils/log-capture/simulator-launch-oslog-registry.ts';
import { setRuntimeInstanceForTests } from '../../../utils/runtime-instance.ts';
import { clearAllProcesses } from '../../tools/swift-package/active-processes.ts';
import { sessionStatusResourceLogic } from '../session-status.ts';

let registryDir: string;

function createTrackedChild(pid = 777): ChildProcess {
  const emitter = new EventEmitter();
  const child = emitter as ChildProcess;
  Object.defineProperty(child, 'pid', { value: pid, configurable: true });
  Object.defineProperty(child, 'exitCode', { value: null, writable: true, configurable: true });
  child.kill = (() => true) as ChildProcess['kill'];
  return child;
}

describe('session-status resource', () => {
  beforeEach(async () => {
    registryDir = mkdtempSync(path.join(tmpdir(), 'mobilebuildmcp-session-status-'));
    setSimulatorLaunchOsLogRegistryDirOverrideForTests(registryDir);
    setRuntimeInstanceForTests({
      instanceId: 'session-status-test',
      pid: process.pid,
      workspaceKey: 'workspace-a',
    });
    setSimulatorLaunchOsLogRecordActiveOverrideForTests(async () => true);
    clearAllProcesses();
    await clearAllSimulatorLaunchOsLogSessionsForTests();
    clearDaemonActivityRegistry();
    await getDefaultDebuggerManager().disposeAll();
  });

  afterEach(async () => {
    clearAllProcesses();
    await clearAllSimulatorLaunchOsLogSessionsForTests();
    clearDaemonActivityRegistry();
    await getDefaultDebuggerManager().disposeAll();
    setSimulatorLaunchOsLogRecordActiveOverrideForTests(null);
    setRuntimeInstanceForTests(null);
    setSimulatorLaunchOsLogRegistryDirOverrideForTests(null);
    await rm(registryDir, { recursive: true, force: true });
  });

  describe('Handler Functionality', () => {
    it('should return empty status when no sessions exist', async () => {
      const result = await sessionStatusResourceLogic();

      expect(result.contents).toHaveLength(1);
      const parsed = JSON.parse(result.contents[0].text);

      expect(parsed.logging.simulator.activeLaunchOsLogSessions).toEqual([]);
      expect(parsed.logging.device).toBeUndefined();
      expect(parsed.debug.currentSessionId).toBe(null);
      expect(parsed.debug.sessionIds).toEqual([]);
      expect(parsed.watcher).toEqual({ running: false, watchedPath: null });
      expect(parsed.video.activeSessionIds).toEqual([]);
      expect(parsed.swiftPackage.activePids).toEqual([]);
      expect(parsed.activity).toEqual({ activeOperationCount: 0, byCategory: {} });
      expect(parsed.process.pid).toBeTypeOf('number');
      expect(parsed.process.uptimeMs).toBeTypeOf('number');
      expect(parsed.process.rssBytes).toBeTypeOf('number');
      expect(parsed.process.heapUsedBytes).toBeTypeOf('number');
    });

    it('should include tracked launch OSLog sessions', async () => {
      await registerSimulatorLaunchOsLogSession({
        process: createTrackedChild(888),
        simulatorUuid: 'sim-1',
        bundleId: 'io.sentry.app',
        logFilePath: '/tmp/app.log',
      });

      const result = await sessionStatusResourceLogic();
      const parsed = JSON.parse(result.contents[0].text);

      expect(parsed.logging.simulator.activeLaunchOsLogSessions).toEqual([
        expect.objectContaining({
          simulatorUuid: 'sim-1',
          bundleId: 'io.sentry.app',
          pid: 888,
          logFilePath: '/tmp/app.log',
          ownedByCurrentProcess: true,
        }),
      ]);
    });
  });
});
