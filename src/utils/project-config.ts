import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { FileSystemExecutor } from './FileSystemExecutor.ts';
import type { SessionDefaults } from './session-store.ts';
import { log } from './logger.ts';
import { removeUndefined } from './remove-undefined.ts';
import { runtimeConfigFileSchema, type RuntimeConfigFile } from './runtime-config-schema.ts';
import type { FilePathRenderStyle } from './runtime-config-types.ts';
import { normalizeSessionDefaultsProfileName } from './session-defaults-profile.ts';
import { resolvePathFromCwd } from './path.ts';

const CONFIG_DIR = '.mobilebuildmcp';
const CONFIG_FILE = 'config.yaml';

export type ProjectConfig = RuntimeConfigFile & {
  schemaVersion: 1;
  sessionDefaults?: Partial<SessionDefaults>;
  sessionDefaultsProfiles?: Record<string, Partial<SessionDefaults>>;
  activeSessionDefaultsProfile?: string;
  enabledWorkflows?: string[];
  customWorkflows?: Record<string, string[]>;
  debuggerBackend?: 'dap' | 'lldb-cli';
  filePathRenderStyle?: FilePathRenderStyle;
  [key: string]: unknown;
};

export type LoadProjectConfigOptions = {
  fs: FileSystemExecutor;
  cwd: string;
};

export type LoadProjectConfigResult =
  | { found: false }
  | { found: false; path: string; error: Error }
  | { found: true; path: string; config: ProjectConfig; notices: string[] };

export type PersistSessionDefaultsOptions = {
  fs: FileSystemExecutor;
  cwd: string;
  patch: Partial<SessionDefaults>;
  deleteKeys?: (keyof SessionDefaults)[];
  profile?: string | null;
};

export type PersistActiveSessionDefaultsProfileOptions = {
  fs: FileSystemExecutor;
  cwd: string;
  profile?: string | null;
};

export type SetupPreferences = {
  platforms?: ('macOS' | 'iOS' | 'tvOS' | 'watchOS' | 'visionOS')[];
};

export type PersistProjectConfigPatchOptions = {
  fs: FileSystemExecutor;
  cwd: string;
  patch: {
    enabledWorkflows?: string[];
    debug?: boolean;
    sentryDisabled?: boolean;
    experimentalWorkflowDiscovery?: boolean;
    disableSessionDefaults?: boolean;
    filePathRenderStyle?: FilePathRenderStyle;
    sessionDefaults?: Partial<SessionDefaults>;
    setupPreferences?: SetupPreferences | null;
  };
  deleteSessionDefaultKeys?: (keyof SessionDefaults)[];
};

type PersistenceTargetOptions = {
  fs: FileSystemExecutor;
  configPath: string;
};

function getConfigDir(cwd: string): string {
  return path.join(cwd, CONFIG_DIR);
}

