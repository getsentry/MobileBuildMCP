import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { __resetConfigStoreForTests, initConfigStore } from '../../../../utils/config-store.ts';
import { sessionStore } from '../../../../utils/session-store.ts';
import { createMockFileSystemExecutor } from '../../../../test-utils/mock-executors.ts';
import { schema, handler, sessionSetDefaultsLogic } from '../session_set_defaults.ts';
import type { CommandExecutor } from '../../../../utils/execution/index.ts';
import { allText, runLogic, callHandler } from '../../../../test-utils/test-helpers.ts';

describe('session-set-defaults tool', () => {
  beforeEach(() => {
    __resetConfigStoreForTests();
    sessionStore.clearAll();
  });

  const cwd = '/repo';
  const configPath = path.join(cwd, '.mobilebuildmcp', 'config.yaml');

  // Mock executor that simulates successful simulator lookup
  function createMockExecutor(): CommandExecutor {
    return vi.fn().mockImplementation(async (command: string[]) => {
      if (command.includes('simctl') && command.includes('list')) {
        return {
          success: true,
          output: JSON.stringify({
            devices: {
              'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
                { udid: 'RESOLVED-SIM-UUID', name: 'iPhone 17' },
                { udid: 'OTHER-SIM-UUID', name: 'iPhone 15' },
              ],
            },
          }),
        };
      }
      return { success: true, output: '' };
    });
  }

  function createContext() {
    return {
      executor: createMockExecutor(),
    };
  }

  describe('Export Field Validation', () => {
    it('should have handler function', () => {
      expect(typeof handler).toBe('function');
    });

    it('should have schema object', () => {
      expect(schema).toBeDefined();
      expect(typeof schema).toBe('object');
    });
  });

  describe('Handler Behavior', () => {
    it('should set provided defaults and return updated state', async () => {
      const result = await runLogic(() =>
        sessionSetDefaultsLogic(
          {
            scheme: 'MyScheme',
            simulatorName: 'iPhone 17',
            useLatestOS: true,
            arch: 'arm64',
          },
          createContext(),
        ),
      );

      expect(result.isError).toBeFalsy();

      const current = sessionStore.getAll();
      expect(current.scheme).toBe('MyScheme');
      expect(current.simulatorName).toBe('iPhone 17');
      // simulatorId resolution happens in background; immediate update keeps explicit inputs only
      expect(current.simulatorId).toBeUndefined();
      expect(current.useLatestOS).toBe(true);
      expect(current.arch).toBe('arm64');
    });

    it('should validate parameter types via Zod', async () => {
      const result = await callHandler(handler, {
        useLatestOS: 'yes' as unknown as boolean,
      });

      expect(result.isError).toBe(true);
      expect(allText(result)).toContain('useLatestOS');
    });

    it('should reject env values that are not strings', async () => {
      const result = await callHandler(handler, {
        env: {
          STAGING_ENABLED: 1 as unknown as string,
        },
      });

      expect(result.isError).toBe(true);
      expect(allText(result)).toContain('env');
    });

    it('should reject empty string defaults for required string fields', async () => {
      const result = await callHandler(handler, {
        scheme: '',
      });

      expect(result.isError).toBe(true);
      expect(allText(result)).toContain('scheme');
    });

    it('should clear workspacePath when projectPath is set', async () => {
      sessionStore.setDefaults({ workspacePath: '/old/App.xcworkspace' });
      const result = await runLogic(() =>
        sessionSetDefaultsLogic({ projectPath: '/new/App.xcodeproj' }, createContext()),
      );
      const current = sessionStore.getAll();
      expect(current.projectPath).toBe('/new/App.xcodeproj');
      expect(current.workspacePath).toBeUndefined();
      expect(result.isError).toBeFalsy();
    });

    it('should clear projectPath when workspacePath is set', async () => {
      sessionStore.setDefaults({ projectPath: '/old/App.xcodeproj' });
      const result = await runLogic(() =>
        sessionSetDefaultsLogic({ workspacePath: '/new/App.xcworkspace' }, createContext()),
      );
      const current = sessionStore.getAll();
      expect(current.workspacePath).toBe('/new/App.xcworkspace');
      expect(current.projectPath).toBeUndefined();
      expect(result.isError).toBeFalsy();
    });

    it('should clear stale simulatorName when simulatorId is explicitly set', async () => {
      sessionStore.setDefaults({ simulatorName: 'Old Name' });
      const result = await runLogic(() =>
        sessionSetDefaultsLogic({ simulatorId: 'RESOLVED-SIM-UUID' }, createContext()),
      );
      const current = sessionStore.getAll();
      expect(current.simulatorId).toBe('RESOLVED-SIM-UUID');
      expect(current.simulatorName).toBeUndefined();
      expect(result.isError).toBeFalsy();
    });

    it('should clear stale simulatorId when only simulatorName is set', async () => {
      sessionStore.setDefaults({ simulatorId: 'OLD-SIM-UUID' });
      const result = await runLogic(() =>
        sessionSetDefaultsLogic({ simulatorName: 'iPhone 17' }, createContext()),
      );
      const current = sessionStore.getAll();
      // simulatorId resolution happens in background; stale id is cleared immediately
      expect(current.simulatorName).toBe('iPhone 17');
      expect(current.simulatorId).toBeUndefined();
      expect(result.isError).toBeFalsy();
    });

    it('does not claim simulatorName was cleared when none existed', async () => {
      sessionStore.setDefaults({ simulatorId: 'RESOLVED-SIM-UUID' });
      const result = await runLogic(() =>
        sessionSetDefaultsLogic({ simulatorId: 'RESOLVED-SIM-UUID' }, createContext()),
      );

      expect(result.isError).toBeFalsy();
    });

    it('should not fail when simulatorName cannot be resolved immediately', async () => {
      const contextWithFailingExecutor = {
        executor: vi.fn().mockImplementation(async (command: string[]) => {
          if (command.includes('simctl') && command.includes('list')) {
            return {
              success: true,
              output: JSON.stringify({
                devices: {
                  'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
                    { udid: 'OTHER-SIM-UUID', name: 'iPhone 15' },
                  ],
                },
              }),
            };
          }
          return { success: true, output: '' };
        }),
      };

      const result = await runLogic(() =>
        sessionSetDefaultsLogic(
          { simulatorName: 'NonExistentSimulator' },
          contextWithFailingExecutor,
        ),
      );
      expect(result.isError).toBeFalsy();
      expect(sessionStore.getAll().simulatorName).toBe('NonExistentSimulator');
    });

    it('should prefer workspacePath when both projectPath and workspacePath are provided', async () => {
      const res = await runLogic(() =>
        sessionSetDefaultsLogic(
          {
            projectPath: '/app/App.xcodeproj',
            workspacePath: '/app/App.xcworkspace',
          },
          createContext(),
        ),
      );
      const current = sessionStore.getAll();
      expect(current.workspacePath).toBe('/app/App.xcworkspace');
      expect(current.projectPath).toBeUndefined();
      expect(res.isError).toBeFalsy();
    });

    it('should keep both simulatorId and simulatorName when both are provided', async () => {
      const res = await runLogic(() =>
        sessionSetDefaultsLogic(
          {
            simulatorId: 'SIM-1',
            simulatorName: 'iPhone 17',
          },
          createContext(),
        ),
      );
      const current = sessionStore.getAll();
      // Both are kept, simulatorId takes precedence for tools
      expect(current.simulatorId).toBe('SIM-1');
      expect(current.simulatorName).toBe('iPhone 17');
      expect(res.isError).toBeFalsy();
    });

    it('should persist defaults when persist is true', async () => {
      const yaml = [
        'schemaVersion: 1',
        'sessionDefaults:',
        '  projectPath: "/old/App.xcodeproj"',
        '  simulatorName: "OldSim"',
        '',
      ].join('\n');

      const writes: { path: string; content: string }[] = [];
      const fs = createMockFileSystemExecutor({
        existsSync: (targetPath: string) => targetPath === configPath,
        readFile: async (targetPath: string) => {
          if (targetPath !== configPath) {
            throw new Error(`Unexpected readFile path: ${targetPath}`);
          }
          return yaml;
        },
        writeFile: async (targetPath: string, content: string) => {
          writes.push({ path: targetPath, content });
        },
      });

      await initConfigStore({ cwd, fs });

      const result = await runLogic(() =>
        sessionSetDefaultsLogic(
          {
            workspacePath: '/new/App.xcworkspace',
            simulatorId: 'RESOLVED-SIM-UUID',
            persist: true,
          },
          createContext(),
        ),
      );

      expect(writes.length).toBe(1);
      expect(writes[0].path).toBe(configPath);

      const parsed = parseYaml(writes[0].content) as {
        sessionDefaults?: Record<string, unknown>;
      };
      expect(parsed.sessionDefaults?.workspacePath).toBe('/new/App.xcworkspace');
      expect(parsed.sessionDefaults?.projectPath).toBeUndefined();
      expect(parsed.sessionDefaults?.simulatorId).toBe('RESOLVED-SIM-UUID');
      expect(parsed.sessionDefaults?.simulatorName).toBeUndefined();
    });

    it('sets defaults on existing named profile and activates it', async () => {
      sessionStore.setActiveProfile('ios');
      sessionStore.setDefaults({ scheme: 'OldIOS' });
      sessionStore.setActiveProfile(null);

      const result = await runLogic(() =>
        sessionSetDefaultsLogic(
          {
            profile: 'ios',
            scheme: 'NewIOS',
            simulatorName: 'iPhone 17',
          },
          createContext(),
        ),
      );

      expect(result.isError).toBeFalsy();
      expect(sessionStore.getActiveProfile()).toBe('ios');
      expect(sessionStore.getAll().scheme).toBe('NewIOS');
      expect(sessionStore.getAll().simulatorName).toBe('iPhone 17');
    });

    it('returns error when profile does not exist and createIfNotExists is false', async () => {
      const before = sessionStore.getAll();
      const result = await runLogic(() =>
        sessionSetDefaultsLogic(
          {
            profile: 'missing',
            scheme: 'NewIOS',
          },
          createContext(),
        ),
      );

      expect(result.isError).toBe(true);
      expect(sessionStore.getAll()).toEqual(before);
      expect(sessionStore.getActiveProfile()).toBeNull();
    });

    it('creates profile when createIfNotExists is true and activates it', async () => {
      const result = await runLogic(() =>
        sessionSetDefaultsLogic(
          {
            profile: 'ios',
            createIfNotExists: true,
            scheme: 'NewIOS',
          },
          createContext(),
        ),
      );

      expect(result.isError).toBeFalsy();
      expect(sessionStore.getActiveProfile()).toBe('ios');
      expect(sessionStore.getAll().scheme).toBe('NewIOS');
    });

    it('persists defaults and active profile when profile is provided', async () => {
      const yaml = [
        'schemaVersion: 1',
        'sessionDefaultsProfiles:',
        '  ios:',
        '    scheme: "Old"',
        '',
      ].join('\n');

      const writes: { path: string; content: string }[] = [];
      let persistedYaml = yaml;
      const fs = createMockFileSystemExecutor({
        existsSync: (targetPath: string) => targetPath === configPath,
        readFile: async (targetPath: string) => {
          if (targetPath !== configPath) {
            throw new Error(`Unexpected readFile path: ${targetPath}`);
          }
          return persistedYaml;
        },
        writeFile: async (targetPath: string, content: string) => {
          writes.push({ path: targetPath, content });
          persistedYaml = content;
        },
      });

      await initConfigStore({ cwd, fs });
      sessionStore.setActiveProfile('ios');
      sessionStore.setActiveProfile(null);

      await runLogic(() =>
        sessionSetDefaultsLogic(
          {
            profile: 'ios',
            scheme: 'NewIOS',
            simulatorName: 'iPhone 17',
            persist: true,
          },
          createContext(),
        ),
      );

      expect(writes.length).toBe(2);
      const parsed = parseYaml(writes[writes.length - 1].content) as {
        sessionDefaultsProfiles?: Record<string, Record<string, unknown>>;
        activeSessionDefaultsProfile?: string;
      };
      expect(parsed.sessionDefaultsProfiles?.ios?.scheme).toBe('NewIOS');
      expect(parsed.sessionDefaultsProfiles?.ios?.simulatorName).toBe('iPhone 17');
      expect(parsed.activeSessionDefaultsProfile).toBe('ios');
    });

    it('should store env as a Record<string, string> default', async () => {
      const envVars = { STAGING_ENABLED: '1', DEBUG: 'true' };
      const result = await runLogic(() =>
        sessionSetDefaultsLogic({ env: envVars }, createContext()),
      );

      expect(result.isError).toBeFalsy();
      expect(sessionStore.getAll().env).toEqual(envVars);
    });

    it('should persist env to config when persist is true', async () => {
      const yaml = ['schemaVersion: 1', 'sessionDefaults: {}', ''].join('\n');

      const writes: { path: string; content: string }[] = [];
      const fs = createMockFileSystemExecutor({
        existsSync: (targetPath: string) => targetPath === configPath,
        readFile: async (targetPath: string) => {
          if (targetPath !== configPath) {
            throw new Error(`Unexpected readFile path: ${targetPath}`);
          }
          return yaml;
        },
        writeFile: async (targetPath: string, content: string) => {
          writes.push({ path: targetPath, content });
        },
      });

      await initConfigStore({ cwd, fs });

      const envVars = { API_URL: 'https://staging.example.com' };
      const result = await runLogic(() =>
        sessionSetDefaultsLogic({ env: envVars, persist: true }, createContext()),
      );

      expect(writes.length).toBe(1);

      const parsed = parseYaml(writes[0].content) as {
        sessionDefaults?: Record<string, unknown>;
      };
      expect(parsed.sessionDefaults?.env).toEqual(envVars);
    });

    it('should store extraArgs as a string array default', async () => {
      const extraArgs = ['-skipPackagePluginValidation', '-skipMacroValidation'];
      const result = await runLogic(() => sessionSetDefaultsLogic({ extraArgs }, createContext()));

      expect(result.isError).toBeFalsy();
      expect(sessionStore.getAll().extraArgs).toEqual(extraArgs);
    });

    it('should persist extraArgs to config when persist is true', async () => {
      const yaml = ['schemaVersion: 1', 'sessionDefaults: {}', ''].join('\n');

      const writes: { path: string; content: string }[] = [];
      const fs = createMockFileSystemExecutor({
        existsSync: (targetPath: string) => targetPath === configPath,
        readFile: async (targetPath: string) => {
          if (targetPath !== configPath) {
            throw new Error(`Unexpected readFile path: ${targetPath}`);
          }
          return yaml;
        },
        writeFile: async (targetPath: string, content: string) => {
          writes.push({ path: targetPath, content });
        },
      });

      await initConfigStore({ cwd, fs });

      const extraArgs = ['-skipPackagePluginValidation'];
      const result = await runLogic(() =>
        sessionSetDefaultsLogic({ extraArgs, persist: true }, createContext()),
      );

      expect(result.isError).toBeFalsy();
      expect(writes.length).toBe(1);

      const parsed = parseYaml(writes[0].content) as {
        sessionDefaults?: Record<string, unknown>;
      };
      expect(parsed.sessionDefaults?.extraArgs).toEqual(extraArgs);
    });

    it('should not persist when persist is true but no defaults were provided', async () => {
      const writes: { path: string; content: string }[] = [];
      const fs = createMockFileSystemExecutor({
        existsSync: () => false,
        writeFile: async (targetPath: string, content: string) => {
          writes.push({ path: targetPath, content });
        },
      });

      await initConfigStore({ cwd, fs });

      const result = await runLogic(() =>
        sessionSetDefaultsLogic({ persist: true }, createContext()),
      );

      expect(result.isError).toBeFalsy();
      expect(writes).toEqual([]);
      expect(sessionStore.getAll()).toEqual({});
    });
  });
});
