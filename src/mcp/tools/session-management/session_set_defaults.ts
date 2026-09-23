import * as z from 'zod';
import type { ToolHandlerContext } from '../../../rendering/types.ts';
import type {
  SessionDefaultsDomainResult,
  SessionDefaultsProfile,
} from '../../../types/domain-results.ts';
import type { NonStreamingExecutor } from '../../../types/tool-execution.ts';
import {
  persistActiveSessionDefaultsProfile,
  persistSessionDefaultsPatch,
} from '../../../utils/config-store.ts';
import { removeUndefined } from '../../../utils/remove-undefined.ts';
import { scheduleSimulatorDefaultsRefresh } from '../../../utils/simulator-defaults-refresh.ts';
import { sessionStore, type SessionDefaults } from '../../../utils/session-store.ts';
import { sessionDefaultsSchema } from '../../../utils/session-defaults-schema.ts';
import {
  createTypedToolWithContext,
  getHandlerContext,
} from '../../../utils/typed-tool-factory.ts';
import type { CommandExecutor } from '../../../utils/execution/index.ts';
import { getDefaultCommandExecutor } from '../../../utils/execution/index.ts';
import { formatProfileLabel } from './session-format-helpers.ts';
import { toErrorMessage } from '../../../utils/errors.ts';
import {
  createEnvironmentVariableInputSchema,
  normalizeEnvironmentVariableArgument,
} from '../../../utils/environment-variable-input.ts';

const schemaObj = sessionDefaultsSchema.extend({
  profile: z
    .string()
    .min(1)
    .optional()
    .describe('Set defaults for this named profile and make it active for the current session.'),
  createIfNotExists: z
    .boolean()
    .optional()
    .default(false)
    .describe('Create the named profile if it does not exist. Defaults to false.'),
  persist: z
    .boolean()
    .optional()
    .describe('Persist provided defaults to .mobilebuildmcp/config.yaml'),
});

const mcpSchemaObj = schemaObj.extend({
  env: createEnvironmentVariableInputSchema(
    'Default environment variables to pass to launched apps as key-value entries',
  ),
});

type Params = z.input<typeof schemaObj>;

const internalSchema: z.ZodType<Params, unknown> = z.preprocess((input) => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return input;
  }

  const args = input as Record<string, unknown>;
  return normalizeEnvironmentVariableArgument(args, 'env');
}, schemaObj);

type SessionSetDefaultsContext = {
  executor: CommandExecutor;
};

type SessionSetDefaultsResult = SessionDefaultsDomainResult & {
  operation?: {
    type: 'set';
    activatedProfile?: string;
    notices?: string[];
  };
};

function createSessionDefaultsProfile(defaults: SessionDefaults): SessionDefaultsProfile {
  return {
    projectPath: defaults.projectPath ?? null,
    workspacePath: defaults.workspacePath ?? null,
    scheme: defaults.scheme ?? null,
    configuration: defaults.configuration ?? null,
    simulatorName: defaults.simulatorName ?? null,
    simulatorId: defaults.simulatorId ?? null,
    simulatorPlatform: defaults.simulatorPlatform ?? null,
    deviceId: defaults.deviceId ?? null,
    useLatestOS: defaults.useLatestOS ?? null,
    arch: defaults.arch ?? null,
    suppressWarnings: defaults.suppressWarnings ?? null,
    derivedDataPath: defaults.derivedDataPath ?? null,
    preferXcodebuild: defaults.preferXcodebuild ?? null,
    platform: defaults.platform ?? null,
    bundleId: defaults.bundleId ?? null,
    env: defaults.env ?? null,
    extraArgs: defaults.extraArgs ?? null,
  };
}