function getConfigPath(cwd: string): string {
  return path.join(getConfigDir(cwd), CONFIG_FILE);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function hasValue<T extends Record<string, unknown>>(defaults: T, key: keyof T): boolean {
  return Object.prototype.hasOwnProperty.call(defaults, key) && defaults[key] !== undefined;
}

function normalizeMutualExclusivity(defaults: Partial<SessionDefaults>): {
  normalized: Partial<SessionDefaults>;
  notices: string[];
} {
  const normalized: Partial<SessionDefaults> = { ...defaults };
  const notices: string[] = [];

  if (hasValue(normalized, 'projectPath') && hasValue(normalized, 'workspacePath')) {
    delete normalized.projectPath;
    notices.push('Both projectPath and workspacePath were provided; keeping workspacePath.');
  }

  if (hasValue(normalized, 'simulatorId') && hasValue(normalized, 'simulatorName')) {
    notices.push(
      'Both simulatorId and simulatorName were provided; storing both and preferring simulatorId when disambiguating.',
    );
  }

  return { normalized, notices };
}

function tryFileUrlToPath(value: string): string | null {
  if (!value.startsWith('file:')) {
    return null;
  }

  try {
    return fileURLToPath(value);
  } catch (error) {
    log('warn', `Failed to parse file URL path: ${value}. ${String(error)}`);
    return null;
  }
}

function normalizePathValue(value: string, cwd: string): string {
  const fileUrlPath = tryFileUrlToPath(value);
  if (fileUrlPath) {
    return fileUrlPath;
  }

  return resolvePathFromCwd(value, cwd);
}

function resolveRelativeSessionPaths(
  defaults: Partial<SessionDefaults>,
  cwd: string,
): Partial<SessionDefaults> {
  const resolved: Partial<SessionDefaults> = { ...defaults };
  const pathKeys = ['projectPath', 'workspacePath', 'derivedDataPath'] as const;

  for (const key of pathKeys) {
    const value = resolved[key];
    if (typeof value === 'string' && value.length > 0) {
      resolved[key] = normalizePathValue(value, cwd);
    }
  }

  return resolved;
}

function normalizeEnabledWorkflows(value: unknown): string[] {
  if (value == null) return [];
  if (Array.isArray(value)) {
    const normalized = value
      .filter((name): name is string => typeof name === 'string')
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean);
    return normalized;
  }
  if (typeof value === 'string') {
    const normalized = value
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean);
    return normalized;
  }
  return [];
}

function normalizeCustomWorkflows(value: unknown): Record<string, string[]> {
  if (!isPlainObject(value)) {
    return {};
  }

  const normalized: Record<string, string[]> = {};

  for (const [workflowName, workflowTools] of Object.entries(value)) {
    const normalizedWorkflowName = workflowName.trim().toLowerCase();
    if (!normalizedWorkflowName) {
      continue;
    }
    if (Array.isArray(workflowTools)) {
      normalized[normalizedWorkflowName] = workflowTools
        .filter((toolName): toolName is string => typeof toolName === 'string')
        .map((toolName) => toolName.trim().toLowerCase())
        .filter(Boolean);
      continue;
    }
    if (typeof workflowTools === 'string') {
      normalized[normalizedWorkflowName] = workflowTools
        .split(',')
        .map((toolName) => toolName.trim().toLowerCase())
        .filter(Boolean);
      continue;
    }
  }

  return normalized;
}

function resolveRelativeTopLevelPaths(config: ProjectConfig, cwd: string): ProjectConfig {
  const resolved: ProjectConfig = { ...config };
  const pathKeys = ['axePath', 'axeSourcePath', 'iosTemplatePath', 'macosTemplatePath'] as const;

  for (const key of pathKeys) {
    const value = resolved[key];
    if (typeof value === 'string' && value.length > 0) {
      resolved[key] = normalizePathValue(value, cwd);
    }
  }

  return resolved;
}

function normalizeSessionDefaultsProfiles(
  profiles: Record<string, Partial<SessionDefaults>>,
  cwd: string,
): { profiles: Record<string, Partial<SessionDefaults>>; notices: string[] } {
  const normalizedProfiles: Record<string, Partial<SessionDefaults>> = {};
  const notices: string[] = [];

  for (const [profileName, defaults] of Object.entries(profiles)) {
    const trimmedName = profileName.trim();
    if (trimmedName.length === 0) {
      notices.push('Ignored sessionDefaultsProfiles entry with an empty profile name.');
      continue;
    }
    const normalized = normalizeMutualExclusivity(defaults);
    notices.push(...normalized.notices.map((notice) => `[profile:${trimmedName}] ${notice}`));
    normalizedProfiles[trimmedName] = resolveRelativeSessionPaths(normalized.normalized, cwd);
  }

  return { profiles: normalizedProfiles, notices };
}

function normalizeDebuggerBackend(config: RuntimeConfigFile): ProjectConfig {
  if (config.debuggerBackend === 'lldb') {
    const normalized: RuntimeConfigFile = { ...config, debuggerBackend: 'lldb-cli' };
    return toProjectConfig(normalized);
  }
  return toProjectConfig(config);
}

