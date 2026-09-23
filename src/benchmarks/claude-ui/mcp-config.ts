import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { sessionDefaultEnvNames, validateSessionDefaults } from './config.ts';
import { repoRoot, serverName } from './constants.ts';
import type { PreparedSimulator } from './simulator-lifecycle.ts';
import type { BenchmarkConfig } from './types.ts';
import type { SessionDefaults } from '../../utils/session-store.ts';

const sessionDefaultEnvNameSet = new Set(Object.values(sessionDefaultEnvNames));

function sessionDefaultsWithTemporarySimulator(
  config: BenchmarkConfig,
  temporarySimulator: PreparedSimulator | undefined,
): SessionDefaults | undefined {
  if (!temporarySimulator) return config.sessionDefaults;
  const defaults = { ...config.sessionDefaults };
  delete defaults.simulatorName;
  return {
    ...defaults,
    simulatorId: temporarySimulator.simulatorId,
  };
}

const sessionDefaultPathKeys = new Set(['workspacePath', 'projectPath', 'derivedDataPath']);

function shouldResolveSessionDefaultPath(key: string, value: string): boolean {
  if (!sessionDefaultPathKeys.has(key)) return false;
  if (path.isAbsolute(value) || value.startsWith('~')) return false;
  return !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);
}

function isolatedSessionDefaults(
  config: BenchmarkConfig,
  workingDirectory: string,
  temporarySimulator: PreparedSimulator | undefined,
): SessionDefaults | undefined {
  const defaults = validateSessionDefaults(
    sessionDefaultsWithTemporarySimulator(config, temporarySimulator),
  );
  if (!defaults) return undefined;

  const resolved = { ...defaults };
  for (const [key, value] of Object.entries(defaults)) {
    if (typeof value === 'string' && shouldResolveSessionDefaultPath(key, value)) {
      if (key === 'workspacePath' || key === 'projectPath' || key === 'derivedDataPath') {
        resolved[key] = path.resolve(workingDirectory, value);
      }
    }
  }
  return resolved;
}

export function resolveBenchmarkSimulatorId(
  config: BenchmarkConfig,
  temporarySimulator: PreparedSimulator | undefined,
): string | undefined {
  return (
    temporarySimulator?.simulatorId ??
    (typeof config.sessionDefaults?.simulatorId === 'string'
      ? config.sessionDefaults.simulatorId
      : undefined)
  );
}

export function requireFirstRunPreflightSimulatorId(
  config: BenchmarkConfig,
  temporarySimulator: PreparedSimulator | undefined,
): string | undefined {
  const simulatorId = resolveBenchmarkSimulatorId(config, temporarySimulator);
  if (config.firstRunPromptDismissals && !simulatorId) {
    throw new Error(
      'firstRunPromptDismissals requires a temporary simulator or sessionDefaults.simulatorId',
    );
  }
  return simulatorId;
}

export async function writeMcpConfig(opts: {
  config: BenchmarkConfig;
  mcpConfigPath: string;
  mcpWorkspaceDirectory: string;
  mcpWorkspaceConfigPath: string;
  workingDirectory: string;
  temporarySimulator?: PreparedSimulator;
}): Promise<void> {
  const sessionDefaults = isolatedSessionDefaults(
    opts.config,
    opts.workingDirectory,
    opts.temporarySimulator,
  );
  const isolatedConfig = {
    schemaVersion: 1,
    enabledWorkflows: ['simulator', 'ui-automation'],
    debug: true,
    sentryDisabled: true,
    sessionDefaults: sessionDefaults ?? {},
  };
  const mcpConfig = {
    mcpServers: {
      [serverName]: {
        type: 'stdio',
        command: 'node',
        args: [path.join(repoRoot, 'build/cli.js'), 'mcp'],
        env: {
          MOBILEBUILDMCP_DEBUG: 'true',
          MOBILEBUILDMCP_SENTRY_DISABLED: 'true',
          MOBILEBUILDMCP_CWD: opts.mcpWorkspaceDirectory,
        },
      },
    },
  };

  await mkdir(path.dirname(opts.mcpWorkspaceConfigPath), { recursive: true });
  await writeFile(opts.mcpWorkspaceConfigPath, stringifyYaml(isolatedConfig), 'utf8');
  await writeFile(opts.mcpConfigPath, `${JSON.stringify(mcpConfig, null, 2)}\n`, 'utf8');
}

export async function writeEmptyMcpConfig(mcpConfigPath: string): Promise<void> {
  await writeFile(mcpConfigPath, `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`, 'utf8');
}

export async function writeClaudeMcpConfig(
  opts: Parameters<typeof writeMcpConfig>[0] & {
    enabled: boolean;
  },
): Promise<void> {
  if (!opts.enabled) return writeEmptyMcpConfig(opts.mcpConfigPath);
  return writeMcpConfig(opts);
}

export function claudeBenchmarkEnv(
  source: NodeJS.ProcessEnv = process.env,
  additions: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env = { ...source, ...additions };
  for (const name of sessionDefaultEnvNameSet) delete env[name];
  delete env.MOBILEBUILDMCP_CWD;
  return env;
}
