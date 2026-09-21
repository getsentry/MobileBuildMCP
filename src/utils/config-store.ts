import type { FileSystemExecutor } from './FileSystemExecutor.ts';
import type { SessionDefaults } from './session-store.ts';
import { log } from './logger.ts';
import {
  loadProjectConfig,
  persistActiveSessionDefaultsProfileToProjectConfig,
  persistSessionDefaultsToProjectConfig,
  type ProjectConfig,
} from './project-config.ts';
import type { DebuggerBackendKind } from './debugger/types.ts';
import type { FilePathRenderStyle, UiDebuggerGuardMode } from './runtime-config-types.ts';
import { isFilePathRenderStyle } from './file-path-render-style.ts';
import { normalizeSessionDefaultsProfileName } from './session-defaults-profile.ts';

export const DEFAULT_TEST_PRODUCTS_MAX_COUNT = 3;
export const DEFAULT_TEST_PRODUCTS_MAX_AGE_DAYS = 1;

export type RuntimeConfigOverrides = Partial<{
  enabledWorkflows: string[];
  customWorkflows: Record<string, string[]>;
  debug: boolean;
  sentryDisabled: boolean;
  experimentalWorkflowDiscovery: boolean;
  disableSessionDefaults: boolean;
  disableXcodeAutoSync: boolean;
  showTestTiming: boolean;
  filePathRenderStyle: FilePathRenderStyle;
  uiDebuggerGuardMode: UiDebuggerGuardMode;
  incrementalBuildsEnabled: boolean;
  testProductsMaxCount: number;
  testProductsMaxAgeDays: number;
  dapRequestTimeoutMs: number;
  dapLogEvents: boolean;
  launchJsonWaitMs: number;
  axePath: string;
  axeSourcePath: string;
  iosTemplatePath: string;
  iosTemplateVersion: string;
  macosTemplatePath: string;
  macosTemplateVersion: string;
  debuggerBackend: DebuggerBackendKind;
  sessionDefaults: Partial<SessionDefaults>;
  sessionDefaultsProfiles: Record<string, Partial<SessionDefaults>>;
  activeSessionDefaultsProfile: string;
}>;

export type ResolvedRuntimeConfig = {
  enabledWorkflows: string[];
  customWorkflows: Record<string, string[]>;
  debug: boolean;
  sentryDisabled: boolean;
  experimentalWorkflowDiscovery: boolean;
  disableSessionDefaults: boolean;
  disableXcodeAutoSync: boolean;
  showTestTiming: boolean;
  filePathRenderStyle?: FilePathRenderStyle;
  uiDebuggerGuardMode: UiDebuggerGuardMode;
  incrementalBuildsEnabled: boolean;
  testProductsMaxCount: number;
  testProductsMaxAgeDays: number;
  dapRequestTimeoutMs: number;
  dapLogEvents: boolean;
  launchJsonWaitMs: number;
  axePath?: string;
  axeSourcePath?: string;
  iosTemplatePath?: string;
  iosTemplateVersion?: string;
  macosTemplatePath?: string;
  macosTemplateVersion?: string;
  debuggerBackend: DebuggerBackendKind;
  sessionDefaults?: Partial<SessionDefaults>;
  sessionDefaultsProfiles?: Record<string, Partial<SessionDefaults>>;
  activeSessionDefaultsProfile?: string;
};

type ConfigStoreState = {
  initialized: boolean;
  cwd?: string;
  fs?: FileSystemExecutor;
  env?: NodeJS.ProcessEnv;
  overrides?: RuntimeConfigOverrides;
  fileConfig?: ProjectConfig;
  resolved: ResolvedRuntimeConfig;
};

const DEFAULT_CONFIG: ResolvedRuntimeConfig = {
  enabledWorkflows: [],
  customWorkflows: {},
  debug: false,
  sentryDisabled: false,
  experimentalWorkflowDiscovery: false,
  disableSessionDefaults: false,
  disableXcodeAutoSync: false,
  showTestTiming: false,
  uiDebuggerGuardMode: 'error',
  incrementalBuildsEnabled: false,
  testProductsMaxCount: DEFAULT_TEST_PRODUCTS_MAX_COUNT,
  testProductsMaxAgeDays: DEFAULT_TEST_PRODUCTS_MAX_AGE_DAYS,
  dapRequestTimeoutMs: 30_000,
  dapLogEvents: false,
  launchJsonWaitMs: 8000,
  debuggerBackend: 'dap',
};

