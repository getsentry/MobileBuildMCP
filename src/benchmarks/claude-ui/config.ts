import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import * as z from 'zod';
import { sessionDefaultsSchema } from '../../utils/session-defaults-schema.ts';
import type { SessionDefaults } from '../../utils/session-store.ts';
import type {
  BenchmarkConfig,
  ClaudeInvocationConfig,
  FailurePatternTarget,
  ToolAnalysisConfig,
  ToolMatcher,
  ToolMatcherShortName,
} from './types.ts';

export const sessionDefaultEnvNames: Record<string, string> = {
  workspacePath: 'MOBILEBUILDMCP_WORKSPACE_PATH',
  projectPath: 'MOBILEBUILDMCP_PROJECT_PATH',
  scheme: 'MOBILEBUILDMCP_SCHEME',
  configuration: 'MOBILEBUILDMCP_CONFIGURATION',
  simulatorName: 'MOBILEBUILDMCP_SIMULATOR_NAME',
  simulatorId: 'MOBILEBUILDMCP_SIMULATOR_ID',
  simulatorPlatform: 'MOBILEBUILDMCP_SIMULATOR_PLATFORM',
  deviceId: 'MOBILEBUILDMCP_DEVICE_ID',
  derivedDataPath: 'MOBILEBUILDMCP_DERIVED_DATA_PATH',
  platform: 'MOBILEBUILDMCP_PLATFORM',
  bundleId: 'MOBILEBUILDMCP_BUNDLE_ID',
  arch: 'MOBILEBUILDMCP_ARCH',
  useLatestOS: 'MOBILEBUILDMCP_USE_LATEST_OS',
  suppressWarnings: 'MOBILEBUILDMCP_SUPPRESS_WARNINGS',
  preferXcodebuild: 'MOBILEBUILDMCP_PREFER_XCODEBUILD',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: Record<string, unknown>, key: string, source: string): string {
  const raw = value[key];
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error(`${source}: expected non-empty string field '${key}'`);
  }
  return raw;
}

function readOptionalString(
  value: Record<string, unknown>,
  key: string,
  source: string,
): string | undefined {
  const raw = value[key];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error(`${source}: expected string field '${key}'`);
  }
  return raw;
}

function readOptionalStringArray(
  value: Record<string, unknown>,
  key: string,
  source: string,
): string[] | undefined {
  const raw = value[key];
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string')) {
    throw new Error(`${source}: expected string array field '${key}'`);
  }
  return raw as string[];
}

function readOptionalBoolean(
  value: Record<string, unknown>,
  key: string,
  source: string,
): boolean | undefined {
  const raw = value[key];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'boolean') throw new Error(`${source}.${key}: expected boolean`);
  return raw;
}

function readOptionalNumber(
  value: Record<string, unknown>,
  key: string,
  source: string,
): number | undefined {
  const raw = value[key];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'number') throw new Error(`${source}.${key}: expected number`);
  return raw;
}

function readOptionalPositiveFiniteNumber(
  value: Record<string, unknown>,
  key: string,
  source: string,
): number | undefined {
  const raw = readOptionalNumber(value, key, source);
  if (raw === undefined) return undefined;
  if (!Number.isFinite(raw) || raw <= 0) {
    throw new Error(`${source}.${key}: expected finite positive number`);
  }
  return raw;
}

function readNumberMap(value: unknown, source: string): Record<string, number> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`${source}: expected object`);
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (typeof item !== 'number') throw new Error(`${source}.${key}: expected number`);
      return [key, item];
    }),
  );
}

function rejectClaudeModelExtraArgs(extraArgs: string[] | undefined, source: string): void {
  if (!extraArgs) return;
  for (const arg of extraArgs) {
    if (arg === '--model' || arg.startsWith('--model=')) {
      throw new Error(`${source}.extraArgs: use claude.model instead of --model`);
    }
  }
}

