import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  listSimulatorLaunchOsLogProtectedPaths,
  listSimulatorLaunchOsLogRegistryRecords,
  removeSimulatorLaunchOsLogRegistryRecord,
  setSimulatorLaunchOsLogRecordActiveOverrideForTests,
  setSimulatorLaunchOsLogRegistryDirForTests,
  writeSimulatorLaunchOsLogRegistryRecord,
  type SimulatorLaunchOsLogRegistryRecord,
} from '../log-capture/simulator-launch-oslog-registry.ts';
import {
  getWorkspaceFilesystemLayout,
  setMobileBuildMCPAppDirOverrideForTests,
} from '../log-paths.ts';

let registryDir: string;
let appDir: string;

function createRecord(
  overrides: Partial<SimulatorLaunchOsLogRegistryRecord> = {},
): SimulatorLaunchOsLogRegistryRecord {
  return {
    sessionId: 'session-1',
    owner: { instanceId: 'instance-1', pid: 1234, workspaceKey: 'workspace-a' },
    simulatorUuid: 'sim-1',
    bundleId: 'io.sentry.app',
    helperPid: process.pid,
    logFilePath: '/tmp/app.log',
    startedAtMs: 100,
    expectedCommandParts: ['node'],
    ...overrides,
  };
}

describe.sequential('simulator launch OSLog registry', () => {
  beforeEach(() => {
    registryDir = mkdtempSync(path.join(tmpdir(), 'mobilebuildmcp-oslog-registry-'));
    appDir = mkdtempSync(path.join(tmpdir(), 'mobilebuildmcp-oslog-app-'));
    setSimulatorLaunchOsLogRegistryDirForTests(registryDir);
    setMobileBuildMCPAppDirOverrideForTests(appDir);
    setSimulatorLaunchOsLogRecordActiveOverrideForTests(async (record) => {
      return record.helperPid === process.pid && record.expectedCommandParts.includes('node');
    });
  });

  afterEach(async () => {
    setSimulatorLaunchOsLogRecordActiveOverrideForTests(null);
    setSimulatorLaunchOsLogRegistryDirForTests(null);
    setMobileBuildMCPAppDirOverrideForTests(null);
    await rm(registryDir, { recursive: true, force: true });
    await rm(appDir, { recursive: true, force: true });
  });

  it('writes and lists valid records', async () => {
    await writeSimulatorLaunchOsLogRegistryRecord(createRecord());

    await expect(listSimulatorLaunchOsLogRegistryRecords()).resolves.toEqual([
      expect.objectContaining({
        sessionId: 'session-1',
        bundleId: 'io.sentry.app',
        helperPid: process.pid,
      }),
    ]);
  });

  it('writes new records under workspace state when no test registry override is set', async () => {
    setSimulatorLaunchOsLogRegistryDirForTests(null);

    await writeSimulatorLaunchOsLogRegistryRecord(createRecord());

    const workspaceRecordPath = path.join(
      getWorkspaceFilesystemLayout('workspace-a').simulatorLaunchOsLogRegistryDir,
      'session-1.json',
    );
    expect(existsSync(workspaceRecordPath)).toBe(true);
  });

  it('lists current workspace records while excluding other workspace state', async () => {
    setSimulatorLaunchOsLogRegistryDirForTests(null);
    await writeSimulatorLaunchOsLogRegistryRecord(createRecord({ sessionId: 'workspace-current' }));
    await writeSimulatorLaunchOsLogRegistryRecord(
      createRecord({
        sessionId: 'workspace-other',
        owner: { instanceId: 'instance-2', pid: 1235, workspaceKey: 'workspace-b' },
      }),
    );

    await expect(
      listSimulatorLaunchOsLogRegistryRecords({ workspaceKey: 'workspace-a' }),
    ).resolves.toEqual([expect.objectContaining({ sessionId: 'workspace-current' })]);
  });

  it('removes only the requested workspace record', async () => {
    setSimulatorLaunchOsLogRegistryDirForTests(null);
    await writeSimulatorLaunchOsLogRegistryRecord(createRecord({ sessionId: 'same-session' }));
    await writeSimulatorLaunchOsLogRegistryRecord(
      createRecord({
        sessionId: 'same-session',
        owner: { instanceId: 'instance-2', pid: 1235, workspaceKey: 'workspace-b' },
      }),
    );

    await removeSimulatorLaunchOsLogRegistryRecord({
      sessionId: 'same-session',
      workspaceKey: 'workspace-a',
    });

    expect(
      existsSync(
        path.join(
          getWorkspaceFilesystemLayout('workspace-a').simulatorLaunchOsLogRegistryDir,
          'same-session.json',
        ),
      ),
    ).toBe(false);
    expect(
      existsSync(
        path.join(
          getWorkspaceFilesystemLayout('workspace-b').simulatorLaunchOsLogRegistryDir,
          'same-session.json',
        ),
      ),
    ).toBe(true);
  });

  it('prunes malformed registry files', async () => {
    writeFileSync(path.join(registryDir, 'broken.json'), '{not-json');

    await expect(listSimulatorLaunchOsLogRegistryRecords()).resolves.toEqual([]);
  });

  it('lists protected log paths without mutating registry files', async () => {
    const brokenPath = path.join(registryDir, 'broken.json');
    const staleRecordPath = path.join(registryDir, 'stale.json');
    writeFileSync(brokenPath, '{not-json');
    writeFileSync(
      staleRecordPath,
      `${JSON.stringify(createRecord({ sessionId: 'stale', helperPid: 999999 }))}\n`,
    );
    await writeSimulatorLaunchOsLogRegistryRecord(
      createRecord({ sessionId: 'active', logFilePath: '/tmp/active.log' }),
    );

    await expect(listSimulatorLaunchOsLogProtectedPaths()).resolves.toEqual(
      new Set(['/tmp/active.log']),
    );
    expect(existsSync(brokenPath)).toBe(true);
    expect(existsSync(staleRecordPath)).toBe(true);
  });

  it('prunes records without owner workspace keys', async () => {
    const missingWorkspaceRecord = createRecord();
    writeFileSync(
      path.join(registryDir, 'missing-workspace.json'),
      `${JSON.stringify({
        ...missingWorkspaceRecord,
        owner: { instanceId: 'instance-1', pid: 1234 },
      })}\n`,
    );

    await expect(listSimulatorLaunchOsLogRegistryRecords()).resolves.toEqual([]);
  });

  it('does not require registry version fields', async () => {
    await writeSimulatorLaunchOsLogRegistryRecord(createRecord());

    await expect(listSimulatorLaunchOsLogRegistryRecords()).resolves.toEqual([
      expect.objectContaining({ sessionId: 'session-1' }),
    ]);
  });

  it('prunes stale records whose process is gone', async () => {
    await writeSimulatorLaunchOsLogRegistryRecord(
      createRecord({ sessionId: 'stale', helperPid: 999999, expectedCommandParts: ['simctl'] }),
    );

    await expect(listSimulatorLaunchOsLogRegistryRecords()).resolves.toEqual([]);
  });

  it('prunes records whose pid command no longer matches the expected helper', async () => {
    await writeSimulatorLaunchOsLogRegistryRecord(
      createRecord({
        sessionId: 'mismatch',
        expectedCommandParts: ['definitely-not-this-command'],
      }),
    );

    await expect(listSimulatorLaunchOsLogRegistryRecords()).resolves.toEqual([]);
  });
});
