import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  launchSimulatorAppWithLogging,
  setSimulatorLogDirOverrideForTests,
} from '../simulator-steps.ts';
import { getWorkspaceFilesystemLayout } from '../log-paths.ts';
import type { CommandExecutor } from '../CommandExecutor.ts';
import { setRuntimeInstanceForTests } from '../runtime-instance.ts';
import {
  clearAllSimulatorLaunchOsLogSessionsForTests,
  listActiveSimulatorLaunchOsLogSessions,
  setSimulatorLaunchOsLogRegistryDirOverrideForTests,
} from '../log-capture/simulator-launch-oslog-sessions.ts';
import { setSimulatorLaunchOsLogRecordActiveOverrideForTests } from '../log-capture/simulator-launch-oslog-registry.ts';

let registryDir: string;
let logDir: string;
let nextPid = 90000;
const trackedChildren = new Map<number, ChildProcess>();

function createMockChild(exitCode: number | null = null): ChildProcess {
  const emitter = new EventEmitter();
  const child = emitter as unknown as ChildProcess;
  let currentExitCode = exitCode;
  const pid = nextPid++;
  Object.defineProperty(child, 'exitCode', {
    get: () => currentExitCode,
    set: (value: number | null) => {
      currentExitCode = value;
    },
    configurable: true,
  });
  child.unref = vi.fn();
  trackedChildren.set(pid, child);
  child.kill = vi.fn((signal?: NodeJS.Signals | number) => {
    currentExitCode = 0;
    queueMicrotask(() => {
      emitter.emit('exit', 0, signal);
      emitter.emit('close', 0, signal);
    });
    return true;
  }) as ChildProcess['kill'];
  Object.defineProperty(child, 'pid', { value: pid, writable: true });
  return child;
}

function createMockSpawner() {
  return (_command: string, _args: string[], _options: SpawnOptions): ChildProcess => {
    return createMockChild(null);
  };
}

function createMockExecutor(pid?: number): CommandExecutor {
  return async () => ({
    success: true,
    output: pid !== undefined ? `com.example.app: ${pid}` : '',
    process: { pid: 1 } as never,
    exitCode: 0,
  });
}

