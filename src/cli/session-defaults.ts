import type { ToolSchemaShape } from '../core/plugin-types.ts';
import type { ToolDefinition } from '../runtime/types.ts';
import type { ResolvedRuntimeConfig } from '../utils/config-store.ts';
import type { SessionDefaults } from '../utils/session-store.ts';
import {
  mergeSessionDefaultArgs,
  pickSessionDefaultsForKeys,
} from '../utils/session-default-args.ts';

const CLI_SESSION_DEFAULT_EXCLUSIVE_PAIRS: (keyof SessionDefaults)[][] = [
  ['projectPath', 'workspacePath'],
  ['simulatorId', 'simulatorName'],
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
  const defaults = pickSchemaSessionDefaults(
    opts.tool.cliSchema,
    resolveCliSessionDefaults({
      runtimeConfig: opts.runtimeConfig,
      profileOverride: opts.profileOverride,
    }),
  );

  // Let the device build handler ignore the saved installation destination.
  // Promoting it to an explicit CLI argument bypasses that handler's filtering.
  // Explicit --device-id / --json values are merged separately by the caller.
  if (opts.tool.id === 'build_device') {
    delete defaults.deviceId;
  }

  return defaults;
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