function readClaudeInvocationConfig(
  raw: unknown,
  source: string,
): ClaudeInvocationConfig | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw new Error(`${source}: expected object`);
  const permissionMode = readOptionalString(raw, 'permissionMode', source);
  if (
    permissionMode !== undefined &&
    permissionMode !== 'default' &&
    permissionMode !== 'bypassPermissions'
  ) {
    throw new Error(`${source}.permissionMode: expected 'default' or 'bypassPermissions'`);
  }
  const skillDirs = readOptionalStringArray(raw, 'skillDirs', source);
  if (skillDirs !== undefined) {
    const basenames = new Set<string>();
    for (const skillDir of skillDirs) {
      const basename = path.basename(skillDir);
      if (basenames.has(basename)) {
        throw new Error(`${source}.skillDirs: duplicate basename '${basename}'`);
      }
      basenames.add(basename);
    }
  }
  const activateSkill = readOptionalString(raw, 'activateSkill', source);
  if (activateSkill !== undefined && (!skillDirs || skillDirs.length === 0)) {
    throw new Error(`${source}.activateSkill: requires skillDirs`);
  }
  if (
    activateSkill !== undefined &&
    skillDirs !== undefined &&
    !skillDirs.some((skillDir) => path.basename(skillDir) === activateSkill)
  ) {
    throw new Error(`${source}.activateSkill: must match a basename from skillDirs`);
  }

  const extraArgs = readOptionalStringArray(raw, 'extraArgs', source);
  rejectClaudeModelExtraArgs(extraArgs, source);

  return {
    model: readOptionalString(raw, 'model', source),
    useMcpServer: readOptionalBoolean(raw, 'useMcpServer', source),
    permissionMode,
    tools: readOptionalStringArray(raw, 'tools', source),
    allowedTools: readOptionalStringArray(raw, 'allowedTools', source),
    appendSystemPrompt: readOptionalString(raw, 'appendSystemPrompt', source),
    extraArgs,
    pluginDirs: readOptionalStringArray(raw, 'pluginDirs', source),
    skillDirs,
    activateSkill,
    isolatedWorkingDirectory: readOptionalBoolean(raw, 'isolatedWorkingDirectory', source),
    maxClaudeSeconds: readOptionalPositiveFiniteNumber(raw, 'maxClaudeSeconds', source),
  };
}

function readShortNameMode(raw: unknown, source: string): ToolMatcherShortName | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'afterLastDoubleUnderscore' || raw === 'afterPrefix' || raw === 'full') {
    return raw;
  }
  throw new Error(`${source}: expected 'afterLastDoubleUnderscore', 'afterPrefix', or 'full'`);
}

function readToolMatcher(raw: unknown, source: string): ToolMatcher {
  if (!isRecord(raw)) throw new Error(`${source}: expected object`);
  const kind = readString(raw, 'kind', source);
  if (kind === 'namePrefix') {
    return {
      kind,
      prefix: readString(raw, 'prefix', source),
      shortName: readShortNameMode(raw.shortName, `${source}.shortName`),
      uiAutomationNames: readOptionalStringArray(raw, 'uiAutomationNames', source),
    };
  }
  if (kind === 'bashCommand') {
    return {
      kind,
      commandPrefix: readString(raw, 'commandPrefix', source),
      shortName: readString(raw, 'shortName', source),
      uiAutomation: readOptionalBoolean(raw, 'uiAutomation', source),
    };
  }
  throw new Error(`${source}.kind: expected 'namePrefix' or 'bashCommand'`);
}

function readToolAnalysisConfig(raw: unknown, source: string): ToolAnalysisConfig | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw new Error(`${source}: expected object`);
  const matchers = raw.matchers;
  if (!Array.isArray(matchers)) throw new Error(`${source}.matchers: expected array`);
  return {
    matchers: matchers.map((matcher, index) =>
      readToolMatcher(matcher, `${source}.matchers[${index}]`),
    ),
  };
}