const storeState: ConfigStoreState = {
  initialized: false,
  resolved: { ...DEFAULT_CONFIG },
};

function hasOwnProperty<T extends object, K extends PropertyKey>(
  obj: T | undefined,
  key: K,
): obj is T & Record<K, unknown> {
  if (!obj) return false;
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

function parseNonNegativeInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.floor(parsed);
}

function parsePositiveIntegerEnvironmentValue(
  name: string,
  value: string | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parsePositiveNumberEnvironmentValue(
  name: string,
  value: string | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
  return parsed;
}

function validateTestProductsRetentionOverrides(
  overrides: RuntimeConfigOverrides | undefined,
): void {
  if (hasOwnProperty(overrides, 'testProductsMaxCount')) {
    const maxCount = overrides.testProductsMaxCount;
    if (typeof maxCount !== 'number' || !Number.isInteger(maxCount) || maxCount < 1) {
      throw new Error('testProductsMaxCount must be a positive integer');
    }
  }
  if (hasOwnProperty(overrides, 'testProductsMaxAgeDays')) {
    const maxAgeDays = overrides.testProductsMaxAgeDays;
    if (typeof maxAgeDays !== 'number' || !Number.isFinite(maxAgeDays) || maxAgeDays <= 0) {
      throw new Error('testProductsMaxAgeDays must be a positive finite number');
    }
  }
}

function parseEnabledWorkflows(value: string | undefined): string[] | undefined {
  if (value == null) return undefined;
  const normalized = value
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  return normalized;
}

function parseUiDebuggerGuardMode(value: string | undefined): UiDebuggerGuardMode | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (['off', '0', 'false', 'no'].includes(normalized)) return 'off';
  if (['warn', 'warning'].includes(normalized)) return 'warn';
  if (['error', '1', 'true', 'yes', 'on'].includes(normalized)) return 'error';
  return undefined;
}

function parseFilePathRenderStyle(value: string | undefined): FilePathRenderStyle | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (isFilePathRenderStyle(normalized)) return normalized;
  log('warn', `Unsupported file path render style '${value}', falling back to defaults.`);
  return undefined;
}

function parseDebuggerBackend(value: string | undefined): DebuggerBackendKind | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'lldb' || normalized === 'lldb-cli') return 'lldb-cli';
  if (normalized === 'dap') return 'dap';
  log('warn', `Unsupported debugger backend '${value}', falling back to defaults.`);
  return undefined;
}

function getErrorKind(error: unknown): string {
  if (error instanceof Error) {
    return error.name || 'Error';
  }
  return typeof error;
}

function setIfDefined<K extends keyof RuntimeConfigOverrides>(
  config: RuntimeConfigOverrides,
  key: K,
  value: RuntimeConfigOverrides[K] | undefined,
): void {
  if (value !== undefined) {
    config[key] = value;
  }
}

