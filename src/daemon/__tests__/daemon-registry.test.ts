import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  acquireDaemonRegistryMutationLock,
  cleanupWorkspaceDaemonFiles,
  findDaemonRegistryEntryBySocketPath,
  listDaemonRegistryEntries,
  readDaemonRegistryEntry,
  type DaemonRegistryEntry,
  writeDaemonRegistryEntry,
} from '../daemon-registry.ts';
import {
  daemonDirForWorkspaceKey,
  logPathForWorkspaceKey,
  registryPathForWorkspaceKey,
  setDaemonRunDirOverrideForTests,
} from '../socket-path.ts';
import { setMobileBuildMCPAppDirOverrideForTests } from '../../utils/log-paths.ts';

const stalePid = 999_999_999;

function createEntry(overrides: Partial<DaemonRegistryEntry> = {}): DaemonRegistryEntry {
  const workspaceKey = overrides.workspaceKey ?? 'workspace-a';
  return {
    workspaceKey,
    workspaceRoot: `/workspaces/${workspaceKey}`,
    socketPath: path.join(daemonDirForWorkspaceKey(workspaceKey), 'd.sock'),
    pid: stalePid,
    startedAt: '2026-05-02T00:00:00.000Z',
    enabledWorkflows: ['build'],
    version: '1.0.0',
    ...overrides,
  };
}

