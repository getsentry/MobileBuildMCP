import * as z from 'zod';
import type { ToolHandlerContext } from '../../../rendering/types.ts';
import type { SessionProfileDomainResult } from '../../../types/domain-results.ts';
import type { NonStreamingExecutor } from '../../../types/tool-execution.ts';
import { createTypedTool, getHandlerContext } from '../../../utils/typed-tool-factory.ts';
import { getDefaultCommandExecutor } from '../../../utils/execution/index.ts';
import { persistActiveSessionDefaultsProfile } from '../../../utils/config-store.ts';
import { sessionStore } from '../../../utils/session-store.ts';
import { formatProfileLabel } from './session-format-helpers.ts';
import { toErrorMessage } from '../../../utils/errors.ts';

const schemaObj = z.object({
  profile: z
    .string()
    .min(1)
    .optional()
    .describe('Activate a named session defaults profile (example: ios or watch).'),
  global: z.boolean().optional().describe('Activate the global unnamed defaults profile.'),
  persist: z
    .boolean()
    .optional()
    .describe('Persist activeSessionDefaultsProfile to .mobilebuildmcp/config.yaml.'),
});

type Params = z.input<typeof schemaObj>;
type SessionUseDefaultsProfileResult = SessionProfileDomainResult & {
  persisted?: boolean;
};

function resolveProfileToActivate(params: Params): string | null | undefined {
  if (params.global === true) return null;
  if (params.profile === undefined) return undefined;
  return params.profile.trim();
}

function createSessionProfileResult(params: {
  previousProfile: string | null;
  currentProfile: string | null;
  error?: string;
  persisted?: boolean;
}): SessionUseDefaultsProfileResult {
  return {
    kind: 'session-profile',
    didError: typeof params.error === 'string',
    error: params.error ?? null,
    previousProfile: formatProfileLabel(params.previousProfile),
    currentProfile: formatProfileLabel(params.currentProfile),
    ...(params.persisted ? { persisted: params.persisted } : {}),
  };
}

function setStructuredOutput(
  ctx: ToolHandlerContext,
  result: SessionUseDefaultsProfileResult,
): void {
  ctx.structuredOutput = {
    result,
    schema: 'mobilebuildmcp.output.session-profile',
    schemaVersion: '2',
  };
}

export function createSessionUseDefaultsProfileExecutor(): NonStreamingExecutor<
  Params,
  SessionUseDefaultsProfileResult
> {
  return async (params) => {
    const beforeProfile = sessionStore.getActiveProfile();

    try {
      if (params.global === true && params.profile !== undefined) {
        return createSessionProfileResult({
          previousProfile: beforeProfile,
          currentProfile: beforeProfile,
          error: 'Provide either global=true or profile, not both.',
        });
      }

      const profileToActivate = resolveProfileToActivate(params);

      if (typeof profileToActivate === 'string') {
        if (profileToActivate.length === 0) {
          return createSessionProfileResult({
            previousProfile: beforeProfile,
            currentProfile: beforeProfile,
            error: 'Profile name cannot be empty.',
          });
        }
        if (!sessionStore.listProfiles().includes(profileToActivate)) {
          return createSessionProfileResult({
            previousProfile: beforeProfile,
            currentProfile: beforeProfile,
            error: `Profile "${profileToActivate}" does not exist.`,
          });
        }
      }

      if (profileToActivate !== undefined) {
        sessionStore.setActiveProfile(profileToActivate);
      }

      const active = sessionStore.getActiveProfile();
      if (params.persist) {
        await persistActiveSessionDefaultsProfile(active);
      }

      return createSessionProfileResult({
        previousProfile: beforeProfile,
        currentProfile: active,
        ...(params.persist ? { persisted: true } : {}),
      });
    } catch (error) {
      return createSessionProfileResult({
        previousProfile: beforeProfile,
        currentProfile: sessionStore.getActiveProfile(),
        error: toErrorMessage(error),
      });
    }
  };
}

export async function sessionUseDefaultsProfileLogic(params: Params): Promise<void> {
  const ctx = getHandlerContext();
  const executeSessionUseDefaultsProfile = createSessionUseDefaultsProfileExecutor();
  const result = await executeSessionUseDefaultsProfile(params);

  setStructuredOutput(ctx, result);
}

export const schema = schemaObj.shape;

export const handler = createTypedTool(
  schemaObj,
  sessionUseDefaultsProfileLogic,
  getDefaultCommandExecutor,
);
