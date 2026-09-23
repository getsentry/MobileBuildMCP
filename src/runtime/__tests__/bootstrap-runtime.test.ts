import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';

const { scheduleSimulatorDefaultsRefreshMock } = vi.hoisted(() => ({
  scheduleSimulatorDefaultsRefreshMock: vi.fn(),
}));

vi.mock('../../utils/simulator-defaults-refresh.ts', () => ({
  scheduleSimulatorDefaultsRefresh: scheduleSimulatorDefaultsRefreshMock,
}));

import { bootstrapRuntime, type RuntimeKind } from '../bootstrap-runtime.ts';
import { __resetConfigStoreForTests } from '../../utils/config-store.ts';
import { sessionStore } from '../../utils/session-store.ts';
import { createMockFileSystemExecutor } from '../../test-utils/mock-executors.ts';
import { getRuntimeInstance, setRuntimeInstanceForTests } from '../../utils/runtime-instance.ts';
import { workspaceKeyForRoot } from '../../utils/workspace-identity.ts';

const cwd = '/repo';
const configPath = path.join(cwd, '.mobilebuildmcp', 'config.yaml');

function createFsWithSessionDefaults() {
  const yaml = [
    'schemaVersion: 1',
    'sessionDefaults:',
    '  scheme: "AppScheme"',
    '  simulatorId: "SIM-UUID"',
    '  simulatorName: "iPhone 17"',
    '',
  ].join('\n');

  return createMockFileSystemExecutor({
    existsSync: (targetPath: string) => targetPath === configPath,
    readFile: async (targetPath: string) => {
      if (targetPath !== configPath) {
        throw new Error(`Unexpected readFile path: ${targetPath}`);
      }
      return yaml;
    },
  });
}

function createFsWithSchemeOnlySessionDefaults() {
  const yaml = ['schemaVersion: 1', 'sessionDefaults:', '  scheme: "AppScheme"', ''].join('\n');

  return createMockFileSystemExecutor({
    existsSync: (targetPath: string) => targetPath === configPath,
    readFile: async (targetPath: string) => {
      if (targetPath !== configPath) {
        throw new Error(`Unexpected readFile path: ${targetPath}`);
      }
      return yaml;
    },
  });
}

function createFsWithProfiles() {
  const yaml = [
    'schemaVersion: 1',
    'sessionDefaults:',
    '  scheme: "GlobalScheme"',
    'sessionDefaultsProfiles:',
    '  ios:',
    '    scheme: "IOSScheme"',
    '    simulatorName: "iPhone 17"',
    'activeSessionDefaultsProfile: "ios"',
    '',
  ].join('\n');

  return createMockFileSystemExecutor({
    existsSync: (targetPath: string) => targetPath === configPath,
    readFile: async (targetPath: string) => {
      if (targetPath !== configPath) {
        throw new Error(`Unexpected readFile path: ${targetPath}`);
      }
      return yaml;
    },
  });
}