function readEnvConfig(env: NodeJS.ProcessEnv): RuntimeConfigOverrides {
  const config: RuntimeConfigOverrides = {};

  setIfDefined(
    config,
    'enabledWorkflows',
    parseEnabledWorkflows(env.XCODEBUILDMCP_ENABLED_WORKFLOWS),
  );

  setIfDefined(config, 'debug', parseBoolean(env.XCODEBUILDMCP_DEBUG));
  setIfDefined(config, 'sentryDisabled', parseBoolean(env.XCODEBUILDMCP_SENTRY_DISABLED));

  setIfDefined(
    config,
    'experimentalWorkflowDiscovery',
    parseBoolean(env.XCODEBUILDMCP_EXPERIMENTAL_WORKFLOW_DISCOVERY),
  );

  setIfDefined(
    config,
    'disableSessionDefaults',
    parseBoolean(env.XCODEBUILDMCP_DISABLE_SESSION_DEFAULTS),
  );

  setIfDefined(
    config,
    'disableXcodeAutoSync',
    parseBoolean(env.XCODEBUILDMCP_DISABLE_XCODE_AUTO_SYNC),
  );

  setIfDefined(config, 'showTestTiming', parseBoolean(env.XCODEBUILDMCP_SHOW_TEST_TIMING));

  setIfDefined(
    config,
    'filePathRenderStyle',
    parseFilePathRenderStyle(env.XCODEBUILDMCP_FILE_PATH_RENDER_STYLE),
  );

  setIfDefined(
    config,
    'uiDebuggerGuardMode',
    parseUiDebuggerGuardMode(env.XCODEBUILDMCP_UI_DEBUGGER_GUARD_MODE),
  );

  setIfDefined(config, 'incrementalBuildsEnabled', parseBoolean(env.INCREMENTAL_BUILDS_ENABLED));

  setIfDefined(
    config,
    'testProductsMaxCount',
    parsePositiveIntegerEnvironmentValue(
      'XCODEBUILDMCP_TEST_PRODUCTS_MAX_COUNT',
      env.XCODEBUILDMCP_TEST_PRODUCTS_MAX_COUNT,
    ),
  );

  setIfDefined(
    config,
    'testProductsMaxAgeDays',
    parsePositiveNumberEnvironmentValue(
      'XCODEBUILDMCP_TEST_PRODUCTS_MAX_AGE_DAYS',
      env.XCODEBUILDMCP_TEST_PRODUCTS_MAX_AGE_DAYS,
    ),
  );

  const axePath = env.XCODEBUILDMCP_AXE_PATH ?? env.AXE_PATH;
  if (axePath) config.axePath = axePath;

  const axeSourcePath = env.XCODEBUILDMCP_AXE_SOURCE_PATH ?? env.AXE_SOURCE_PATH;
  if (axeSourcePath) config.axeSourcePath = axeSourcePath;

  const iosTemplatePath = env.XCODEBUILDMCP_IOS_TEMPLATE_PATH;
  if (iosTemplatePath) config.iosTemplatePath = iosTemplatePath;

  const macosTemplatePath = env.XCODEBUILDMCP_MACOS_TEMPLATE_PATH;
  if (macosTemplatePath) config.macosTemplatePath = macosTemplatePath;

  const iosTemplateVersion =
    env.XCODEBUILD_MCP_IOS_TEMPLATE_VERSION ?? env.XCODEBUILD_MCP_TEMPLATE_VERSION;
  if (iosTemplateVersion) config.iosTemplateVersion = iosTemplateVersion;

  const macosTemplateVersion =
    env.XCODEBUILD_MCP_MACOS_TEMPLATE_VERSION ?? env.XCODEBUILD_MCP_TEMPLATE_VERSION;
  if (macosTemplateVersion) config.macosTemplateVersion = macosTemplateVersion;

  setIfDefined(config, 'debuggerBackend', parseDebuggerBackend(env.XCODEBUILDMCP_DEBUGGER_BACKEND));

  setIfDefined(
    config,
    'dapRequestTimeoutMs',
    parsePositiveInt(env.XCODEBUILDMCP_DAP_REQUEST_TIMEOUT_MS),
  );

  setIfDefined(config, 'dapLogEvents', parseBoolean(env.XCODEBUILDMCP_DAP_LOG_EVENTS));

  setIfDefined(config, 'launchJsonWaitMs', parseNonNegativeInt(env.XBMCP_LAUNCH_JSON_WAIT_MS));

  return config;
}