function normalizeConfigForPersistence(config: RuntimeConfigFile): ProjectConfig {
  let base = normalizeDebuggerBackend(config);
  if (config.enabledWorkflows !== undefined) {
    base = { ...base, enabledWorkflows: normalizeEnabledWorkflows(config.enabledWorkflows) };
  }
  if (config.customWorkflows !== undefined) {
    base = { ...base, customWorkflows: normalizeCustomWorkflows(config.customWorkflows) };
  }
  return base;
}

function toProjectConfig(config: RuntimeConfigFile): ProjectConfig {
  return config as ProjectConfig;
}

function parseProjectConfig(rawText: string): RuntimeConfigFile {
  const parsed: unknown = parseYaml(rawText);
  if (!isPlainObject(parsed)) {
    throw new Error('Project config must be an object');
  }
  return runtimeConfigFileSchema.parse(parsed) as RuntimeConfigFile;
}

async function readBaseConfigForPersistence(
  options: PersistenceTargetOptions,
): Promise<ProjectConfig> {
  if (!options.fs.existsSync(options.configPath)) {
    return { schemaVersion: 1 };
  }

  try {
    const rawText = await options.fs.readFile(options.configPath, 'utf8');
    const parsed = parseProjectConfig(rawText);
    return { ...normalizeConfigForPersistence(parsed), schemaVersion: 1 };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(
      'warn',
      `Failed to read or parse project config at ${options.configPath}. Overwriting with new config. ${errorMessage}`,
    );
    return { schemaVersion: 1 };
  }
}

export async function loadProjectConfig(
  options: LoadProjectConfigOptions,
): Promise<LoadProjectConfigResult> {
  const configPath = getConfigPath(options.cwd);

  if (!options.fs.existsSync(configPath)) {
    return { found: false };
  }

  try {
    const rawText = await options.fs.readFile(configPath, 'utf8');
    const parsed = parseProjectConfig(rawText);
    const notices: string[] = [];

    let config = normalizeDebuggerBackend(parsed);

    if (parsed.enabledWorkflows !== undefined) {
      const normalizedWorkflows = normalizeEnabledWorkflows(parsed.enabledWorkflows);
      config = { ...config, enabledWorkflows: normalizedWorkflows };
    }
    if (parsed.customWorkflows !== undefined) {
      const normalizedCustomWorkflows = normalizeCustomWorkflows(parsed.customWorkflows);
      config = { ...config, customWorkflows: normalizedCustomWorkflows };
    }

    if (config.sessionDefaults) {
      const normalized = normalizeMutualExclusivity(config.sessionDefaults);
      notices.push(...normalized.notices);
      const resolved = resolveRelativeSessionPaths(normalized.normalized, options.cwd);
      config = { ...config, sessionDefaults: resolved };
    }

    if (config.sessionDefaultsProfiles) {
      const normalizedProfiles = normalizeSessionDefaultsProfiles(
        config.sessionDefaultsProfiles,
        options.cwd,
      );
      notices.push(...normalizedProfiles.notices);
      config = { ...config, sessionDefaultsProfiles: normalizedProfiles.profiles };
    }

    config = resolveRelativeTopLevelPaths(config, options.cwd);

    return { found: true, path: configPath, config, notices };
  } catch (error) {
    return { found: false, path: configPath, error: toError(error) };
  }
}

