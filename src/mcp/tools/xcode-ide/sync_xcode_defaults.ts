import path from 'node:path';
import * as z from 'zod';
import type { ToolHandlerContext } from '../../../rendering/types.ts';
import type {
  SessionDefaultsDomainResult,
  SessionDefaultsProfile,
} from '../../../types/domain-results.ts';
import type { NonStreamingExecutor } from '../../../types/tool-execution.ts';
import type { CommandExecutor } from '../../../utils/execution/index.ts';
import { getDefaultCommandExecutor } from '../../../utils/execution/index.ts';
import {
  createTypedToolWithContext,
  getHandlerContext,
} from '../../../utils/typed-tool-factory.ts';
import { sessionStore } from '../../../utils/session-store.ts';
import { readXcodeIdeState } from '../../../utils/xcode-state-reader.ts';
import { lookupBundleId } from '../../../utils/xcode-state-watcher.ts';
import { formatProfileLabel } from '../session-management/session-format-helpers.ts';

const schemaObj = z.object({});

type Params = z.infer<typeof schemaObj>;
type SyncXcodeDefaultsResult = SessionDefaultsDomainResult;

const STRUCTURED_OUTPUT_SCHEMA = 'mobilebuildmcp.output.session-defaults';

interface SyncXcodeDefaultsContext {
  executor: CommandExecutor;
  cwd: string;
  projectPath?: string;
  workspacePath?: string;
}

function resolveOptionalPath(cwd: string, value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  return path.isAbsolute(value) ? value : path.resolve(cwd, value);
}

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

function createSyncXcodeDefaultsResult(error?: string): SyncXcodeDefaultsResult {
  const profiles: SyncXcodeDefaultsResult['profiles'] = {
    '(default)': createSessionDefaultsProfile(sessionStore.getAllForProfile(null)),
  };

  for (const profile of sessionStore.listProfiles()) {
    profiles[profile] = createSessionDefaultsProfile(sessionStore.getAllForProfile(profile));
  }

  const result: SyncXcodeDefaultsResult = {
    kind: 'session-defaults',
    didError: typeof error === 'string',
    error: error ?? null,
    currentProfile: formatProfileLabel(sessionStore.getActiveProfile()),
    profiles,
  };

  Object.defineProperty(result, 'operation', {
    value: { type: 'sync-xcode' },
    enumerable: false,
  });

  return result;
}

function setStructuredOutput(ctx: ToolHandlerContext, result: SyncXcodeDefaultsResult): void {
  ctx.structuredOutput = {
    result,
    schema: STRUCTURED_OUTPUT_SCHEMA,
    schemaVersion: '2',
  };
}

export function createSyncXcodeDefaultsExecutor(
  context: SyncXcodeDefaultsContext,
): NonStreamingExecutor<Params, SyncXcodeDefaultsResult> {
  return async () => {
    const projectPath = resolveOptionalPath(context.cwd, context.projectPath);
    const workspacePath = resolveOptionalPath(context.cwd, context.workspacePath);

    const xcodeState = await readXcodeIdeState({
      executor: context.executor,
      cwd: context.cwd,
      projectPath,
      workspacePath,
    });

    if (xcodeState.error) {
      const message = `Failed to read Xcode IDE state: ${xcodeState.error}`;
      return createSyncXcodeDefaultsResult(message);
    }

    let bundleId: string | null | undefined;
    if (xcodeState.scheme) {
      bundleId =
        (await lookupBundleId(context.executor, xcodeState.scheme, projectPath, workspacePath)) ??
        null;
    }

    const synced: Record<string, string> = {};
    if (xcodeState.scheme) {
      synced.scheme = xcodeState.scheme;
    }
    if (xcodeState.simulatorId) {
      synced.simulatorId = xcodeState.simulatorId;
    }
    if (xcodeState.simulatorName) {
      synced.simulatorName = xcodeState.simulatorName;
    }
    if (bundleId) {
      synced.bundleId = bundleId;
    }

    if (Object.keys(synced).length > 0) {
      sessionStore.setDefaults(synced);
    }

    if (Object.keys(synced).length === 0) {
      return createSyncXcodeDefaultsResult();
    }

    return createSyncXcodeDefaultsResult();
  };
}

export async function syncXcodeDefaultsLogic(
  params: Params,
  context: SyncXcodeDefaultsContext,
): Promise<void> {
  const handlerContext = getHandlerContext();
  const executeSyncXcodeDefaults = createSyncXcodeDefaultsExecutor(context);
  const result = await executeSyncXcodeDefaults(params);

  setStructuredOutput(handlerContext, result);
}

export const schema = schemaObj.shape;

export const handler = createTypedToolWithContext(schemaObj, syncXcodeDefaultsLogic, () => {
  const { projectPath, workspacePath } = sessionStore.getAll();
  return {
    executor: getDefaultCommandExecutor(),
    cwd: process.cwd(),
    projectPath,
    workspacePath,
  };
});