function readEnvSessionDefaults(env: NodeJS.ProcessEnv): Partial<SessionDefaults> | undefined {
  const defaults: Partial<SessionDefaults> = {};
  let hasAny = false;

  function setString<K extends keyof SessionDefaults>(key: K, value: string | undefined): void {
    if (value) {
      (defaults as Record<string, unknown>)[key] = value;
      hasAny = true;
    }
  }

  function setBool<K extends keyof SessionDefaults>(key: K, value: string | undefined): void {
    const parsed = parseBoolean(value);
    if (parsed !== undefined) {
      (defaults as Record<string, unknown>)[key] = parsed;
      hasAny = true;
    }
  }

  setString('workspacePath', env.XCODEBUILDMCP_WORKSPACE_PATH);
  setString('projectPath', env.XCODEBUILDMCP_PROJECT_PATH);
  setString('scheme', env.XCODEBUILDMCP_SCHEME);
  setString('configuration', env.XCODEBUILDMCP_CONFIGURATION);
  setString('simulatorName', env.XCODEBUILDMCP_SIMULATOR_NAME);
  setString('simulatorId', env.XCODEBUILDMCP_SIMULATOR_ID);
  setString('deviceId', env.XCODEBUILDMCP_DEVICE_ID);
  setString('derivedDataPath', env.XCODEBUILDMCP_DERIVED_DATA_PATH);
  setString('platform', env.XCODEBUILDMCP_PLATFORM);
  setString('bundleId', env.XCODEBUILDMCP_BUNDLE_ID);
  setBool('useLatestOS', env.XCODEBUILDMCP_USE_LATEST_OS);
  setBool('suppressWarnings', env.XCODEBUILDMCP_SUPPRESS_WARNINGS);
  setBool('preferXcodebuild', env.XCODEBUILDMCP_PREFER_XCODEBUILD);

  const simulatorPlatform = env.XCODEBUILDMCP_SIMULATOR_PLATFORM;
  if (simulatorPlatform) {
    const valid = ['iOS Simulator', 'watchOS Simulator', 'tvOS Simulator', 'visionOS Simulator'];
    if (valid.includes(simulatorPlatform)) {
      defaults.simulatorPlatform = simulatorPlatform as SessionDefaults['simulatorPlatform'];
      hasAny = true;
    }
  }

  const arch = env.XCODEBUILDMCP_ARCH;
  if (arch === 'arm64' || arch === 'x86_64') {
    defaults.arch = arch;
    hasAny = true;
  }

  return hasAny ? defaults : undefined;
}

function resolveFromLayers<T>(opts: {
  key: keyof RuntimeConfigOverrides;
  overrides?: RuntimeConfigOverrides;
  fileConfig?: ProjectConfig;
  envConfig: RuntimeConfigOverrides;
  fallback: T;
}): T;
function resolveFromLayers<T>(opts: {
  key: keyof RuntimeConfigOverrides;
  overrides?: RuntimeConfigOverrides;
  fileConfig?: ProjectConfig;
  envConfig: RuntimeConfigOverrides;
  fallback?: undefined;
}): T | undefined;
function resolveFromLayers<T>(opts: {
  key: keyof RuntimeConfigOverrides;
  overrides?: RuntimeConfigOverrides;
  fileConfig?: ProjectConfig;
  envConfig: RuntimeConfigOverrides;
  fallback?: T;
}): T | undefined {
  const { key, overrides, fileConfig, envConfig, fallback } = opts;
  if (hasOwnProperty(overrides, key)) {
    return overrides[key] as T | undefined;
  }
  if (hasOwnProperty(fileConfig, key)) {
    return fileConfig[key] as T | undefined;
  }
  if (hasOwnProperty(envConfig, key)) {
    return envConfig[key] as T | undefined;
  }
  return fallback;
}

function resolveSessionDefaults(opts: {
  overrides?: RuntimeConfigOverrides;
  fileConfig?: ProjectConfig;
  env?: NodeJS.ProcessEnv;
}): Partial<SessionDefaults> | undefined {
  const overrideDefaults = opts.overrides?.sessionDefaults;
  const fileDefaults = opts.fileConfig?.sessionDefaults;
  const envDefaults = readEnvSessionDefaults(opts.env ?? process.env);
  if (!overrideDefaults && !fileDefaults && !envDefaults) return undefined;
  return { ...(envDefaults ?? {}), ...(fileDefaults ?? {}), ...(overrideDefaults ?? {}) };
}

function resolveSessionDefaultsProfiles(opts: {
  overrides?: RuntimeConfigOverrides;
  fileConfig?: ProjectConfig;
}): Record<string, Partial<SessionDefaults>> | undefined {
  const overrideProfiles = opts.overrides?.sessionDefaultsProfiles;
  const fileProfiles = opts.fileConfig?.sessionDefaultsProfiles;
  if (!overrideProfiles && !fileProfiles) return undefined;

  const merged: Record<string, Partial<SessionDefaults>> = {};
  for (const [name, defaults] of Object.entries(fileProfiles ?? {})) {
    merged[name] = { ...defaults };
  }
  for (const [name, defaults] of Object.entries(overrideProfiles ?? {})) {
    merged[name] = { ...(merged[name] ?? {}), ...defaults };
  }
  return merged;
}

