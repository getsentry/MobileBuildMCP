import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { createMockFileSystemExecutor } from '../../test-utils/mock-executors.ts';
import {
  loadProjectConfig,
  persistActiveSessionDefaultsProfileToProjectConfig,
  persistProjectConfigPatch,
  persistSessionDefaultsToProjectConfig,
} from '../project-config.ts';

const cwd = '/repo';
const configPath = path.join(cwd, '.mobilebuildmcp', 'config.yaml');
const configDir = path.join(cwd, '.mobilebuildmcp');

type MockWrite = { path: string; content: string };

type MockFsFixture = {
  fs: ReturnType<typeof createMockFileSystemExecutor>;
  writes: MockWrite[];
  mkdirs: string[];
};

function createFsFixture(options?: { exists?: boolean; readFile?: string }): MockFsFixture {
  const writes: MockWrite[] = [];
  const mkdirs: string[] = [];
  const exists = options?.exists ?? false;
  const readFileContent = options?.readFile;

  const fs = createMockFileSystemExecutor({
    existsSync: (targetPath) => (targetPath === configPath ? exists : false),
    readFile: async (targetPath) => {
      if (targetPath !== configPath) {
        throw new Error(`Unexpected readFile path: ${targetPath}`);
      }
      if (readFileContent == null) {
        throw new Error('readFile called but no readFile content was provided');
      }
      return readFileContent;
    },
    writeFile: async (targetPath, content) => {
      writes.push({ path: targetPath, content });
    },
    mkdir: async (targetPath) => {
      mkdirs.push(targetPath);
    },
  });

  return { fs, writes, mkdirs };
}

