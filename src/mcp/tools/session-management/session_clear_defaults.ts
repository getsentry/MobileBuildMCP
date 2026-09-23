import * as z from 'zod';
import type { ToolHandlerContext } from '../../../rendering/types.ts';
import type {
  SessionDefaultsDomainResult,
  SessionDefaultsProfile,
} from '../../../types/domain-results.ts';
import type { NonStreamingExecutor } from '../../../types/tool-execution.ts';
import { sessionStore } from '../../../utils/session-store.ts';
import { sessionDefaultKeys } from '../../../utils/session-defaults-schema.ts';
import { createTypedTool, getHandlerContext } from '../../../utils/typed-tool-factory.ts';
import { getDefaultCommandExecutor } from '../../../utils/execution/index.ts';
import { formatProfileLabel } from './session-format-helpers.ts';

const keys = sessionDefaultKeys;

const schemaObj = z.object({
  keys: z.array(z.enum(keys)).optional(),
  profile: z
    .string()
    .min(1)
    .optional()
    .describe('Clear defaults for this named profile instead of the active profile.'),
  all: z
    .boolean()
    .optional()
    .describe(
      'Clear all defaults across global and named profiles. Cannot be combined with keys/profile.',
    ),
});

type Params = z.infer<typeof schemaObj>;
type SessionClearDefaultsResult = SessionDefaultsDomainResult & {
  operation?: {
    type: 'clear';
    scope: 'all' | 'profile';
    profile?: string;
    clearedKeys?: string[];
  };
};

function createSessionDefaultsProfile(profile: Record<string, unknown>): SessionDefaultsProfile {
  return {
    projectPath: (profile.projectPath as string | undefined) ?? null,
    workspacePath: (profile.workspacePath as string | undefined) ?? null,
    scheme: (profile.scheme as string | undefined) ?? null,
    configuration: (profile.configuration as string | undefined) ?? null,
    simulatorName: (profile.simulatorName as string | undefined) ?? null,
    simulatorId: (profile.simulatorId as string | undefined) ?? null,
    simulatorPlatform:
      (profile.simulatorPlatform as SessionDefaultsProfile['simulatorPlatform'] | undefined) ??
      null,
    deviceId: (profile.deviceId as string | undefined) ?? null,
    useLatestOS: (profile.useLatestOS as boolean | undefined) ?? null,
    arch: (profile.arch as SessionDefaultsProfile['arch'] | undefined) ?? null,
    suppressWarnings: (profile.suppressWarnings as boolean | undefined) ?? null,
    derivedDataPath: (profile.derivedDataPath as string | undefined) ?? null,
    preferXcodebuild: (profile.preferXcodebuild as boolean | undefined) ?? null,
    platform: (profile.platform as string | undefined) ?? null,
    bundleId: (profile.bundleId as string | undefined) ?? null,
    env: (profile.env as Record<string, string> | undefined) ?? null,
    extraArgs: (profile.extraArgs as string[] | undefined) ?? null,
  };
}

function createSessionDefaultsResult(error?: string): SessionClearDefaultsResult {
  const profiles: SessionDefaultsDomainResult['profiles'] = {
    '(default)': createSessionDefaultsProfile(sessionStore.getAllForProfile(null)),
  };

  for (const profile of sessionStore.listProfiles()) {
    profiles[profile] = createSessionDefaultsProfile(sessionStore.getAllForProfile(profile));
  }

  return {
    kind: 'session-defaults',
    didError: typeof error === 'string',
    error: error ?? null,
    currentProfile: formatProfileLabel(sessionStore.getActiveProfile()),
    profiles,
  };
}

function setStructuredOutput(ctx: ToolHandlerContext, result: SessionClearDefaultsResult): void {
  ctx.structuredOutput = {
    result,
    schema: 'mobilebuildmcp.output.session-defaults',
    schemaVersion: '2',
  };
}

export function createSessionClearDefaultsExecutor(): NonStreamingExecutor<
  Params,
  SessionClearDefaultsResult
> {
  return async (params) => {
    if (params.all) {
      if (params.profile !== undefined || params.keys !== undefined) {
        return createSessionDefaultsResult('all=true cannot be combined with profile or keys.');
      }

      sessionStore.clearAll();
      return createSessionDefaultsResult();
    }

    const profile = params.profile?.trim();
    if (profile !== undefined) {
      if (profile.length === 0) {
        return createSessionDefaultsResult('Profile name cannot be empty.');
      }

      if (!sessionStore.listProfiles().includes(profile)) {
        return createSessionDefaultsResult(`Profile "${profile}" does not exist.`);
      }

      if (params.keys) {
        sessionStore.clearForProfile(profile, params.keys);
      } else {
        sessionStore.clearForProfile(profile);
      }

      return createSessionDefaultsResult();
    }

    if (params.keys) {
      sessionStore.clear(params.keys);
    } else {
      sessionStore.clear();
    }

    return createSessionDefaultsResult();
  };
}

export async function sessionClearDefaultsLogic(params: Params): Promise<void> {
  const ctx = getHandlerContext();
  const activeProfileBefore = sessionStore.getActiveProfile();
  const executeSessionClearDefaults = createSessionClearDefaultsExecutor();
  const result = await executeSessionClearDefaults(params);

  if (!result.didError) {
    result.operation = params.all
      ? {
          type: 'clear',
          scope: 'all',
          ...(params.keys ? { clearedKeys: params.keys } : {}),
        }
      : {
          type: 'clear',
          scope: 'profile',
          profile: params.profile?.trim() ?? formatProfileLabel(activeProfileBefore),
          ...(params.keys ? { clearedKeys: params.keys } : {}),
        };
  }

  setStructuredOutput(ctx, result);
}

export const schema = schemaObj.shape;

export const handler = createTypedTool(
  schemaObj,
  sessionClearDefaultsLogic,
  getDefaultCommandExecutor,
);