function createSessionDefaultsResult(error?: string): SessionSetDefaultsResult {
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

function setStructuredOutput(ctx: ToolHandlerContext, result: SessionSetDefaultsResult): void {
  ctx.structuredOutput = {
    result,
    schema: 'mobilebuildmcp.output.session-defaults',
    schemaVersion: '2',
  };
}

export function createSessionSetDefaultsExecutor(
  context: SessionSetDefaultsContext,
): NonStreamingExecutor<Params, SessionSetDefaultsResult> {
  return async (params) => {
    try {
      let activeProfile = sessionStore.getActiveProfile();
      const { persist, profile: rawProfile, createIfNotExists = false, ...rawParams } = params;

      if (rawProfile !== undefined) {
        const profile = rawProfile.trim();
        if (profile.length === 0) {
          return createSessionDefaultsResult('Profile name cannot be empty.');
        }

        const profileExists = sessionStore.listProfiles().includes(profile);
        if (!profileExists && !createIfNotExists) {
          return createSessionDefaultsResult(
            `Profile "${profile}" does not exist. Pass createIfNotExists=true to create it.`,
          );
        }

        sessionStore.setActiveProfile(profile);
        activeProfile = profile;
      }

      const current = sessionStore.getAll();
      const nextParams = removeUndefined(
        rawParams as Record<string, unknown>,
      ) as Partial<SessionDefaults>;

      const hasProjectPath = nextParams.projectPath !== undefined;
      const hasWorkspacePath = nextParams.workspacePath !== undefined;
      const hasSimulatorId = nextParams.simulatorId !== undefined;
      const hasSimulatorName = nextParams.simulatorName !== undefined;

      const notices: string[] = [];
      if (hasProjectPath && hasWorkspacePath) {
        delete nextParams.projectPath;
        notices.push('Both projectPath and workspacePath were provided; keeping workspacePath.');
      }

      const toClear = new Set<keyof SessionDefaults>();
      if (hasProjectPath) {
        toClear.add('workspacePath');
      }
      if (hasWorkspacePath) {
        toClear.add('projectPath');
      }

      const selectorProvided = hasSimulatorId || hasSimulatorName;
      const simulatorIdChanged = hasSimulatorId && nextParams.simulatorId !== current.simulatorId;
      const simulatorNameChanged =
        hasSimulatorName && nextParams.simulatorName !== current.simulatorName;

      if (hasSimulatorId && !hasSimulatorName) {
        toClear.add('simulatorName');
      } else if (hasSimulatorName && !hasSimulatorId) {
        toClear.add('simulatorId');
      }

      if (selectorProvided && (simulatorIdChanged || simulatorNameChanged)) {
        toClear.add('simulatorPlatform');
      }

      if (toClear.size > 0) {
        sessionStore.clear(Array.from(toClear));
      }

      if (Object.keys(nextParams).length > 0) {
        sessionStore.setDefaults(nextParams as Partial<SessionDefaults>);
      }

      if (persist) {
        if (Object.keys(nextParams).length > 0 || toClear.size > 0) {
          await persistSessionDefaultsPatch({
            patch: nextParams,
            deleteKeys: Array.from(toClear),
            profile: activeProfile,
          });
        }

        if (rawProfile !== undefined) {
          await persistActiveSessionDefaultsProfile(activeProfile);
        }
      }

      const revision = sessionStore.getRevision();
      if (selectorProvided) {
        const defaultsForRefresh = sessionStore.getAll();
        scheduleSimulatorDefaultsRefresh({
          executor: context.executor,
          expectedRevision: revision,
          reason: 'session-set-defaults',
          profile: activeProfile,
          persist: Boolean(persist),
          simulatorId: defaultsForRefresh.simulatorId,
          simulatorName: defaultsForRefresh.simulatorName,
          recomputePlatform: true,
        });
      }

      const result = createSessionDefaultsResult();
      if (notices.length > 0) {
        result.operation = {
          type: 'set',
          notices,
        };
      }
      return result;
    } catch (error) {
      return createSessionDefaultsResult(toErrorMessage(error));
    }
  };
}

export async function sessionSetDefaultsLogic(
  params: Params,
  context: SessionSetDefaultsContext,
): Promise<void> {
  const ctx = getHandlerContext();
  const executeSessionSetDefaults = createSessionSetDefaultsExecutor(context);
  const result = await executeSessionSetDefaults(params);
  const {
    profile: rawProfile,
    persist: _persist,
    createIfNotExists: _createIfNotExists,
    ..._rawParams
  } = params;

  if (!result.didError) {
    result.operation = {
      type: 'set',
      ...(rawProfile !== undefined ? { activatedProfile: rawProfile.trim() } : {}),
      ...(result.operation?.notices ? { notices: result.operation.notices } : {}),
    };
  }

  setStructuredOutput(ctx, result);
}

export const schema = schemaObj.shape;
export const mcpSchema = mcpSchemaObj.shape;

export const handler = createTypedToolWithContext(internalSchema, sessionSetDefaultsLogic, () => ({
  executor: getDefaultCommandExecutor(),
}));
