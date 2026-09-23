import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createMockExecutor } from '../../test-utils/mock-executors.ts';
import {
  buildMcpLifecycleSnapshot,
  classifyMcpLifecycleAnomalies,
  createMcpLifecycleCoordinator,
  isTransportDisconnectReason,
} from '../mcp-lifecycle.ts';
import * as shutdownState from '../../utils/shutdown-state.ts';
import {
  clearAllSimulatorLaunchOsLogSessionsForTests,
  registerSimulatorLaunchOsLogSession,
  setSimulatorLaunchOsLogRegistryDirOverrideForTests,
} from '../../utils/log-capture/simulator-launch-oslog-sessions.ts';
import { setSimulatorLaunchOsLogRecordActiveOverrideForTests } from '../../utils/log-capture/simulator-launch-oslog-registry.ts';
import { setRuntimeInstanceForTests } from '../../utils/runtime-instance.ts';
import { EventEmitter as NodeEventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

let registryDir: string;

class TestStdin extends EventEmitter {
  override once(event: string, listener: (...args: unknown[]) => void): this {
    return super.once(event, listener);
  }

  override removeListener(event: string, listener: (...args: unknown[]) => void): this {
    return super.removeListener(event, listener);
  }
}

class TestProcess extends EventEmitter {
  readonly stdin = new TestStdin();
  readonly stdout = new TestStdin();
  readonly stderr = new TestStdin();

  override once(event: string, listener: (...args: unknown[]) => void): this {
    return super.once(event, listener);
  }

  override removeListener(event: string, listener: (...args: unknown[]) => void): this {
    return super.removeListener(event, listener);
  }
}

function createTrackedChild(pid = 777): ChildProcess {
  const emitter = new NodeEventEmitter();
  const child = emitter as ChildProcess;
  Object.defineProperty(child, 'pid', { value: pid, configurable: true });
  Object.defineProperty(child, 'exitCode', { value: null, writable: true, configurable: true });
  child.kill = vi.fn(() => true) as ChildProcess['kill'];
  return child;
}

describe('mcp lifecycle coordinator', () => {
  beforeEach(async () => {
    registryDir = mkdtempSync(path.join(tmpdir(), 'mobilebuildmcp-mcp-lifecycle-'));
    setSimulatorLaunchOsLogRegistryDirOverrideForTests(registryDir);
    setRuntimeInstanceForTests({
      instanceId: 'mcp-lifecycle-test',
      pid: process.pid,
      workspaceKey: 'workspace-a',
    });
    setSimulatorLaunchOsLogRecordActiveOverrideForTests(async () => true);
    await clearAllSimulatorLaunchOsLogSessionsForTests();
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    await clearAllSimulatorLaunchOsLogSessionsForTests();
    setSimulatorLaunchOsLogRecordActiveOverrideForTests(null);
    setRuntimeInstanceForTests(null);
    setSimulatorLaunchOsLogRegistryDirOverrideForTests(null);
    await rm(registryDir, { recursive: true, force: true });
  });

  it('deduplicates shutdown requests from stdin end and close', async () => {
    const processRef = new TestProcess();
    const onShutdown = vi.fn().mockResolvedValue(undefined);
    const coordinator = createMcpLifecycleCoordinator({
      commandExecutor: createMockExecutor({ output: '' }),
      processRef,
      onShutdown,
    });

    coordinator.attachProcessHandlers();
    processRef.stdin.emit('end');
    processRef.stdin.emit('close');
    await vi.waitFor(() => {
      expect(onShutdown).toHaveBeenCalledTimes(1);
    });

    expect(onShutdown.mock.calls[0]?.[0]?.reason).toBe('stdin-end');
  });

  it('shuts down cleanly even if stdin closes before a server is registered', async () => {
    const processRef = new TestProcess();
    const onShutdown = vi.fn().mockResolvedValue(undefined);
    const coordinator = createMcpLifecycleCoordinator({
      commandExecutor: createMockExecutor({ output: '' }),
      processRef,
      onShutdown,
    });

    coordinator.attachProcessHandlers();
    processRef.stdin.emit('close');
    await vi.waitFor(() => {
      expect(onShutdown).toHaveBeenCalledTimes(1);
    });

    expect(onShutdown.mock.calls[0]?.[0]?.server).toBe(null);
  });

  it('maps unhandled rejections to crash shutdowns', async () => {
    const processRef = new TestProcess();
    const onShutdown = vi.fn().mockResolvedValue(undefined);
    const coordinator = createMcpLifecycleCoordinator({
      commandExecutor: createMockExecutor({ output: '' }),
      processRef,
      onShutdown,
    });

    coordinator.attachProcessHandlers();
    processRef.emit('unhandledRejection', new Error('boom'));
    await vi.waitFor(() => {
      expect(onShutdown).toHaveBeenCalledTimes(1);
    });

    expect(onShutdown.mock.calls[0]?.[0]?.reason).toBe('unhandled-rejection');
  });

  it('terminates live local OSLog sessions on process exit', async () => {
    const processRef = new TestProcess();
    const onShutdown = vi.fn().mockResolvedValue(undefined);
    const child = createTrackedChild(555);
    await registerSimulatorLaunchOsLogSession({
      process: child,
      simulatorUuid: 'sim-1',
      bundleId: 'io.sentry.app',
      logFilePath: '/tmp/app.log',
    });
    const coordinator = createMcpLifecycleCoordinator({
      commandExecutor: createMockExecutor({ output: '' }),
      processRef,
      onShutdown,
    });

    coordinator.attachProcessHandlers();
    processRef.emit('exit');

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(onShutdown).not.toHaveBeenCalled();
  });

  it('maps broken stdout pipes to shutdowns', async () => {
    const suppressSpy = vi
      .spyOn(shutdownState, 'suppressProcessStdioWrites')
      .mockImplementation(() => undefined);
    const processRef = new TestProcess();
    const onShutdown = vi.fn().mockResolvedValue(undefined);
    const coordinator = createMcpLifecycleCoordinator({
      commandExecutor: createMockExecutor({ output: '' }),
      processRef,
      onShutdown,
    });

    coordinator.attachProcessHandlers();
    processRef.stdout.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' }));
    await vi.waitFor(() => {
      expect(onShutdown).toHaveBeenCalledTimes(1);
    });

    expect(onShutdown.mock.calls[0]?.[0]?.reason).toBe('stdout-error');
    expect(suppressSpy).toHaveBeenCalledTimes(1);
  });

  it('maps broken stderr pipes to shutdowns', async () => {
    const processRef = new TestProcess();
    const onShutdown = vi.fn().mockResolvedValue(undefined);
    const suppressSpy = vi
      .spyOn(shutdownState, 'suppressProcessStdioWrites')
      .mockImplementation(() => undefined);
    const coordinator = createMcpLifecycleCoordinator({
      commandExecutor: createMockExecutor({ output: '' }),
      processRef,
      onShutdown,
    });

    coordinator.attachProcessHandlers();
    processRef.stderr.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' }));
    await vi.waitFor(() => {
      expect(onShutdown).toHaveBeenCalledTimes(1);
    });

    expect(onShutdown.mock.calls[0]?.[0]?.reason).toBe('stderr-error');
    expect(suppressSpy).toHaveBeenCalledTimes(1);
  });
});

describe('mcp lifecycle snapshot', () => {
  beforeEach(async () => {
    registryDir = mkdtempSync(path.join(tmpdir(), 'mobilebuildmcp-mcp-lifecycle-'));
    setSimulatorLaunchOsLogRegistryDirOverrideForTests(registryDir);
    setRuntimeInstanceForTests({
      instanceId: 'mcp-lifecycle-test',
      pid: process.pid,
      workspaceKey: 'workspace-a',
    });
    setSimulatorLaunchOsLogRecordActiveOverrideForTests(async () => true);
    await clearAllSimulatorLaunchOsLogSessionsForTests();
  });

  afterEach(async () => {
    await clearAllSimulatorLaunchOsLogSessionsForTests();
    setSimulatorLaunchOsLogRecordActiveOverrideForTests(null);
    setRuntimeInstanceForTests(null);
    setSimulatorLaunchOsLogRegistryDirOverrideForTests(null);
    await rm(registryDir, { recursive: true, force: true });
  });

  it('classifies peer-count and memory anomalies', () => {
    expect(
      classifyMcpLifecycleAnomalies({
        uptimeMs: 10 * 60 * 1000,
        rssBytes: 600 * 1024 * 1024,
        matchingMcpProcessCount: 4,
        matchingMcpPeerSummary: [{ pid: 11, ageSeconds: 180, rssKb: 1000 }],
      }),
    ).toEqual(['high-rss', 'long-lived-high-rss', 'peer-age-high', 'peer-count-high']);
  });

  it('samples matching MCP peer processes from ps output', async () => {
    vi.spyOn(process, 'memoryUsage').mockReturnValue({
      rss: 64 * 1024 * 1024,
      heapTotal: 8,
      heapUsed: 4,
      external: 0,
      arrayBuffers: 0,
    });
    const startedAtMs = Date.now() - 1000;

    const snapshot = await buildMcpLifecycleSnapshot({
      phase: 'running',
      shutdownReason: null,
      startedAtMs,
      commandExecutor: createMockExecutor({
        output: [
          `${process.pid} 00:05 65536 node /tmp/build/cli.js mcp`,
          `999 03:00 1024 node /tmp/build/cli.js mcp`,
          `321 00:07 2048 node /tmp/build/cli.js daemon`,
        ].join('\n'),
      }),
    });

    expect(snapshot.matchingMcpProcessCount).toBe(2);
    expect(snapshot.matchingMcpPeerSummary).toEqual([{ pid: 999, ageSeconds: 180, rssKb: 1024 }]);
    expect(snapshot.ppid).toBe(process.ppid);
    expect(snapshot.orphaned).toBe(process.ppid === 1);
    expect(snapshot.simulatorLaunchOsLogSessionCount).toBe(0);
    expect(snapshot.ownedSimulatorLaunchOsLogSessionCount).toBe(0);
    expect(snapshot.anomalies).toEqual(['peer-age-high']);
  });

  it('reports tracked simulator launch OSLog session counts', async () => {
    await registerSimulatorLaunchOsLogSession({
      process: createTrackedChild(888),
      simulatorUuid: 'sim-1',
      bundleId: 'io.sentry.app',
      logFilePath: '/tmp/app.log',
    });

    const snapshot = await buildMcpLifecycleSnapshot({
      phase: 'running',
      shutdownReason: null,
      startedAtMs: Date.now() - 1000,
      commandExecutor: createMockExecutor({ output: '' }),
    });

    expect(snapshot.simulatorLaunchOsLogSessionCount).toBe(1);
    expect(snapshot.ownedSimulatorLaunchOsLogSessionCount).toBe(1);
  });

  it('classifies transport disconnect reasons', () => {
    expect(isTransportDisconnectReason('stdin-end')).toBe(true);
    expect(isTransportDisconnectReason('stdin-close')).toBe(true);
    expect(isTransportDisconnectReason('stdout-error')).toBe(true);
    expect(isTransportDisconnectReason('stderr-error')).toBe(true);
    expect(isTransportDisconnectReason('idle-timeout')).toBe(false);
    expect(isTransportDisconnectReason('sigterm')).toBe(false);
  });
});