export async function persistSessionDefaultsToProjectConfig(
  options: PersistSessionDefaultsOptions,
): Promise<{ path: string }> {
  const configDir = getConfigDir(options.cwd);
  const configPath = getConfigPath(options.cwd);

  await options.fs.mkdir(configDir, { recursive: true });
  const baseConfig = await readBaseConfigForPersistence({ fs: options.fs, configPath });

  const patch = removeUndefined(options.patch as Record<string, unknown>);
  const targetProfile = normalizeSessionDefaultsProfileName(options.profile);
  const isGlobalProfile = targetProfile === null;
  const baseDefaults = isGlobalProfile
    ? (baseConfig.sessionDefaults ?? {})
    : (baseConfig.sessionDefaultsProfiles?.[targetProfile] ?? {});
  const nextSessionDefaults: Partial<SessionDefaults> = { ...baseDefaults, ...patch };

  const nextConfig: ProjectConfig = {
    ...baseConfig,
    schemaVersion: 1,
  };
  for (const key of options.deleteKeys ?? []) {
    delete nextSessionDefaults[key];
  }
  if (isGlobalProfile) {
    nextConfig.sessionDefaults = nextSessionDefaults;
  } else {
    nextConfig.sessionDefaultsProfiles = {
      ...(nextConfig.sessionDefaultsProfiles ?? {}),
      [targetProfile]: nextSessionDefaults,
    };
  }

  await options.fs.writeFile(configPath, stringifyYaml(nextConfig), 'utf8');

  return { path: configPath };
}

export async function persistActiveSessionDefaultsProfileToProjectConfig(
  options: PersistActiveSessionDefaultsProfileOptions,
): Promise<{ path: string }> {
  const configDir = getConfigDir(options.cwd);
  const configPath = getConfigPath(options.cwd);

  await options.fs.mkdir(configDir, { recursive: true });
  const baseConfig = await readBaseConfigForPersistence({ fs: options.fs, configPath });

  const nextConfig: ProjectConfig = { ...baseConfig, schemaVersion: 1 };
  const activeProfile = normalizeSessionDefaultsProfileName(options.profile);
  if (activeProfile === null) {
    delete nextConfig.activeSessionDefaultsProfile;
  } else {
    nextConfig.activeSessionDefaultsProfile = activeProfile;
  }

  await options.fs.writeFile(configPath, stringifyYaml(nextConfig), 'utf8');

  return { path: configPath };
}

export async function persistProjectConfigPatch(
  options: PersistProjectConfigPatchOptions,
): Promise<{ path: string }> {
  const configDir = getConfigDir(options.cwd);
  const configPath = getConfigPath(options.cwd);

  await options.fs.mkdir(configDir, { recursive: true });
  const baseConfig = await readBaseConfigForPersistence({ fs: options.fs, configPath });

  const nextConfig: ProjectConfig = {
    ...baseConfig,
    schemaVersion: 1,
  };

  if (options.patch.enabledWorkflows !== undefined) {
    nextConfig.enabledWorkflows = normalizeEnabledWorkflows(options.patch.enabledWorkflows);
  }

  const topLevelPatch = removeUndefined({
    debug: options.patch.debug,
    sentryDisabled: options.patch.sentryDisabled,
    experimentalWorkflowDiscovery: options.patch.experimentalWorkflowDiscovery,
    disableSessionDefaults: options.patch.disableSessionDefaults,
    filePathRenderStyle: options.patch.filePathRenderStyle,
  });

  for (const [key, value] of Object.entries(topLevelPatch)) {
    nextConfig[key] = value;
  }

  if (options.patch.setupPreferences === null) {
    delete nextConfig.setupPreferences;
  } else if (options.patch.setupPreferences !== undefined) {
    nextConfig.setupPreferences = options.patch.setupPreferences;
  }

  if (options.patch.sessionDefaults) {
    const patch = removeUndefined(options.patch.sessionDefaults as Record<string, unknown>);
    const nextSessionDefaults: Partial<SessionDefaults> = {
      ...(nextConfig.sessionDefaults ?? {}),
      ...patch,
    };

    for (const key of options.deleteSessionDefaultKeys ?? []) {
      delete nextSessionDefaults[key];
    }

    nextConfig.sessionDefaults = nextSessionDefaults;
  }

  await options.fs.writeFile(configPath, stringifyYaml(nextConfig), 'utf8');

  return { path: configPath };
}