describe.sequential('launchSimulatorAppWithLogging PID resolution', () => {
  beforeEach(() => {
    nextPid = 90000;
    trackedChildren.clear();
    registryDir = mkdtempSync(path.join(tmpdir(), 'mobilebuildmcp-oslog-launch-'));
    logDir = path.join(registryDir, 'logs');
    setSimulatorLaunchOsLogRegistryDirOverrideForTests(registryDir);
    setSimulatorLogDirOverrideForTests(logDir);
    setRuntimeInstanceForTests({
      instanceId: 'launch-test-instance',
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
    setRuntimeInstanceForTests(null);
    setSimulatorLaunchOsLogRegistryDirOverrideForTests(null);
    setSimulatorLogDirOverrideForTests(null);
    trackedChildren.clear();
    await rm(registryDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('resolves PID via idempotent simctl launch', async () => {
    const spawner = createMockSpawner();
    const executor = createMockExecutor(42567);

    const result = await launchSimulatorAppWithLogging(
      'test-sim-uuid',
      'com.example.app',
      executor,
      undefined,
      { spawner },
    );

    expect(result.success).toBe(true);
    expect(result.processId).toBe(42567);
  });

  it('rejects bundle identifiers that would escape the OSLog predicate', async () => {
    const spawner = vi.fn(createMockSpawner());
    const executor = vi.fn(createMockExecutor(42567));

    const result = await launchSimulatorAppWithLogging(
      'test-sim-uuid',
      'com.evil" OR subsystem != "x',
      executor,
      undefined,
      { spawner },
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/invalid.*bundle/i);
    expect(spawner).not.toHaveBeenCalled();
    expect(executor).not.toHaveBeenCalled();
  });

  it('writes logs under the current workspace log directory when no test override is set', async () => {
    setSimulatorLogDirOverrideForTests(null);
    const spawner = createMockSpawner();
    const executor = createMockExecutor(42567);

    const result = await launchSimulatorAppWithLogging(
      'test-sim-uuid',
      'com.example.app',
      executor,
      undefined,
      { spawner },
    );

    expect(result.success).toBe(true);
    expect(result.logFilePath).toContain(getWorkspaceFilesystemLayout('workspace-a').logs);
    expect(result.logFilePath).toContain('_helperpid90000_ownerpid');
    expect(result.osLogPath).toContain(getWorkspaceFilesystemLayout('workspace-a').logs);
    expect(result.osLogPath).toContain('_helperpid90001_ownerpid');
  });

  it('returns undefined processId when executor returns no PID', async () => {
    const spawner = createMockSpawner();
    const executor = createMockExecutor();

    const result = await launchSimulatorAppWithLogging(
      'test-sim-uuid',
      'com.example.app',
      executor,
      undefined,
      { spawner },
    );

    expect(result.success).toBe(true);
    expect(result.processId).toBeUndefined();
  });

  it('returns undefined processId when executor fails', async () => {
    const spawner = createMockSpawner();
    const executor: CommandExecutor = async () => ({
      success: false,
      output: 'Unable to launch',
      error: 'App not installed',
      process: { pid: 1 } as never,
      exitCode: 1,
    });

    const result = await launchSimulatorAppWithLogging(
      'test-sim-uuid',
      'com.example.app',
      executor,
      undefined,
      { spawner },
    );

    expect(result.success).toBe(true);
    expect(result.processId).toBeUndefined();
  });

  it('reports failure when spawn exits immediately with error', async () => {
    const spawner = (_command: string, _args: string[], _options: SpawnOptions): ChildProcess => {
      return createMockChild(1);
    };
    const executor = createMockExecutor(42567);

    const result = await launchSimulatorAppWithLogging(
      'test-sim-uuid',
      'com.example.app',
      executor,
      undefined,
      { spawner },
    );

    expect(result.success).toBe(false);
  });

  it('kills and unrefs the launch helper if helper log rename fails', async () => {
    const children: ChildProcess[] = [];
    const spawner = (_command: string, _args: string[], _options: SpawnOptions): ChildProcess => {
      const child = createMockChild(null);
      children.push(child);
      fs.chmodSync(logDir, 0o500);
      return child;
    };

    const result = await launchSimulatorAppWithLogging(
      'test-sim-uuid',
      'com.example.app',
      createMockExecutor(42567),
      undefined,
      { spawner },
    );
    fs.chmodSync(logDir, 0o700);

    expect(result.success).toBe(false);
    expect(children[0].kill).toHaveBeenCalledWith('SIGTERM');
    expect(children[0].unref).toHaveBeenCalledOnce();
  });

  it('kills and unrefs the OSLog helper if helper log rename fails', async () => {
    const children: ChildProcess[] = [];
    const spawner = (_command: string, _args: string[], _options: SpawnOptions): ChildProcess => {
      const child = createMockChild(null);
      children.push(child);
      if (children.length === 2) {
        fs.chmodSync(logDir, 0o500);
      }
      return child;
    };

    const result = await launchSimulatorAppWithLogging(
      'test-sim-uuid',
      'com.example.app',
      createMockExecutor(42567),
      undefined,
      { spawner },
    );
    fs.chmodSync(logDir, 0o700);

    expect(result.success).toBe(true);
    expect(result.osLogPath).toBeUndefined();
    expect(children[1].kill).toHaveBeenCalledWith('SIGTERM');
    expect(children[1].unref).toHaveBeenCalledOnce();
  });

  it('registers a tracked OSLog session after launch', async () => {
    const spawner = createMockSpawner();
    const executor = createMockExecutor(42567);

    const result = await launchSimulatorAppWithLogging(
      'test-sim-uuid',
      'com.example.app',
      executor,
      undefined,
      { spawner },
    );

    expect(result.success).toBe(true);
    await expect(listActiveSimulatorLaunchOsLogSessions()).resolves.toEqual([
      expect.objectContaining({
        simulatorUuid: 'test-sim-uuid',
        bundleId: 'com.example.app',
        pid: expect.any(Number),
      }),
    ]);
  });

  it('replaces an existing tracked OSLog session for the same app', async () => {
    const children: ChildProcess[] = [];
    const spawner = (_command: string, _args: string[], _options: SpawnOptions): ChildProcess => {
      const child = createMockChild(null);
      children.push(child);
      return child;
    };
    const executor = createMockExecutor(42567);

    await launchSimulatorAppWithLogging('test-sim-uuid', 'com.example.app', executor, undefined, {
      spawner,
    });
    await launchSimulatorAppWithLogging('test-sim-uuid', 'com.example.app', executor, undefined, {
      spawner,
    });

    expect(children).toHaveLength(4);
    const firstOsLogChild = children[1];
    expect(firstOsLogChild.kill).toHaveBeenCalledWith('SIGTERM');
    await expect(listActiveSimulatorLaunchOsLogSessions()).resolves.toHaveLength(1);
  });

  it('kills the spawned OSLog helper if durable registration fails', async () => {
    const brokenRegistryPath = path.join(registryDir, 'blocked');
    writeFileSync(brokenRegistryPath, 'not-a-directory');
    setSimulatorLaunchOsLogRegistryDirOverrideForTests(brokenRegistryPath);

    const children: ChildProcess[] = [];
    const spawner = (_command: string, _args: string[], _options: SpawnOptions): ChildProcess => {
      const child = createMockChild(null);
      children.push(child);
      return child;
    };

    const result = await launchSimulatorAppWithLogging(
      'test-sim-uuid',
      'com.example.app',
      createMockExecutor(42567),
      undefined,
      { spawner },
    );

    expect(result.success).toBe(true);
    expect(result.osLogPath).toBeUndefined();
    expect(children[1].kill).toHaveBeenCalledWith('SIGTERM');
    expect(children[1].unref).toHaveBeenCalledOnce();
    await expect(listActiveSimulatorLaunchOsLogSessions()).resolves.toEqual([]);
  });
});