function resolveActiveSessionDefaultsProfile(opts: {
  overrides?: RuntimeConfigOverrides;
  fileConfig?: ProjectConfig;
}): string | undefined {
  if (hasOwnProperty(opts.overrides, 'activeSessionDefaultsProfile')) {
    return opts.overrides.activeSessionDefaultsProfile;
  }
  if (hasOwnProperty(opts.fileConfig, 'activeSessionDefaultsProfile')) {
    return opts.fileConfig.activeSessionDefaultsProfile;
  }
  return undefined;
}

function refreshResolvedSessionFields(): void {
  storeState.resolved.sessionDefaults = resolveSessionDefaults({
    overrides: storeState.overrides,
    fileConfig: storeState.fileConfig,
    env: storeState.env,
  });
  storeState.resolved.sessionDefaultsProfiles = resolveSessionDefaultsProfiles({
    overrides: storeState.overrides,
    fileConfig: storeState.fileConfig,
  });
  storeState.resolved.activeSessionDefaultsProfile = resolveActiveSessionDefaultsProfile({
    overrides: storeState.overrides,
    fileConfig: storeState.fileConfig,
  });
}

function getCurrentFileConfig(): ProjectConfig {
  return storeState.fileConfig ?? { schemaVersion: 1 };
}

function applySessionDefaultsPatchToFileConfig(opts: {
  fileConfig: ProjectConfig;
  profile: string | null;
  patch: Partial<SessionDefaults>;
  deleteKeys?: (keyof SessionDefaults)[];
}): ProjectConfig {
  const nextFileConfig: ProjectConfig = { ...opts.fileConfig };
  const baseDefaults =
    opts.profile === null
      ? (nextFileConfig.sessionDefaults ?? {})
      : (nextFileConfig.sessionDefaultsProfiles?.[opts.profile] ?? {});

  const nextSessionDefaults: Partial<SessionDefaults> = { ...baseDefaults, ...opts.patch };
  for (const key of opts.deleteKeys ?? []) {
    delete nextSessionDefaults[key];
  }

  if (opts.profile === null) {
    nextFileConfig.sessionDefaults = nextSessionDefaults;
    return nextFileConfig;
  }

  nextFileConfig.sessionDefaultsProfiles = {
    ...(nextFileConfig.sessionDefaultsProfiles ?? {}),
    [opts.profile]: nextSessionDefaults,
  };
  return nextFileConfig;
}

function applyActiveProfileToFileConfig(opts: {
  fileConfig: ProjectConfig;
  profile: string | null;
}): ProjectConfig {
  const nextFileConfig: ProjectConfig = { ...opts.fileConfig };
  if (opts.profile === null) {
    delete nextFileConfig.activeSessionDefaultsProfile;
  } else {
    nextFileConfig.activeSessionDefaultsProfile = opts.profile;
  }
  return nextFileConfig;
}

