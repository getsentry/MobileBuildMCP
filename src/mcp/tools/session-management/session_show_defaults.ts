import * as z from 'zod';
import type { ToolHandlerContext } from '../../../rendering/types.ts';
import type {
  SessionDefaultsDomainResult,
  SessionDefaultsProfile,
} from '../../../types/domain-results.ts';
import type { NonStreamingExecutor } from '../../../types/tool-execution.ts';
import { sessionStore } from '../../../utils/session-store.ts';
import {
  createTypedToolWithContext,
  getHandlerContext,
} from '../../../utils/typed-tool-factory.ts';
import { formatProfileLabel } from './session-format-helpers.ts';

const schemaObject = z.object({});
type SessionShowDefaultsParams = z.infer<typeof schemaObject>;
type SessionShowDefaultsResult = SessionDefaultsDomainResult & {
  operation: { type: 'show' };
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

function createSessionDefaultsResult(): SessionShowDefaultsResult {
  const profiles: SessionDefaultsDomainResult['profiles'] = {
    '(default)': createSessionDefaultsProfile(sessionStore.getAllForProfile(null)),
  };

  for (const profile of sessionStore.listProfiles()) {
    profiles[profile] = createSessionDefaultsProfile(sessionStore.getAllForProfile(profile));
  }

  return {
    kind: 'session-defaults',
    didError: false,
    error: null,
    currentProfile: formatProfileLabel(sessionStore.getActiveProfile()),
    profiles,
    operation: { type: 'show' },
  };
}

function setStructuredOutput(ctx: ToolHandlerContext, result: SessionShowDefaultsResult): void {
  ctx.structuredOutput = {
    result,
    schema: 'mobilebuildmcp.output.session-defaults',
    schemaVersion: '2',
  };
}

export function createSessionShowDefaultsExecutor(): NonStreamingExecutor<
  SessionShowDefaultsParams,
  SessionShowDefaultsResult
> {
  return async () => createSessionDefaultsResult();
}

export async function sessionShowDefaultsLogic(): Promise<void> {
  const ctx = getHandlerContext();
  const executeSessionShowDefaults = createSessionShowDefaultsExecutor();
  const result = await executeSessionShowDefaults({});

  setStructuredOutput(ctx, result);
}

export const schema = schemaObject.shape;

export const handler = createTypedToolWithContext(
  schemaObject,
  () => sessionShowDefaultsLogic(),
  () => undefined,
);
