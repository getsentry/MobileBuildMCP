import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { forceStopDaemon } from '../daemon-control.ts';
import {
  readDaemonRegistryEntry,
  type DaemonRegistryEntry,
  writeDaemonRegistryEntry,
} from '../../daemon/daemon-registry.ts';
import {
  daemonDirForWorkspaceKey,
  setDaemonRunDirOverrideForTests,
} from '../../daemon/socket-path.ts';
import { setMobileBuildMCPAppDirOverrideForTests } from '../../utils/log-paths.ts';

const daemonPid = 123_456;

function createMissingPidError(): NodeJS.ErrnoException {
  const error = new Error('no such process') as NodeJS.ErrnoException;
  error.code = 'ESRCH';
  return error;
}

function createEntry(overrides: Partial<DaemonRegistryEntry> = {}): DaemonRegistryEntry {
  const workspaceKey = overrides.workspaceKey ?? 'workspace-a';
  return {
    workspaceKey,
    workspaceRoot: `/workspaces/${workspaceKey}`,
    socketPath: path.join(daemonDirForWorkspaceKey(workspaceKey), 'd.sock'),
    pid: daemonPid,
    startedAt: '2026-05-05T00:00:00.000Z',
    enabledWorkflows: ['build'],
    version: '1.0.0',
    instanceId: 'daemon-instance-a',
    ...overrides,
  };
}

describe('daemon control', () => {
  let appDir: string;
  let daemonRunDir: string;

  beforeEach(() => {
    appDir = mkdtempSync(path.join(tmpdir(), 'mobilebuildmcp-daemon-control-app-'));
    daemonRunDir = mkdtempSync(path.join(tmpdir(), 'mobilebuildmcp-daemon-control-run-'));
    setMobileBuildMCPAppDirOverrideForTests(appDir);
    setDaemonRunDirOverrideForTests(daemonRunDir);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    setMobileBuildMCPAppDirOverrideForTests(null);
    setDaemonRunDirOverrideForTests(null);
    rmSync(appDir, { recursive: true, force: true });
    rmSync(daemonRunDir, { recursive: true, force: true });
  });

  it('does not unlink sockets without registry metadata', async () => {
    const socketPath = path.join(daemonRunDir, 'missing-registry.sock');
    mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
    writeFileSync(socketPath, 'socket placeholder');

    await expect(forceStopDaemon(socketPath)).rejects.toThrow('registry metadata is missing');

    expect(existsSync(socketPath)).toBe(true);
  });

  it('unregisters daemon files only after SIGTERM stops the process', async () => {
    const entry = createEntry();
    writeDaemonRegistryEntry(entry);
    mkdirSync(path.dirname(entry.socketPath), { recursive: true, mode: 0o700 });
    writeFileSync(entry.socketPath, 'socket placeholder');
    let alive = true;
    const kill = vi.spyOn(process, 'kill').mockImplementation(((
      _pid: number,
      signal?: string | number,
    ) => {
      if (signal === 0) {
        if (alive) {
          return true;
        }
        throw createMissingPidError();
      }
      if (signal === 'SIGTERM') {
        alive = false;
      }
      return true;
    }) as typeof process.kill);

    await forceStopDaemon(entry.socketPath);

    expect(kill).toHaveBeenCalledWith(entry.pid, 'SIGTERM');
    expect(readDaemonRegistryEntry(entry.workspaceKey)).toBeNull();
    expect(existsSync(entry.socketPath)).toBe(false);
  });

  it('cleans daemon files when the stopped PID is reused before cleanup', async () => {
    const entry = createEntry();
    writeDaemonRegistryEntry(entry);
    mkdirSync(path.dirname(entry.socketPath), { recursive: true, mode: 0o700 });
    writeFileSync(entry.socketPath, 'socket placeholder');
    let zeroSignalChecksAfterTerm = 0;
    const kill = vi.spyOn(process, 'kill').mockImplementation(((
      _pid: number,
      signal?: string | number,
    ) => {
      if (signal === 0) {
        zeroSignalChecksAfterTerm += 1;
        if (zeroSignalChecksAfterTerm === 1) {
          throw createMissingPidError();
        }
        return true;
      }
      return true;
    }) as typeof process.kill);

    await forceStopDaemon(entry.socketPath);

    expect(kill).toHaveBeenCalledWith(entry.pid, 'SIGTERM');
    expect(readDaemonRegistryEntry(entry.workspaceKey)).toBeNull();
    expect(existsSync(entry.socketPath)).toBe(false);
  });

  it('uses SIGKILL when the process stays alive after SIGTERM', async () => {
    vi.useFakeTimers();
    const entry = createEntry();
    writeDaemonRegistryEntry(entry);
    mkdirSync(path.dirname(entry.socketPath), { recursive: true, mode: 0o700 });
    writeFileSync(entry.socketPath, 'socket placeholder');
    let alive = true;
    const kill = vi.spyOn(process, 'kill').mockImplementation(((
      _pid: number,
      signal?: string | number,
    ) => {
      if (signal === 0) {
        if (alive) {
          return true;
        }
        throw createMissingPidError();
      }
      if (signal === 'SIGKILL') {
        alive = false;
      }
      return true;
    }) as typeof process.kill);

    const stopped = forceStopDaemon(entry.socketPath);
    await vi.advanceTimersByTimeAsync(1500);
    await stopped;

    expect(kill).toHaveBeenCalledWith(entry.pid, 'SIGTERM');
    expect(kill).toHaveBeenCalledWith(entry.pid, 'SIGKILL');
    expect(readDaemonRegistryEntry(entry.workspaceKey)).toBeNull();
    expect(existsSync(entry.socketPath)).toBe(false);
  });

  it('preserves registry metadata and socket when the process remains alive', async () => {
    vi.useFakeTimers();
    const entry = createEntry();
    writeDaemonRegistryEntry(entry);
    mkdirSync(path.dirname(entry.socketPath), { recursive: true, mode: 0o700 });
    writeFileSync(entry.socketPath, 'socket placeholder');
    vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);

    const stopped = forceStopDaemon(entry.socketPath);
    const stoppedExpectation = expect(stopped).rejects.toThrow(
      `Daemon PID ${entry.pid} did not exit after SIGKILL`,
    );
    await vi.advanceTimersByTimeAsync(3000);

    await stoppedExpectation;
    expect(readDaemonRegistryEntry(entry.workspaceKey)).toEqual(entry);
    expect(existsSync(entry.socketPath)).toBe(true);
  });
});