function resolveConfig(opts: {
  fileConfig?: ProjectConfig;
  overrides?: RuntimeConfigOverrides;
  env?: NodeJS.ProcessEnv;
}): ResolvedRuntimeConfig {
  validateTestProductsRetentionOverrides(opts.overrides);
  const envConfig = readEnvConfig(opts.env ?? process.env);

  return {
    enabledWorkflows: resolveFromLayers<string[]>({
      key: 'enabledWorkflows',
      overrides: opts.overrides,
      fileConfig: opts.fileConfig,
      envConfig,
      fallback: DEFAULT_CONFIG.enabledWorkflows,
    }),
    customWorkflows: resolveFromLayers<Record<string, string[]>>({
      key: 'customWorkflows',
      overrides: opts.overrides,
      fileConfig: opts.fileConfig,
      envConfig,
      fallback: DEFAULT_CONFIG.customWorkflows,
    }),
    debug: resolveFromLayers({
      key: 'debug',
      overrides: opts.overrides,
      fileConfig: opts.fileConfig,
      envConfig,
      fallback: DEFAULT_CONFIG.debug,
    }),
    sentryDisabled: resolveFromLayers({
      key: 'sentryDisabled',
      overrides: opts.overrides,
      fileConfig: opts.fileConfig,
      envConfig,
      fallback: DEFAULT_CONFIG.sentryDisabled,
    }),
    experimentalWorkflowDiscovery: resolveFromLayers({
      key: 'experimentalWorkflowDiscovery',
      overrides: opts.overrides,
      fileConfig: opts.fileConfig,
      envConfig,
      fallback: DEFAULT_CONFIG.experimentalWorkflowDiscovery,
    }),
    disableSessionDefaults: resolveFromLayers({
      key: 'disableSessionDefaults',
      overrides: opts.overrides,
      fileConfig: opts.fileConfig,
      envConfig,
      fallback: DEFAULT_CONFIG.disableSessionDefaults,
    }),
    disableXcodeAutoSync: resolveFromLayers({
      key: 'disableXcodeAutoSync',
      overrides: opts.overrides,
      fileConfig: opts.fileConfig,
      envConfig,
      fallback: DEFAULT_CONFIG.disableXcodeAutoSync,
    }),
    showTestTiming: resolveFromLayers({
      key: 'showTestTiming',
      overrides: opts.overrides,
      fileConfig: opts.fileConfig,
      envConfig,
      fallback: DEFAULT_CONFIG.showTestTiming,
    }),
    filePathRenderStyle: resolveFromLayers<FilePathRenderStyle>({
      key: 'filePathRenderStyle',
      overrides: opts.overrides,
      fileConfig: opts.fileConfig,
      envConfig,
    }),
    uiDebuggerGuardMode: resolveFromLayers({
      key: 'uiDebuggerGuardMode',
      overrides: opts.overrides,
      fileConfig: opts.fileConfig,
      envConfig,
      fallback: DEFAULT_CONFIG.uiDebuggerGuardMode,
    }),
    incrementalBuildsEnabled: resolveFromLayers({
      key: 'incrementalBuildsEnabled',
      overrides: opts.overrides,
      fileConfig: opts.fileConfig,
      envConfig,
      fallback: DEFAULT_CONFIG.incrementalBuildsEnabled,
    }),
    testProductsMaxCount: resolveFromLayers({
      key: 'testProductsMaxCount',
      overrides: opts.overrides,
      envConfig,
      fallback: DEFAULT_CONFIG.testProductsMaxCount,
    }),
    testProductsMaxAgeDays: resolveFromLayers({
      key: 'testProductsMaxAgeDays',
      overrides: opts.overrides,
      envConfig,
      fallback: DEFAULT_CONFIG.testProductsMaxAgeDays,
    }),
    dapRequestTimeoutMs: resolveFromLayers({
      key: 'dapRequestTimeoutMs',
      overrides: opts.overrides,
      fileConfig: opts.fileConfig,
      envConfig,
      fallback: DEFAULT_CONFIG.dapRequestTimeoutMs,
    }),
    dapLogEvents: resolveFromLayers({
      key: 'dapLogEvents',
      overrides: opts.overrides,
      fileConfig: opts.fileConfig,
      envConfig,
      fallback: DEFAULT_CONFIG.dapLogEvents,
    }),
    launchJsonWaitMs: resolveFromLayers({
      key: 'launchJsonWaitMs',
      overrides: opts.overrides,
      fileConfig: opts.fileConfig,
      envConfig,
      fallback: DEFAULT_CONFIG.launchJsonWaitMs,
    }),
    axePath: resolveFromLayers<string>({
      key: 'axePath',
      overrides: opts.overrides,
      fileConfig: opts.fileConfig,
      envConfig,
    }),
    axeSourcePath: resolveFromLayers<string>({
      key: 'axeSourcePath',
      overrides: opts.overrides,
      fileConfig: opts.fileConfig,
      envConfig,
    }),
    iosTemplatePath: resolveFromLayers<string>({
      key: 'iosTemplatePath',
      overrides: opts.overrides,
      fileConfig: opts.fileConfig,
      envConfig,
    }),
    iosTemplateVersion: resolveFromLayers<string>({
      key: 'iosTemplateVersion',
      overrides: opts.overrides,
      fileConfig: opts.fileConfig,
      envConfig,
    }),
    macosTemplatePath: resolveFromLayers<string>({
      key: 'macosTemplatePath',
      overrides: opts.overrides,
      fileConfig: opts.fileConfig,
      envConfig,
    }),
    macosTemplateVersion: resolveFromLayers<string>({
      key: 'macosTemplateVersion',
      overrides: opts.overrides,
      fileConfig: opts.fileConfig,
      envConfig,
    }),
    debuggerBackend: resolveFromLayers({
      key: 'debuggerBackend',
      overrides: opts.overrides,
      fileConfig: opts.fileConfig,
      envConfig,
      fallback: DEFAULT_CONFIG.debuggerBackend,
    }),
    sessionDefaults: resolveSessionDefaults({
      overrides: opts.overrides,
      fileConfig: opts.fileConfig,
      env: opts.env,
    }),
    sessionDefaultsProfiles: resolveSessionDefaultsProfiles({
      overrides: opts.overrides,
      fileConfig: opts.fileConfig,
    }),
    activeSessionDefaultsProfile: resolveActiveSessionDefaultsProfile({
      overrides: opts.overrides,
      fileConfig: opts.fileConfig,
    }),
  };
}