describe('project-config', () => {
  describe('loadProjectConfig', () => {
    it('should return found=false when config does not exist', async () => {
      const { fs } = createFsFixture({ exists: false });
      const result = await loadProjectConfig({ fs, cwd });
      expect(result).toEqual({ found: false });
    });

    it('should normalize mutual exclusivity and resolve relative paths', async () => {
      const yaml = [
        'schemaVersion: 1',
        'enabledWorkflows: simulator,device',
        'customWorkflows:',
        '  My-Workflow:',
        '    - build_run_sim',
        '    - SCREENSHOT',
        'debug: true',
        'axePath: "./bin/axe"',
        'axeSourcePath: "../AXe"',
        'sessionDefaults:',
        '  projectPath: "./App.xcodeproj"',
        '  workspacePath: "./App.xcworkspace"',
        '  simulatorName: "iPhone 17"',
        '  simulatorId: "SIM-1"',
        '  derivedDataPath: "./.derivedData"',
        '',
      ].join('\n');

      const { fs } = createFsFixture({ exists: true, readFile: yaml });
      const result = await loadProjectConfig({ fs, cwd });

      if (!result.found) throw new Error('expected config to be found');

      const defaults = result.config.sessionDefaults ?? {};
      expect(result.config.enabledWorkflows).toEqual(['simulator', 'device']);
      expect(result.config.customWorkflows).toEqual({
        'my-workflow': ['build_run_sim', 'screenshot'],
      });
      expect(result.config.debug).toBe(true);
      expect(result.config.axePath).toBe(path.join(cwd, 'bin', 'axe'));
      expect(result.config.axeSourcePath).toBe(path.join(cwd, '..', 'AXe'));
      expect(defaults.workspacePath).toBe(path.join(cwd, 'App.xcworkspace'));
      expect(defaults.projectPath).toBeUndefined();
      expect(defaults.simulatorId).toBe('SIM-1');
      expect(defaults.simulatorName).toBe('iPhone 17');
      expect(defaults.derivedDataPath).toBe(path.join(cwd, '.derivedData'));
      expect(result.notices.length).toBeGreaterThan(0);
    });

    it('should load filePathRenderStyle from config', async () => {
      const yaml = ['schemaVersion: 1', 'filePathRenderStyle: list', ''].join('\n');

      const { fs } = createFsFixture({ exists: true, readFile: yaml });
      const result = await loadProjectConfig({ fs, cwd });

      if (!result.found) throw new Error('expected config to be found');

      expect(result.config.filePathRenderStyle).toBe('list');
    });

    it('should normalize debuggerBackend and resolve template paths', async () => {
      const yaml = [
        'schemaVersion: 1',
        'debuggerBackend: lldb',
        'iosTemplatePath: "./templates/ios"',
        'macosTemplatePath: "/opt/templates/macos"',
        '',
      ].join('\n');

      const { fs } = createFsFixture({ exists: true, readFile: yaml });
      const result = await loadProjectConfig({ fs, cwd });

      if (!result.found) throw new Error('expected config to be found');

      expect(result.config.debuggerBackend).toBe('lldb-cli');
      expect(result.config.iosTemplatePath).toBe(path.join(cwd, 'templates', 'ios'));
      expect(result.config.macosTemplatePath).toBe('/opt/templates/macos');
    });

    it('normalizes custom workflow entries while loading config', async () => {
      const yaml = [
        'schemaVersion: 1',
        'customWorkflows:',
        '  valid-workflow:',
        '    - build_run_sim',
        '  invalid-workflow: build_run_sim',
        '  "":',
        '    - screenshot',
        '',
      ].join('\n');

      const { fs } = createFsFixture({ exists: true, readFile: yaml });
      const result = await loadProjectConfig({ fs, cwd });

      if (!result.found) throw new Error('expected config to be found');

      expect(result.config.customWorkflows).toEqual({
        'invalid-workflow': ['build_run_sim'],
        'valid-workflow': ['build_run_sim'],
      });
    });

    it('should resolve file URLs in session defaults and top-level paths', async () => {
      const yaml = [
        'schemaVersion: 1',
        'axePath: "file:///repo/bin/axe"',
        'axeSourcePath: "file:///repo/AXe"',
        'sessionDefaults:',
        '  workspacePath: "file:///repo/App.xcworkspace"',
        '  derivedDataPath: "file:///repo/.derivedData"',
        '',
      ].join('\n');

      const { fs } = createFsFixture({ exists: true, readFile: yaml });
      const result = await loadProjectConfig({ fs, cwd });

      if (!result.found) throw new Error('expected config to be found');

      expect(result.config.axePath).toBe('/repo/bin/axe');
      expect(result.config.axeSourcePath).toBe('/repo/AXe');
      const defaults = result.config.sessionDefaults ?? {};
      expect(defaults.workspacePath).toBe('/repo/App.xcworkspace');
      expect(defaults.derivedDataPath).toBe('/repo/.derivedData');
    });

    it('should expand ~ prefixes in session defaults paths', async () => {
      const yaml = [
        'schemaVersion: 1',
        'sessionDefaults:',
        '  projectPath: "~/Code/App.xcodeproj"',
        '  derivedDataPath: "~/.foo/derivedData"',
        '',
      ].join('\n');

      const { fs } = createFsFixture({ exists: true, readFile: yaml });
      const result = await loadProjectConfig({ fs, cwd });
      if (!result.found) throw new Error('expected config to be found');

      const defaults = result.config.sessionDefaults ?? {};
      expect(defaults.projectPath).toBe(path.join(homedir(), 'Code/App.xcodeproj'));
      expect(defaults.derivedDataPath).toBe(path.join(homedir(), '.foo/derivedData'));
    });

    it('should expand ~ prefixes in top-level path keys', async () => {
      const yaml = [
        'schemaVersion: 1',
        'axePath: "~/tools/axe"',
        'axeSourcePath: "~/Code/AXe"',
        'iosTemplatePath: "~/templates/ios"',
        '',
      ].join('\n');

      const { fs } = createFsFixture({ exists: true, readFile: yaml });
      const result = await loadProjectConfig({ fs, cwd });
      if (!result.found) throw new Error('expected config to be found');

      expect(result.config.axePath).toBe(path.join(homedir(), 'tools/axe'));
      expect(result.config.axeSourcePath).toBe(path.join(homedir(), 'Code/AXe'));
      expect(result.config.iosTemplatePath).toBe(path.join(homedir(), 'templates/ios'));
    });

    it('should expand ~ prefixes in session defaults profiles', async () => {
      const yaml = [
        'schemaVersion: 1',
        'sessionDefaultsProfiles:',
        '  ios:',
        '    workspacePath: "~/Code/App.xcworkspace"',
        '    derivedDataPath: "~/.cache/dd"',
        '    extraArgs:',
        '      - "-skipPackagePluginValidation"',
        '',
      ].join('\n');

      const { fs } = createFsFixture({ exists: true, readFile: yaml });
      const result = await loadProjectConfig({ fs, cwd });
      if (!result.found) throw new Error('expected config to be found');

      expect(result.config.sessionDefaultsProfiles?.ios?.workspacePath).toBe(
        path.join(homedir(), 'Code/App.xcworkspace'),
      );
      expect(result.config.sessionDefaultsProfiles?.ios?.derivedDataPath).toBe(
        path.join(homedir(), '.cache/dd'),
      );
      expect(result.config.sessionDefaultsProfiles?.ios?.extraArgs).toEqual([
        '-skipPackagePluginValidation',
      ]);
    });

    it('normalizes namespaced session defaults profiles and active profile', async () => {
      const yaml = [
        'schemaVersion: 1',
        'activeSessionDefaultsProfile: "ios"',
        'sessionDefaultsProfiles:',
        '  ios:',
        '    projectPath: "./App.xcodeproj"',
        '    workspacePath: "./App.xcworkspace"',
        '    simulatorName: "iPhone 17"',
        '  watch:',
        '    workspacePath: "./Watch.xcworkspace"',
        '',
      ].join('\n');

      const { fs } = createFsFixture({ exists: true, readFile: yaml });
      const result = await loadProjectConfig({ fs, cwd });
      if (!result.found) throw new Error('expected config to be found');

      expect(result.config.activeSessionDefaultsProfile).toBe('ios');
      expect(result.config.sessionDefaultsProfiles?.ios?.workspacePath).toBe(
        path.join(cwd, 'App.xcworkspace'),
      );
      expect(result.config.sessionDefaultsProfiles?.ios?.projectPath).toBeUndefined();
      expect(result.config.sessionDefaultsProfiles?.watch?.workspacePath).toBe(
        path.join(cwd, 'Watch.xcworkspace'),
      );
    });

    it('should return an error result when schemaVersion is unsupported', async () => {
      const yaml = ['schemaVersion: 2', 'sessionDefaults:', '  scheme: "App"', ''].join('\n');
      const { fs } = createFsFixture({ exists: true, readFile: yaml });

      const result = await loadProjectConfig({ fs, cwd });
      expect(result.found).toBe(false);
      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error).toBeInstanceOf(Error);
      }
    });

    it('should return an error result when YAML does not parse to an object', async () => {
      const { fs } = createFsFixture({ exists: true, readFile: '- item' });

      const result = await loadProjectConfig({ fs, cwd });
      expect(result.found).toBe(false);
      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error.message).toBe('Project config must be an object');
      }
    });
  });

  describe('persistSessionDefaultsToProjectConfig', () => {
    it('should merge patches, delete exclusive keys, and preserve unknown sections', async () => {
      const yaml = [
        'schemaVersion: 1',
        'debug: true',
        'enabledWorkflows:',
        '  - simulator',
        'sessionDefaults:',
        '  scheme: "Old"',
        '  simulatorName: "OldSim"',
        'server:',
        '  enabledWorkflows:',
        '    - simulator',
        '',
      ].join('\n');

      const { fs, writes, mkdirs } = createFsFixture({ exists: true, readFile: yaml });

      await persistSessionDefaultsToProjectConfig({
        fs,
        cwd,
        patch: { scheme: 'New', simulatorId: 'SIM-1' },
        deleteKeys: ['simulatorName'],
      });

      expect(mkdirs).toContain(configDir);
      expect(writes.length).toBe(1);
      expect(writes[0].path).toBe(configPath);

      const parsed = parseYaml(writes[0].content) as {
        schemaVersion: number;
        debug?: boolean;
        enabledWorkflows?: string[];
        sessionDefaults?: Record<string, unknown>;
        server?: { enabledWorkflows?: string[] };
      };

      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.debug).toBe(true);
      expect(parsed.enabledWorkflows).toEqual(['simulator']);
      expect(parsed.sessionDefaults?.scheme).toBe('New');
      expect(parsed.sessionDefaults?.simulatorId).toBe('SIM-1');
      expect(parsed.sessionDefaults?.simulatorName).toBeUndefined();
      expect(parsed.server?.enabledWorkflows).toEqual(['simulator']);
    });

    it('should overwrite invalid existing config with a minimal valid config', async () => {
      const { fs, writes } = createFsFixture({ exists: true, readFile: '- not-an-object' });

      await persistSessionDefaultsToProjectConfig({
        fs,
        cwd,
        patch: { scheme: 'App' },
      });

      expect(writes.length).toBe(1);
      const parsed = parseYaml(writes[0].content) as {
        schemaVersion: number;
        sessionDefaults?: Record<string, unknown>;
      };

      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.sessionDefaults?.scheme).toBe('App');
    });

    it('persists session defaults to a named profile', async () => {
      const yaml = [
        'schemaVersion: 1',
        'sessionDefaultsProfiles:',
        '  ios:',
        '    scheme: "Old"',
        '',
      ].join('\n');
      const { fs, writes } = createFsFixture({ exists: true, readFile: yaml });

      await persistSessionDefaultsToProjectConfig({
        fs,
        cwd,
        profile: 'ios',
        patch: { scheme: 'NewIOS', simulatorId: 'SIM-1' },
      });

      expect(writes.length).toBe(1);
      const parsed = parseYaml(writes[0].content) as {
        sessionDefaultsProfiles?: Record<string, Record<string, unknown>>;
      };
      expect(parsed.sessionDefaultsProfiles?.ios?.scheme).toBe('NewIOS');
      expect(parsed.sessionDefaultsProfiles?.ios?.simulatorId).toBe('SIM-1');
    });

    it('trims named profile before persisting session defaults', async () => {
      const { fs, writes } = createFsFixture({ exists: false });

      await persistSessionDefaultsToProjectConfig({
        fs,
        cwd,
        profile: ' ios ',
        patch: { scheme: 'NewIOS' },
      });

      expect(writes.length).toBe(1);
      const parsed = parseYaml(writes[0].content) as {
        sessionDefaultsProfiles?: Record<string, Record<string, unknown>>;
      };
      expect(parsed.sessionDefaultsProfiles?.ios?.scheme).toBe('NewIOS');
      expect(parsed.sessionDefaultsProfiles?.[' ios ']).toBeUndefined();
    });

    it('throws when named profile is empty after trimming', async () => {
      const { fs } = createFsFixture({ exists: false });

      await expect(
        persistSessionDefaultsToProjectConfig({
          fs,
          cwd,
          profile: '   ',
          patch: { scheme: 'NewIOS' },
        }),
      ).rejects.toThrow('Profile name cannot be empty.');
    });
  });

  describe('persistProjectConfigPatch', () => {
    it('writes top-level setup fields and session defaults', async () => {
      const { fs, writes } = createFsFixture({ exists: false });

      await persistProjectConfigPatch({
        fs,
        cwd,
        patch: {
          enabledWorkflows: ['simulator', 'ui-automation'],
          debug: true,
          sentryDisabled: true,
          filePathRenderStyle: 'list',
          sessionDefaults: {
            workspacePath: './MyApp.xcworkspace',
            scheme: 'MyApp',
            simulatorId: 'SIM-1',
          },
        },
        deleteSessionDefaultKeys: ['projectPath'],
      });

      expect(writes.length).toBe(1);
      const parsed = parseYaml(writes[0].content) as {
        enabledWorkflows?: string[];
        debug?: boolean;
        sentryDisabled?: boolean;
        filePathRenderStyle?: string;
        sessionDefaults?: Record<string, unknown>;
      };

      expect(parsed.enabledWorkflows).toEqual(['simulator', 'ui-automation']);
      expect(parsed.debug).toBe(true);
      expect(parsed.sentryDisabled).toBe(true);
      expect(parsed.filePathRenderStyle).toBe('list');
      expect(parsed.sessionDefaults?.workspacePath).toBe('./MyApp.xcworkspace');
      expect(parsed.sessionDefaults?.projectPath).toBeUndefined();
    });

    it('preserves unknown sections while patching setup fields', async () => {
      const yaml = [
        'schemaVersion: 1',
        'server:',
        '  enabledWorkflows:',
        '    - simulator',
        'sessionDefaults:',
        '  projectPath: "./App.xcodeproj"',
        '',
      ].join('\n');
      const { fs, writes } = createFsFixture({ exists: true, readFile: yaml });

      await persistProjectConfigPatch({
        fs,
        cwd,
        patch: {
          debug: false,
          enabledWorkflows: ['simulator'],
          sessionDefaults: {
            workspacePath: './App.xcworkspace',
          },
        },
        deleteSessionDefaultKeys: ['projectPath'],
      });

      expect(writes.length).toBe(1);
      const parsed = parseYaml(writes[0].content) as {
        server?: { enabledWorkflows?: string[] };
        sessionDefaults?: Record<string, unknown>;
      };

      expect(parsed.server?.enabledWorkflows).toEqual(['simulator']);
      expect(parsed.sessionDefaults?.workspacePath).toBe('./App.xcworkspace');
      expect(parsed.sessionDefaults?.projectPath).toBeUndefined();
    });
  });

  describe('persistActiveSessionDefaultsProfileToProjectConfig', () => {
    it('persists active profile name', async () => {
      const { fs, writes } = createFsFixture({ exists: true, readFile: 'schemaVersion: 1\n' });

      await persistActiveSessionDefaultsProfileToProjectConfig({
        fs,
        cwd,
        profile: 'ios',
      });

      expect(writes.length).toBe(1);
      const parsed = parseYaml(writes[0].content) as {
        activeSessionDefaultsProfile?: string;
      };
      expect(parsed.activeSessionDefaultsProfile).toBe('ios');
    });

    it('trims active profile name before persisting', async () => {
      const { fs, writes } = createFsFixture({ exists: true, readFile: 'schemaVersion: 1\n' });

      await persistActiveSessionDefaultsProfileToProjectConfig({
        fs,
        cwd,
        profile: ' ios ',
      });

      expect(writes.length).toBe(1);
      const parsed = parseYaml(writes[0].content) as {
        activeSessionDefaultsProfile?: string;
      };
      expect(parsed.activeSessionDefaultsProfile).toBe('ios');
    });

    it('removes active profile when switching to global', async () => {
      const yaml = ['schemaVersion: 1', 'activeSessionDefaultsProfile: "watch"', ''].join('\n');
      const { fs, writes } = createFsFixture({ exists: true, readFile: yaml });

      await persistActiveSessionDefaultsProfileToProjectConfig({
        fs,
        cwd,
        profile: null,
      });

      expect(writes.length).toBe(1);
      const parsed = parseYaml(writes[0].content) as {
        activeSessionDefaultsProfile?: string;
      };
      expect(parsed.activeSessionDefaultsProfile).toBeUndefined();
    });
  });
});