function readRegexPatterns(
  raw: Record<string, unknown>,
  key: string,
  source: string,
): string[] | undefined {
  const patterns = readOptionalStringArray(raw, key, source);
  for (const [index, pattern] of (patterns ?? []).entries()) {
    try {
      new RegExp(pattern, 'i');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${source}.${key}[${index}]: invalid regular expression: ${message}`);
    }
  }
  return patterns;
}

function readFailurePatternTarget(raw: unknown, source: string): FailurePatternTarget {
  if (raw === 'commands' || raw === 'toolResults') return raw;
  throw new Error(`${source}: expected 'commands' or 'toolResults'`);
}

function readFailurePatternTargets(
  raw: unknown,
  source: string,
): FailurePatternTarget[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new Error(`${source}: expected array`);
  return raw.map((target, index) => readFailurePatternTarget(target, `${source}[${index}]`));
}

function readFirstRunPromptDismissals(
  raw: unknown,
  source: string,
): BenchmarkConfig['firstRunPromptDismissals'] {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw new Error(`${source}: expected object`);
  return {
    labels: readOptionalStringArray(raw, 'labels', source) ?? [],
    timeoutSeconds: readOptionalNumber(raw, 'timeoutSeconds', source),
  };
}

export function validateSessionDefaults(
  sessionDefaults: Record<string, unknown> | undefined,
): SessionDefaults | undefined {
  if (!sessionDefaults) return undefined;

  const parsed = sessionDefaultsSchema.strict().safeParse(sessionDefaults);
  if (!parsed.success) {
    throw new Error(`invalid sessionDefaults:\n${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.map(String).join('.') : 'root';
      return `${path}: ${issue.message}`;
    })
    .join('\n');
}

function rejectRemovedConfigKeys(raw: Record<string, unknown>, source: string): void {
  const removedKeys: Record<string, string> = {
    allowedVariance: 'removed; baselines are observed data only',
    expectedFailures: 'removed; benchmark stumbles are observed data',
    expectedToolSequence: 'renamed to baselineToolSequence',
    sequence: 'removed; use baselineToolSequence for observed sequence reporting',
  };
  for (const [key, message] of Object.entries(removedKeys)) {
    if (raw[key] !== undefined) throw new Error(`${source}.${key}: ${message}`);
  }
}

export function readConfig(raw: unknown, source: string): BenchmarkConfig {
  if (!isRecord(raw)) throw new Error(`${source}: expected YAML object`);
  rejectRemovedConfigKeys(raw, source);
  const config: BenchmarkConfig = {
    name: readString(raw, 'name', source),
    prompt: readString(raw, 'prompt', source),
    workingDirectory: readOptionalString(raw, 'workingDirectory', source),
    baselineToolSequence: readOptionalStringArray(raw, 'baselineToolSequence', source),
    failurePatterns: readRegexPatterns(raw, 'failurePatterns', source),
    failurePatternTargets: readFailurePatternTargets(
      raw.failurePatternTargets,
      `${source}.failurePatternTargets`,
    ),
    ignoredFailurePatterns: readRegexPatterns(raw, 'ignoredFailurePatterns', source),
    temporarySimulator: readOptionalBoolean(raw, 'temporarySimulator', source),
    preflightCommands: readOptionalStringArray(raw, 'preflightCommands', source),
    firstRunPromptDismissals: readFirstRunPromptDismissals(
      raw.firstRunPromptDismissals,
      `${source}.firstRunPromptDismissals`,
    ),
  };

  if (raw.sessionDefaults !== undefined) {
    if (!isRecord(raw.sessionDefaults)) {
      throw new Error(`${source}.sessionDefaults: expected object`);
    }
    config.sessionDefaults = validateSessionDefaults(raw.sessionDefaults);
  }

  if (raw.baseline !== undefined) {
    if (!isRecord(raw.baseline)) throw new Error(`${source}.baseline: expected object`);
    config.baseline = {
      totalToolCalls: readOptionalNumber(raw.baseline, 'totalToolCalls', `${source}.baseline`),
      trackedToolCalls: readOptionalNumber(raw.baseline, 'trackedToolCalls', `${source}.baseline`),
      mcpToolCalls: readOptionalNumber(raw.baseline, 'mcpToolCalls', `${source}.baseline`),
      uiAutomationCalls: readOptionalNumber(
        raw.baseline,
        'uiAutomationCalls',
        `${source}.baseline`,
      ),
      wallClockSeconds: readOptionalNumber(raw.baseline, 'wallClockSeconds', `${source}.baseline`),
      tools: readNumberMap(raw.baseline.tools, `${source}.baseline.tools`),
    };
  }
  config.claude = readClaudeInvocationConfig(raw.claude, `${source}.claude`);
  config.toolAnalysis = readToolAnalysisConfig(raw.toolAnalysis, `${source}.toolAnalysis`);

  return config;
}

export async function loadSuite(suitePath: string): Promise<BenchmarkConfig> {
  const raw = parseYaml(await readFile(suitePath, 'utf8')) as unknown;
  return readConfig(raw, suitePath);
}