describe('daemon registry', () => {
  let appDir: string;
  let daemonRunDir: string;

  beforeEach(() => {
    appDir = mkdtempSync(path.join(tmpdir(), 'mobilebuildmcp-daemon-registry-app-'));
    daemonRunDir = mkdtempSync(path.join(tmpdir(), 'mobilebuildmcp-daemon-registry-run-'));
    setMobileBuildMCPAppDirOverrideForTests(appDir);
    setDaemonRunDirOverrideForTests(daemonRunDir);
  });

  afterEach(() => {
    setMobileBuildMCPAppDirOverrideForTests(null);
    setDaemonRunDirOverrideForTests(null);
    rmSync(appDir, { recursive: true, force: true });
    rmSync(daemonRunDir, { recursive: true, force: true });
  });

  it('writes daemon metadata under workspace state and places the socket in temp runtime storage', () => {
    const entry = createEntry();

    writeDaemonRegistryEntry(entry);

    const expectedRegistryPath = path.join(
      appDir,
      'workspaces',
      'workspace-a',
      'state',
      'daemon',
      'daemon.json',
    );
    expect(registryPathForWorkspaceKey('workspace-a')).toBe(expectedRegistryPath);
    expect(readDaemonRegistryEntry('workspace-a')).toEqual(entry);
    expect(existsSync(expectedRegistryPath)).toBe(true);
    expect(entry.socketPath).toBe(path.join(daemonRunDir, 'mobilebuildmcp-0dcf2d98505d', 'd.sock'));
    expect(logPathForWorkspaceKey('workspace-a')).toBe(
      path.join(appDir, 'workspaces', 'workspace-a', 'logs', 'daemon.log'),
    );

    const raw = readFileSync(expectedRegistryPath, 'utf8');
    expect(JSON.parse(raw)).toEqual(entry);
  });

  it('returns null when workspace metadata is invalid', () => {
    const registryPath = registryPathForWorkspaceKey('workspace-a');
    mkdirSync(path.dirname(registryPath), { recursive: true, mode: 0o700 });
    writeFileSync(registryPath, '{invalid json');

    expect(readDaemonRegistryEntry('workspace-a')).toBeNull();
  });

  it('rejects workspace metadata stored under the wrong workspace key', () => {
    const mismatchedEntry = createEntry({ workspaceKey: 'workspace-b', version: 'wrong' });

    const registryPath = registryPathForWorkspaceKey('workspace-a');
    mkdirSync(path.dirname(registryPath), { recursive: true, mode: 0o700 });
    writeFileSync(registryPath, `${JSON.stringify(mismatchedEntry, null, 2)}\n`, { mode: 0o600 });

    expect(readDaemonRegistryEntry('workspace-a')).toBeNull();
  });

  it('lists workspace metadata', () => {
    const workspaceEntry = createEntry({ workspaceKey: 'workspace-a', version: 'workspace' });

    writeDaemonRegistryEntry(workspaceEntry);

    expect(listDaemonRegistryEntries()).toEqual(expect.arrayContaining([workspaceEntry]));
  });

  it('finds registry metadata by custom socket path', () => {
    const entry = createEntry({ socketPath: path.join(daemonRunDir, 'custom.sock') });

    writeDaemonRegistryEntry(entry);

    expect(findDaemonRegistryEntryBySocketPath(entry.socketPath)).toEqual(entry);
  });

  it('does not clean up live mismatched metadata or sockets', () => {
    const entry = createEntry({ pid: process.pid });
    writeDaemonRegistryEntry(entry);
    mkdirSync(path.dirname(entry.socketPath), { recursive: true, mode: 0o700 });
    writeFileSync(entry.socketPath, 'socket placeholder');

    cleanupWorkspaceDaemonFiles(entry.workspaceKey, {
      pid: process.pid + 1,
      socketPath: entry.socketPath,
      allowLiveOwner: true,
    });

    expect(readDaemonRegistryEntry(entry.workspaceKey)).toEqual(entry);
    expect(existsSync(entry.socketPath)).toBe(true);
  });

  it('cleans up current-owned workspace metadata and socket with matching instance identity', () => {
    const entry = createEntry({ pid: process.pid, instanceId: 'daemon-instance-a' });
    writeDaemonRegistryEntry(entry);
    mkdirSync(path.dirname(entry.socketPath), { recursive: true, mode: 0o700 });
    writeFileSync(entry.socketPath, 'socket placeholder');

    cleanupWorkspaceDaemonFiles(entry.workspaceKey, {
      pid: process.pid,
      socketPath: entry.socketPath,
      instanceId: 'daemon-instance-a',
      allowLiveOwner: true,
    });

    expect(readDaemonRegistryEntry(entry.workspaceKey)).toBeNull();
    expect(existsSync(entry.socketPath)).toBe(false);
  });

  it('does not clean up live metadata when instance identity is missing', () => {
    const entry = createEntry({ pid: process.pid, instanceId: 'daemon-instance-a' });
    writeDaemonRegistryEntry(entry);
    mkdirSync(path.dirname(entry.socketPath), { recursive: true, mode: 0o700 });
    writeFileSync(entry.socketPath, 'socket placeholder');

    cleanupWorkspaceDaemonFiles(entry.workspaceKey, {
      pid: process.pid,
      socketPath: entry.socketPath,
      allowLiveOwner: true,
    });

    expect(readDaemonRegistryEntry(entry.workspaceKey)).toEqual(entry);
    expect(existsSync(entry.socketPath)).toBe(true);
  });

  it('does not live-clean legacy metadata without instance identity', () => {
    const entry = createEntry({ pid: process.pid });
    writeDaemonRegistryEntry(entry);
    mkdirSync(path.dirname(entry.socketPath), { recursive: true, mode: 0o700 });
    writeFileSync(entry.socketPath, 'socket placeholder');

    cleanupWorkspaceDaemonFiles(entry.workspaceKey, {
      pid: process.pid,
      socketPath: entry.socketPath,
      allowLiveOwner: true,
    });

    expect(readDaemonRegistryEntry(entry.workspaceKey)).toEqual(entry);
    expect(existsSync(entry.socketPath)).toBe(true);
  });

  it('throws and preserves files while another daemon registry mutation holds the workspace lock', () => {
    const entry = createEntry();
    writeDaemonRegistryEntry(entry);
    mkdirSync(path.dirname(entry.socketPath), { recursive: true, mode: 0o700 });
    writeFileSync(entry.socketPath, 'socket placeholder');
    const lock = acquireDaemonRegistryMutationLock(entry.workspaceKey);
    expect(lock).not.toBeNull();

    try {
      expect(() =>
        cleanupWorkspaceDaemonFiles(entry.workspaceKey, {
          socketPath: entry.socketPath,
        }),
      ).toThrow(`Unable to acquire daemon registry lock for ${entry.workspaceKey}`);

      expect(readDaemonRegistryEntry(entry.workspaceKey)).toEqual(entry);
      expect(existsSync(entry.socketPath)).toBe(true);
    } finally {
      lock?.release();
    }
  });

  it('recovers an expired ownerless daemon registry lock', () => {
    const lockDir = path.join(appDir, 'workspaces', 'workspace-a', 'locks', 'daemon-registry.lock');
    mkdirSync(lockDir, { recursive: true });
    const staleDate = new Date(Date.now() - 60_000);
    utimesSync(lockDir, staleDate, staleDate);

    const lock = acquireDaemonRegistryMutationLock('workspace-a');

    expect(lock).not.toBeNull();
    lock?.release();
  });

  it('recovers an expired malformed daemon registry lock', () => {
    const lockDir = path.join(appDir, 'workspaces', 'workspace-a', 'locks', 'daemon-registry.lock');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(path.join(lockDir, 'owner.json'), '{not-json');
    const staleDate = new Date(Date.now() - 60_000);
    utimesSync(lockDir, staleDate, staleDate);

    const lock = acquireDaemonRegistryMutationLock('workspace-a');

    expect(lock).not.toBeNull();
    lock?.release();
  });

  it('recovers an expired daemon registry lock owned by a dead pid', () => {
    const lockDir = path.join(appDir, 'workspaces', 'workspace-a', 'locks', 'daemon-registry.lock');
    mkdirSync(lockDir, { recursive: true });
    const now = Date.now();
    writeFileSync(
      path.join(lockDir, 'owner.json'),
      `${JSON.stringify({
        token: 'stale-token',
        pid: stalePid,
        purpose: 'daemon-registry',
        acquiredAtMs: now - 60_000,
        expiresAtMs: now - 30_000,
      })}\n`,
    );

    const lock = acquireDaemonRegistryMutationLock('workspace-a');

    expect(lock).not.toBeNull();
    lock?.release();
  });

  it('does not unlink replacement daemon metadata or socket during old-owner cleanup', () => {
    const oldEntry = createEntry({
      pid: stalePid,
      startedAt: '2026-05-02T00:00:00.000Z',
      instanceId: 'old-instance',
    });
    const replacementEntry = createEntry({
      pid: process.pid,
      startedAt: '2026-05-02T00:01:00.000Z',
      instanceId: 'replacement-instance',
    });
    writeDaemonRegistryEntry(oldEntry);
    writeDaemonRegistryEntry(replacementEntry);
    mkdirSync(path.dirname(replacementEntry.socketPath), { recursive: true, mode: 0o700 });
    writeFileSync(replacementEntry.socketPath, 'replacement socket placeholder');

    cleanupWorkspaceDaemonFiles(oldEntry.workspaceKey, {
      pid: oldEntry.pid,
      socketPath: oldEntry.socketPath,
      instanceId: oldEntry.instanceId,
      allowLiveOwner: true,
    });

    expect(readDaemonRegistryEntry(replacementEntry.workspaceKey)).toEqual(replacementEntry);
    expect(existsSync(replacementEntry.socketPath)).toBe(true);
  });

  it('cleans up the registry-owned socket when no socket path is provided', () => {
    const entry = createEntry({ socketPath: path.join(daemonRunDir, 'custom.sock') });
    writeDaemonRegistryEntry(entry);
    mkdirSync(path.dirname(entry.socketPath), { recursive: true, mode: 0o700 });
    writeFileSync(entry.socketPath, 'socket placeholder');

    cleanupWorkspaceDaemonFiles(entry.workspaceKey);

    expect(existsSync(registryPathForWorkspaceKey(entry.workspaceKey))).toBe(false);
    expect(existsSync(entry.socketPath)).toBe(false);
  });

  it('cleans up stale matching workspace metadata and socket', () => {
    const entry = createEntry();
    writeDaemonRegistryEntry(entry);
    mkdirSync(path.dirname(entry.socketPath), { recursive: true, mode: 0o700 });
    writeFileSync(entry.socketPath, 'socket placeholder');

    cleanupWorkspaceDaemonFiles(entry.workspaceKey, {
      socketPath: entry.socketPath,
    });

    expect(existsSync(registryPathForWorkspaceKey(entry.workspaceKey))).toBe(false);
    expect(existsSync(entry.socketPath)).toBe(false);
  });
});
