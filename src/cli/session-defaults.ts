import type { ToolSchemaShape } from '../core/plugin-types.ts';
import type { ToolDefinition } from '../runtime/types.ts';
import type { ResolvedRuntimeConfig } from '../utils/config-store.ts';
import type { SessionDefaults } from '../utils/session-store.ts';
import {
  mergeSessionDefaultArgs,
  pickSessionDefaultsForKeys,
  type ExclusiveParameterGroup,
} from '../utils/session-default-args.ts';

// Mirrors the exclusive pairs the tool handlers declare: an explicit value for one key drops the
// configured default for the other, so a merged default never collides with an explicit argument.
const CLI_SESSION_DEFAULT_EXCLUSIVE_PAIRS: readonly ExclusiveParameterGroup[] = [
  ['projectPath', 'workspacePath'],
  ['simulatorId', 'simulatorName'],
  ['bundleId', 'pid'],
];

export function resolveCliSessionDefaults(opts: {
  runtimeConfig: ResolvedRuntimeConfig;
  profileOverride?: string;
}): Partial<SessionDefaults> {
  const profileName = opts.profileOverride ?? opts.runtimeConfig.activeSessionDefaultsProfile;
  if (profileName) {
    return { ...(opts.runtimeConfig.sessionDefaultsProfiles?.[profileName] ?? {}) };
  }

  return { ...(opts.runtimeConfig.sessionDefaults ?? {}) };
}

export function isKnownCliSessionDefaultsProfile(
  runtimeConfig: ResolvedRuntimeConfig,
  profileName: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(
    runtimeConfig.sessionDefaultsProfiles ?? {},
    profileName,
  );
}

export function pickSchemaSessionDefaults(
  schema: ToolSchemaShape,
  defaults: Partial<SessionDefaults>,
): Record<string, unknown> {
  return pickSessionDefaultsForKeys(Object.keys(schema), defaults);
}

export function getCliSessionDefaultsForTool(opts: {
  tool: ToolDefinition;
  runtimeConfig: ResolvedRuntimeConfig;
  profileOverride?: string;
}): Record<string, unknown> {
  return pickSchemaSessionDefaults(
    opts.tool.cliSchema,
    resolveCliSessionDefaults({
      runtimeConfig: opts.runtimeConfig,
      profileOverride: opts.profileOverride,
    }),
  );
}

export function mergeCliSessionDefaults(opts: {
  defaults: Record<string, unknown>;
  explicitArgs: Record<string, unknown>;
}): Record<string, unknown> {
  return mergeSessionDefaultArgs({
    defaults: opts.defaults,
    explicitArgs: opts.explicitArgs,
    exclusivePairs: CLI_SESSION_DEFAULT_EXCLUSIVE_PAIRS,
  });
}