describe('bootstrapRuntime', () => {
  beforeEach(() => {
    __resetConfigStoreForTests();
    sessionStore.clear();
    scheduleSimulatorDefaultsRefreshMock.mockReset();
    scheduleSimulatorDefaultsRefreshMock.mockReturnValue(false);
    setRuntimeInstanceForTests(null);
  });

  it('hydrates session defaults for mcp runtime', async () => {
    const result = await bootstrapRuntime({
      runtime: 'mcp',
      cwd,
      fs: createFsWithSessionDefaults(),
    });

    expect(result.runtime.config.sessionDefaults?.scheme).toBe('AppScheme');
    expect(sessionStore.getAll()).toMatchObject({
      scheme: 'AppScheme',
      simulatorId: 'SIM-UUID',
      simulatorName: 'iPhone 17',
    });
    expect(result.workspaceRoot).toBe(cwd);
    expect(result.workspaceKey).toBe(workspaceKeyForRoot(cwd));
    expect(getRuntimeInstance().workspaceKey).toBe(result.workspaceKey);
    expect(scheduleSimulatorDefaultsRefreshMock).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'startup-hydration',
        persist: false,
        simulatorId: 'SIM-UUID',
        simulatorName: 'iPhone 17',
      }),
    );
  });

  it('hydrates non-simulator session defaults for mcp runtime', async () => {
    const result = await bootstrapRuntime({
      runtime: 'mcp',
      cwd,
      fs: createFsWithSchemeOnlySessionDefaults(),
    });

    expect(result.runtime.config.sessionDefaults?.scheme).toBe('AppScheme');
    expect(sessionStore.getAll()).toMatchObject({
      scheme: 'AppScheme',
    });
    expect(sessionStore.getAll().simulatorId).toBeUndefined();
    expect(sessionStore.getAll().simulatorName).toBeUndefined();
  });

  it.each(['cli', 'daemon'] as const)(
    'does not hydrate session defaults for %s runtime',
    async (runtime: RuntimeKind) => {
      const result = await bootstrapRuntime({ runtime, cwd, fs: createFsWithSessionDefaults() });

      expect(result.runtime.config.sessionDefaults?.scheme).toBe('AppScheme');
      expect(sessionStore.getAll()).toEqual({});
    },
  );

  it('hydrates the active session defaults profile for mcp runtime', async () => {
    await bootstrapRuntime({
      runtime: 'mcp',
      cwd,
      fs: createFsWithProfiles(),
    });

    expect(sessionStore.getActiveProfile()).toBe('ios');
    expect(sessionStore.getAll().scheme).toBe('IOSScheme');
    expect(sessionStore.getAll().simulatorName).toBe('iPhone 17');
  });

  describe('MOBILEBUILDMCP_CWD env override', () => {
    let chdirSpy: ReturnType<typeof vi.spyOn> | null = null;
    let originalEnvValue: string | undefined;

    beforeEach(() => {
      originalEnvValue = process.env.MOBILEBUILDMCP_CWD;
      chdirSpy = vi.spyOn(process, 'chdir').mockImplementation(() => undefined);
    });

    afterEach(() => {
      chdirSpy?.mockRestore();
      chdirSpy = null;
      if (originalEnvValue === undefined) {
        delete process.env.MOBILEBUILDMCP_CWD;
      } else {
        process.env.MOBILEBUILDMCP_CWD = originalEnvValue;
      }
    });

    it('chdirs to env-var value when opts.cwd is undefined', async () => {
      process.env.MOBILEBUILDMCP_CWD = '/explicit/project/dir';
      await bootstrapRuntime({ runtime: 'cli', fs: createFsWithSessionDefaults() });
      expect(chdirSpy).toHaveBeenCalledWith('/explicit/project/dir');
    });

    it('does not chdir when opts.cwd is provided (caller wins)', async () => {
      process.env.MOBILEBUILDMCP_CWD = '/should/be/ignored';
      await bootstrapRuntime({ runtime: 'cli', cwd, fs: createFsWithSessionDefaults() });
      expect(chdirSpy).not.toHaveBeenCalled();
    });

    it('expands a leading ~/ to the home directory', async () => {
      process.env.MOBILEBUILDMCP_CWD = '~/Developer/project';
      await bootstrapRuntime({ runtime: 'cli', fs: createFsWithSessionDefaults() });
      const calledWith = chdirSpy?.mock.calls[0]?.[0] as string;
      expect(calledWith.endsWith('/Developer/project')).toBe(true);
      expect(calledWith.startsWith('~')).toBe(false);
    });

    it('expands a bare ~ to the home directory', async () => {
      process.env.MOBILEBUILDMCP_CWD = '~';
      await bootstrapRuntime({ runtime: 'cli', fs: createFsWithSessionDefaults() });
      expect(chdirSpy).toHaveBeenCalledWith(os.homedir());
    });

    it('falls back gracefully when chdir throws', async () => {
      process.env.MOBILEBUILDMCP_CWD = '/nonexistent';
      chdirSpy?.mockImplementation(() => {
        throw new Error('ENOENT');
      });
      await expect(
        bootstrapRuntime({ runtime: 'cli', fs: createFsWithSessionDefaults() }),
      ).resolves.toBeDefined();
    });

    it('is a no-op when env var is unset', async () => {
      delete process.env.MOBILEBUILDMCP_CWD;
      await bootstrapRuntime({ runtime: 'cli', cwd, fs: createFsWithSessionDefaults() });
      expect(chdirSpy).not.toHaveBeenCalled();
    });
  });
});
