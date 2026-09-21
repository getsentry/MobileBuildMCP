import { beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { createMockFileSystemExecutor } from '../../test-utils/mock-executors.ts';
import {
  __resetConfigStoreForTests,
  getConfig,
  initConfigStore,
  persistActiveSessionDefaultsProfile,
  persistSessionDefaultsPatch,
  type RuntimeConfigOverrides,
} from '../config-store.ts';

const cwd = '/repo';
const configPath = path.join(cwd, '.xcodebuildmcp', 'config.yaml');

describe('config-store', () => {
  beforeEach(() => {
    __resetConfigStoreForTests();
  });

  function createFs(readFile?: string) {
    return createMockFileSystemExecutor({
      existsSync: (targetPath) => targetPath === configPath && readFile != null,
      readFile: async (targetPath) => {
        if (targetPath !== configPath) {
          throw new Error(`Unexpected readFile path: ${targetPath}`);
        }
        if (readFile == null) {
          throw new Error('readFile called without fixture content');
        }
        return readFile;
      },
    });
  }

  it('uses defaults when config is missing and overrides are not provided', async () => {
    await initConfigStore({ cwd, fs: createFs() });

    const config = getConfig();
    expect(config.debug).toBe(false);
    expect(config.incrementalBuildsEnabled).toBe(false);
    expect(config.testProductsMaxCount).toBe(3);
    expect(config.testProductsMaxAgeDays).toBe(1);
    expect(config.dapRequestTimeoutMs).toBe(30000);
    expect(config.dapLogEvents).toBe(false);
    expect(config.launchJsonWaitMs).toBe(8000);
    expect(config.filePathRenderStyle).toBeUndefined();
  });

  it('parses env values when provided', async () => {
    const env = {
      XCODEBUILDMCP_DEBUG: 'true',
      XCODEBUILDMCP_SENTRY_DISABLED: 'true',
      INCREMENTAL_BUILDS_ENABLED: '1',
      XCODEBUILDMCP_TEST_PRODUCTS_MAX_COUNT: '4',
      XCODEBUILDMCP_TEST_PRODUCTS_MAX_AGE_DAYS: '0.5',
      XCODEBUILDMCP_DAP_REQUEST_TIMEOUT_MS: '12345',
      XCODEBUILDMCP_DAP_LOG_EVENTS: 'true',
      XBMCP_LAUNCH_JSON_WAIT_MS: '9000',
      XCODEBUILDMCP_ENABLED_WORKFLOWS: 'simulator,logging',
      XCODEBUILDMCP_UI_DEBUGGER_GUARD_MODE: 'warn',
      XCODEBUILDMCP_DEBUGGER_BACKEND: 'lldb',
      XCODEBUILDMCP_FILE_PATH_RENDER_STYLE: 'list',
      XCODEBUILDMCP_AXE_SOURCE_PATH: '/Volumes/Developer/AXe',
    };

    await initConfigStore({ cwd, fs: createFs(), env });

    const config = getConfig();
    expect(config.debug).toBe(true);
    expect(config.sentryDisabled).toBe(true);
    expect(config.incrementalBuildsEnabled).toBe(true);
    expect(config.testProductsMaxCount).toBe(4);
    expect(config.testProductsMaxAgeDays).toBe(0.5);
    expect(config.dapRequestTimeoutMs).toBe(12345);
    expect(config.dapLogEvents).toBe(true);
    expect(config.launchJsonWaitMs).toBe(9000);
    expect(config.enabledWorkflows).toEqual(['simulator', 'logging']);
    expect(config.uiDebuggerGuardMode).toBe('warn');
    expect(config.debuggerBackend).toBe('lldb-cli');
    expect(config.filePathRenderStyle).toBe('list');
    expect(config.axeSourcePath).toBe('/Volumes/Developer/AXe');
  });

  it('prefers overrides over config file values and config over env', async () => {
    const yaml = [
      'schemaVersion: 1',
      'debug: false',
      'dapRequestTimeoutMs: 4000',
      'filePathRenderStyle: tree',
      'axeSourcePath: /file/AXe',
      '',
    ].join('\n');
    const env = {
      XCODEBUILDMCP_DEBUG: 'true',
      XCODEBUILDMCP_TEST_PRODUCTS_MAX_COUNT: '9',
      XCODEBUILDMCP_TEST_PRODUCTS_MAX_AGE_DAYS: '3',
      XCODEBUILDMCP_DAP_REQUEST_TIMEOUT_MS: '999',
      XCODEBUILDMCP_FILE_PATH_RENDER_STYLE: 'list',
      XCODEBUILDMCP_AXE_SOURCE_PATH: '/env/AXe',
    };

    await initConfigStore({
      cwd,
      fs: createFs(yaml),
      overrides: {
        debug: true,
        testProductsMaxCount: 7,
        testProductsMaxAgeDays: 1.5,
        dapRequestTimeoutMs: 12345,
        filePathRenderStyle: 'list',
        axeSourcePath: '/override/AXe',
      },
      env,
    });

    const config = getConfig();
    expect(config.debug).toBe(true);
    expect(config.testProductsMaxCount).toBe(7);
    expect(config.testProductsMaxAgeDays).toBe(1.5);
    expect(config.dapRequestTimeoutMs).toBe(12345);
    expect(config.filePathRenderStyle).toBe('list');
    expect(config.axeSourcePath).toBe('/override/AXe');
  });

  it.each([
    ['XCODEBUILDMCP_TEST_PRODUCTS_MAX_COUNT', '0'],
    ['XCODEBUILDMCP_TEST_PRODUCTS_MAX_COUNT', '1.5'],
    ['XCODEBUILDMCP_TEST_PRODUCTS_MAX_COUNT', 'not-a-number'],
    ['XCODEBUILDMCP_TEST_PRODUCTS_MAX_AGE_DAYS', '0'],
    ['XCODEBUILDMCP_TEST_PRODUCTS_MAX_AGE_DAYS', 'Infinity'],
    ['XCODEBUILDMCP_TEST_PRODUCTS_MAX_AGE_DAYS', ''],
  ])('rejects invalid %s environment values', async (name, value) => {
    await expect(initConfigStore({ cwd, fs: createFs(), env: { [name]: value } })).rejects.toThrow(
      name,
    );
  });

  it.each([
    [{ testProductsMaxCount: 0 }, 'testProductsMaxCount'],
    [{ testProductsMaxCount: 1.5 }, 'testProductsMaxCount'],
    [{ testProductsMaxAgeDays: Number.NaN }, 'testProductsMaxAgeDays'],
    [{ testProductsMaxAgeDays: 0 }, 'testProductsMaxAgeDays'],
  ] satisfies ReadonlyArray<readonly [RuntimeConfigOverrides, string]>)(
    'rejects invalid runtime retention overrides',
    async (overrides, name) => {
      await expect(initConfigStore({ cwd, fs: createFs(), overrides })).rejects.toThrow(name);
    },
  );

  it('uses file config before env when no override is provided', async () => {
    const yaml = [
      'schemaVersion: 1',
      'filePathRenderStyle: tree',
      'axeSourcePath: /file/AXe',
      '',
    ].join('\n');
    const env = {
      XCODEBUILDMCP_FILE_PATH_RENDER_STYLE: 'list',
      XCODEBUILDMCP_AXE_SOURCE_PATH: '/env/AXe',
    };

    await initConfigStore({ cwd, fs: createFs(yaml), env });

    expect(getConfig().filePathRenderStyle).toBe('tree');
    expect(getConfig().axeSourcePath).toBe('/file/AXe');
  });

  it('reads sentryDisabled from config file', async () => {
    const yaml = ['schemaVersion: 1', 'sentryDisabled: true', ''].join('\n');

    await initConfigStore({ cwd, fs: createFs(yaml) });

    const config = getConfig();
    expect(config.sentryDisabled).toBe(true);
  });

  it('resolves enabledWorkflows from overrides, config, then defaults', async () => {
    const yamlWithoutWorkflows = ['schemaVersion: 1', 'debug: false', ''].join('\n');

    await initConfigStore({ cwd, fs: createFs(yamlWithoutWorkflows) });

    const config = getConfig();
    expect(config.enabledWorkflows).toEqual([]);

    const yamlWithExplicitEmpty = ['schemaVersion: 1', 'enabledWorkflows: []', ''].join('\n');

    await initConfigStore({ cwd, fs: createFs(yamlWithExplicitEmpty) });

    const explicitEmpty = getConfig();
    expect(explicitEmpty.enabledWorkflows).toEqual([]);

    await initConfigStore({
      cwd,
      fs: createFs(yamlWithExplicitEmpty),
      overrides: { enabledWorkflows: ['device'] },
    });

    const updated = getConfig();
    expect(updated.enabledWorkflows).toEqual(['device']);
  });

  it('resolves customWorkflows from overrides, config, then defaults', async () => {
    const yaml = [
      'schemaVersion: 1',
      'customWorkflows:',
      '  smoke:',
      '    - build_run_sim',
      '',
    ].join('\n');

    await initConfigStore({ cwd, fs: createFs(yaml) });
    expect(getConfig().customWorkflows).toEqual({
      smoke: ['build_run_sim'],
    });

    await initConfigStore({
      cwd,
      fs: createFs(yaml),
      overrides: {
        customWorkflows: {
          quick: ['screenshot'],
        },
      },
    });

    expect(getConfig().customWorkflows).toEqual({
      quick: ['screenshot'],
    });
  });

  it('merges namespaced session defaults profiles from file and overrides', async () => {
    const yaml = [
      'schemaVersion: 1',
      'activeSessionDefaultsProfile: "ios"',
      'sessionDefaultsProfiles:',
      '  ios:',
      '    scheme: "FromFile"',
      '    workspacePath: "./App.xcworkspace"',
      '',
    ].join('\n');

    await initConfigStore({
      cwd,
      fs: createFs(yaml),
      overrides: {
        sessionDefaultsProfiles: {
          ios: { simulatorName: 'iPhone 17' },
          watch: { scheme: 'WatchScheme' },
        },
      },
    });

    const config = getConfig();
    expect(config.activeSessionDefaultsProfile).toBe('ios');
    expect(config.sessionDefaultsProfiles?.ios?.scheme).toBe('FromFile');
    expect(config.sessionDefaultsProfiles?.ios?.simulatorName).toBe('iPhone 17');
    expect(config.sessionDefaultsProfiles?.watch?.scheme).toBe('WatchScheme');
  });

  it('persists active profile selection and updates resolved config', async () => {
    const writes: { path: string; content: string }[] = [];
    const fs = createMockFileSystemExecutor({
      existsSync: () => true,
      readFile: async () => 'schemaVersion: 1\n',
      writeFile: async (targetPath, content) => {
        writes.push({ path: targetPath, content });
      },
    });

    await initConfigStore({ cwd, fs });
    await persistActiveSessionDefaultsProfile('ios');

    expect(getConfig().activeSessionDefaultsProfile).toBe('ios');
    expect(writes).toHaveLength(1);
  });

  it('normalizes profile names for persisted defaults patch and resolved config', async () => {
    const writes: { path: string; content: string }[] = [];
    let persistedYaml = 'schemaVersion: 1\n';
    const fs = createMockFileSystemExecutor({
      existsSync: () => true,
      readFile: async () => persistedYaml,
      writeFile: async (targetPath, content) => {
        writes.push({ path: targetPath, content });
        persistedYaml = content;
      },
    });

    await initConfigStore({ cwd, fs });
    await persistSessionDefaultsPatch({
      profile: ' ios ',
      patch: { scheme: 'App' },
    });

    expect(getConfig().sessionDefaultsProfiles?.ios?.scheme).toBe('App');
    expect(getConfig().sessionDefaultsProfiles?.[' ios ']).toBeUndefined();
    expect(writes).toHaveLength(1);
  });

  it('normalizes profile names for active profile persistence', async () => {
    const writes: { path: string; content: string }[] = [];
    const fs = createMockFileSystemExecutor({
      existsSync: () => true,
      readFile: async () => 'schemaVersion: 1\n',
      writeFile: async (targetPath, content) => {
        writes.push({ path: targetPath, content });
      },
    });

    await initConfigStore({ cwd, fs });
    await persistActiveSessionDefaultsProfile(' ios ');

    expect(getConfig().activeSessionDefaultsProfile).toBe('ios');
    expect(writes).toHaveLength(1);
  });

  it('keeps non-session config immutable after init when persisting session defaults', async () => {
    let persistedYaml = 'schemaVersion: 1\n';
    const fs = createMockFileSystemExecutor({
      existsSync: () => true,
      readFile: async () => persistedYaml,
      writeFile: async (_targetPath, content) => {
        persistedYaml = content;
      },
    });

    await initConfigStore({
      cwd,
      fs,
      env: { XCODEBUILDMCP_DEBUG: 'true' },
    });

    expect(getConfig().debug).toBe(true);

    await persistSessionDefaultsPatch({ patch: { scheme: 'App' } });

    expect(getConfig().debug).toBe(true);
    expect(getConfig().sessionDefaults?.scheme).toBe('App');
  });

  it('reads session defaults from env vars', async () => {
    const env = {
      XCODEBUILDMCP_WORKSPACE_PATH: '/path/to/App.xcworkspace',
      XCODEBUILDMCP_SCHEME: 'MyApp',
      XCODEBUILDMCP_PLATFORM: 'macOS',
      XCODEBUILDMCP_SUPPRESS_WARNINGS: 'true',
      XCODEBUILDMCP_SHOW_TEST_TIMING: 'true',
      XCODEBUILDMCP_DERIVED_DATA_PATH: '/tmp/dd',
      XCODEBUILDMCP_USE_LATEST_OS: 'true',
      XCODEBUILDMCP_ARCH: 'arm64',
      XCODEBUILDMCP_SIMULATOR_NAME: 'iPhone 17',
      XCODEBUILDMCP_BUNDLE_ID: 'com.example.app',
    };

    await initConfigStore({ cwd, fs: createFs(), env });

    const config = getConfig();
    expect(config.sessionDefaults?.workspacePath).toBe('/path/to/App.xcworkspace');
    expect(config.sessionDefaults?.scheme).toBe('MyApp');
    expect(config.sessionDefaults?.platform).toBe('macOS');
    expect(config.sessionDefaults?.suppressWarnings).toBe(true);
    expect(config.showTestTiming).toBe(true);
    expect(config.sessionDefaults?.derivedDataPath).toBe('/tmp/dd');
    expect(config.sessionDefaults?.useLatestOS).toBe(true);
    expect(config.sessionDefaults?.arch).toBe('arm64');
    expect(config.sessionDefaults?.simulatorName).toBe('iPhone 17');
    expect(config.sessionDefaults?.bundleId).toBe('com.example.app');
  });

  it('file config session defaults take precedence over env var session defaults', async () => {
    const yaml = [
      'schemaVersion: 1',
      'sessionDefaults:',
      '  scheme: "FromFile"',
      '  workspacePath: "./FromFile.xcworkspace"',
      '',
    ].join('\n');
    const env = {
      XCODEBUILDMCP_SCHEME: 'FromEnv',
      XCODEBUILDMCP_WORKSPACE_PATH: '/env/path/App.xcworkspace',
      XCODEBUILDMCP_PLATFORM: 'iOS',
    };

    await initConfigStore({ cwd, fs: createFs(yaml), env });

    const config = getConfig();
    expect(config.sessionDefaults?.scheme).toBe('FromFile');
    expect(config.sessionDefaults?.workspacePath).toBe('/repo/FromFile.xcworkspace');
    expect(config.sessionDefaults?.platform).toBe('iOS');
  });

  it('preserves injected env session defaults after persisting a session defaults patch', async () => {
    let persistedYaml = 'schemaVersion: 1\n';
    const fs = createMockFileSystemExecutor({
      existsSync: () => true,
      readFile: async () => persistedYaml,
      writeFile: async (_targetPath, content) => {
        persistedYaml = content;
      },
    });
    const env = {
      XCODEBUILDMCP_WORKSPACE_PATH: '/env/path/App.xcworkspace',
      XCODEBUILDMCP_SCHEME: 'FromEnv',
    };

    await initConfigStore({ cwd, fs, env });
    await persistSessionDefaultsPatch({ patch: { simulatorName: 'iPhone 17' } });

    const config = getConfig();
    expect(config.sessionDefaults?.workspacePath).toBe('/env/path/App.xcworkspace');
    expect(config.sessionDefaults?.scheme).toBe('FromEnv');
    expect(config.sessionDefaults?.simulatorName).toBe('iPhone 17');
  });

  it('preserves injected env session defaults after persisting the active profile', async () => {
    let persistedYaml = 'schemaVersion: 1\n';
    const fs = createMockFileSystemExecutor({
      existsSync: () => true,
      readFile: async () => persistedYaml,
      writeFile: async (_targetPath, content) => {
        persistedYaml = content;
      },
    });
    const env = {
      XCODEBUILDMCP_WORKSPACE_PATH: '/env/path/App.xcworkspace',
      XCODEBUILDMCP_SCHEME: 'FromEnv',
    };

    await initConfigStore({ cwd, fs, env });
    await persistActiveSessionDefaultsProfile('ios');

    const config = getConfig();
    expect(config.sessionDefaults?.workspacePath).toBe('/env/path/App.xcworkspace');
    expect(config.sessionDefaults?.scheme).toBe('FromEnv');
    expect(config.activeSessionDefaultsProfile).toBe('ios');
  });

  it('keeps non-session config immutable after init when persisting active profile', async () => {
    let persistedYaml = 'schemaVersion: 1\n';
    const fs = createMockFileSystemExecutor({
      existsSync: () => true,
      readFile: async () => persistedYaml,
      writeFile: async (_targetPath, content) => {
        persistedYaml = content;
      },
    });

    await initConfigStore({
      cwd,
      fs,
      env: { XCODEBUILDMCP_DEBUG: 'true' },
    });

    expect(getConfig().debug).toBe(true);

    await persistActiveSessionDefaultsProfile('ios');

    expect(getConfig().debug).toBe(true);
    expect(getConfig().activeSessionDefaultsProfile).toBe('ios');
  });
});
