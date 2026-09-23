import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonRegistryEntry } from '../../daemon/daemon-registry.ts';

const originalEntry: DaemonRegistryEntry = {
  workspaceKey: 'workspace-a',
  workspaceRoot: '/workspaces/workspace-a',
  socketPath: '/tmp/mobilebuildmcp-daemon.sock',
  pid: 123_456,
  startedAt: '2026-05-05T00:00:00.000Z',
  enabledWorkflows: ['build'],
  version: '1.0.0',
  instanceId: 'daemon-instance-a',
};

const changedEntry: DaemonRegistryEntry = {
  ...originalEntry,
  instanceId: 'daemon-instance-b',
};

const registryMocks = vi.hoisted(() => ({
  cleanupWorkspaceDaemonFiles: vi.fn(),
  findDaemonRegistryEntryBySocketPath: vi.fn(),
  isPidAlive: vi.fn(),
  readDaemonRegistryEntry: vi.fn(),
  release: vi.fn(),
}));

vi.mock('../../daemon/daemon-registry.ts', () => ({
  acquireDaemonRegistryMutationLock: vi.fn(() => ({
    workspaceKey: 'workspace-a',
    release: registryMocks.release,
  })),
  cleanupWorkspaceDaemonFiles: registryMocks.cleanupWorkspaceDaemonFiles,
  findDaemonRegistryEntryBySocketPath: registryMocks.findDaemonRegistryEntryBySocketPath,
  readDaemonRegistryEntry: registryMocks.readDaemonRegistryEntry,
}));

vi.mock('../../utils/process-liveness.ts', () => ({
  isPidAlive: registryMocks.isPidAlive,
}));

import { forceStopDaemon } from '../daemon-control.ts';

describe('daemon control force-stop registry races', () => {
  beforeEach(() => {
    registryMocks.cleanupWorkspaceDaemonFiles.mockReset();
    registryMocks.findDaemonRegistryEntryBySocketPath.mockReset();
    registryMocks.isPidAlive.mockReset();
    registryMocks.readDaemonRegistryEntry.mockReset();
    registryMocks.release.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends the initial signal before releasing the registry mutation lock', async () => {
    registryMocks.findDaemonRegistryEntryBySocketPath.mockReturnValue(originalEntry);
    registryMocks.readDaemonRegistryEntry.mockReturnValue(originalEntry);
    registryMocks.isPidAlive.mockReturnValue(false);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      expect(registryMocks.release).not.toHaveBeenCalled();
      return true;
    });

    await forceStopDaemon(originalEntry.socketPath);

    expect(kill).toHaveBeenCalledWith(originalEntry.pid, 'SIGTERM');
    expect(registryMocks.release).toHaveBeenCalledOnce();
    expect(registryMocks.cleanupWorkspaceDaemonFiles).toHaveBeenCalledWith(
      originalEntry.workspaceKey,
      {
        pid: originalEntry.pid,
        socketPath: originalEntry.socketPath,
        instanceId: originalEntry.instanceId,
        allowLiveOwner: true,
      },
    );
  });

  it('does not signal when daemon metadata changes before the initial signal', async () => {
    registryMocks.findDaemonRegistryEntryBySocketPath.mockReturnValue(originalEntry);
    registryMocks.readDaemonRegistryEntry.mockReturnValue(changedEntry);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);

    await expect(forceStopDaemon(originalEntry.socketPath)).rejects.toThrow(
      'daemon registry metadata changed',
    );

    expect(kill).not.toHaveBeenCalled();
    expect(registryMocks.cleanupWorkspaceDaemonFiles).not.toHaveBeenCalled();
    expect(registryMocks.release).toHaveBeenCalledOnce();
  });
});