export async function initConfigStore(opts: {
  cwd: string;
  fs: FileSystemExecutor;
  overrides?: RuntimeConfigOverrides;
  env?: NodeJS.ProcessEnv;
}): Promise<{ found: boolean; path?: string; notices: string[] }> {
  storeState.cwd = opts.cwd;
  storeState.fs = opts.fs;
  storeState.env = opts.env;
  storeState.overrides = opts.overrides;

  let fileConfig: ProjectConfig | undefined;
  let found = false;
  let path: string | undefined;
  let notices: string[] = [];

  try {
    const result = await loadProjectConfig({ fs: opts.fs, cwd: opts.cwd });
    if (result.found) {
      fileConfig = result.config;
      found = true;
      path = result.path;
      notices = result.notices;
    } else if ('error' in result) {
      const errorMessage =
        result.error instanceof Error ? result.error.message : String(result.error);
      log('warn', `Failed to read or parse project config at ${result.path}. ${errorMessage}`);
      log('warn', '[infra/config-store] project config read/parse failed', { sentry: true });
    }
  } catch (error) {
    log('warn', `Failed to load project config from ${opts.cwd}. ${error}`);
    log('warn', `[infra/config-store] project config load threw (${getErrorKind(error)})`, {
      sentry: true,
    });
  }

  storeState.fileConfig = fileConfig;
  storeState.resolved = resolveConfig({ fileConfig, overrides: opts.overrides, env: opts.env });
  storeState.initialized = true;
  return { found, path, notices };
}

export function getConfig(): ResolvedRuntimeConfig {
  if (!storeState.initialized) {
    return resolveConfig({});
  }

  return storeState.resolved;
}

export async function persistSessionDefaultsPatch(opts: {
  patch: Partial<SessionDefaults>;
  deleteKeys?: (keyof SessionDefaults)[];
  profile?: string | null;
}): Promise<{ path: string }> {
  if (!storeState.initialized || !storeState.fs || !storeState.cwd) {
    throw new Error('Config store has not been initialized.');
  }

  const normalizedProfile = normalizeSessionDefaultsProfileName(opts.profile);

  const result = await persistSessionDefaultsToProjectConfig({
    fs: storeState.fs,
    cwd: storeState.cwd,
    patch: opts.patch,
    deleteKeys: opts.deleteKeys,
    profile: normalizedProfile,
  });

  storeState.fileConfig = applySessionDefaultsPatchToFileConfig({
    fileConfig: getCurrentFileConfig(),
    profile: normalizedProfile,
    patch: opts.patch,
    deleteKeys: opts.deleteKeys,
  });
  refreshResolvedSessionFields();

  return result;
}

export async function persistActiveSessionDefaultsProfile(
  profile: string | null,
): Promise<{ path: string }> {
  if (!storeState.initialized || !storeState.fs || !storeState.cwd) {
    throw new Error('Config store has not been initialized.');
  }

  const normalizedProfile = normalizeSessionDefaultsProfileName(profile);

  const result = await persistActiveSessionDefaultsProfileToProjectConfig({
    fs: storeState.fs,
    cwd: storeState.cwd,
    profile: normalizedProfile,
  });

  storeState.fileConfig = applyActiveProfileToFileConfig({
    fileConfig: getCurrentFileConfig(),
    profile: normalizedProfile,
  });
  refreshResolvedSessionFields();

  return result;
}

export function __resetConfigStoreForTests(): void {
  storeState.initialized = false;
  storeState.cwd = undefined;
  storeState.fs = undefined;
  storeState.env = undefined;
  storeState.overrides = undefined;
  storeState.fileConfig = undefined;
  storeState.resolved = { ...DEFAULT_CONFIG };
}
