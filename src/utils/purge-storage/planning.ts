import type { Dirent, Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getWorkspaceFilesystemLayout } from '../log-paths.ts';
import { isPidAlive } from '../process-liveness.ts';
import {
  getResultBundleCompletionMarkerPath,
  isResultBundleCompletionMarkerTempName,
} from '../result-bundle-path.ts';
import {
  WORKSPACE_FILESYSTEM_LIFECYCLE_MIN_VISIBLE_MS,
  collectWorkspaceLifecycleProtectedLogPaths,
  getWorkspaceLifecycleProtectedLogReason,
  isStaleXcodeIdeCallToolTransientDirectoryName,
  isWorkspaceLifecycleProtectedResultBundleDirectory,
  isMobileBuildMCPManagedLogName,
  isMobileBuildMCPManagedResultBundleName,
  xcodeIdeCallToolTransientRoot,
  type WorkspaceLifecycleLogProtectionReason,
} from '../workspace-filesystem-lifecycle.ts';
import { enumeratePurgeStorage } from './enumerate.ts';
import { readRegistryRecord } from './registry-record.ts';
import { describeFsError, errorMessage, isEnoent, scanPath } from './scan.ts';
import { collectTestProductsCandidates } from './test-products.ts';
import type {
  PlanPurgeStorageOptions,
  PurgeStorageCandidate,
  PurgeStorageDeletableClass,
  PurgeStoragePlan,
  PurgeStorageReport,
  PurgeStorageScope,
  PurgeStorageSkippedCandidate,
  PurgeWorkspaceSummary,
  RequiredPlanContext,
} from './types.ts';

function assertValidPlanOptions(options: PlanPurgeStorageOptions): void {
  if (options.classes.includes('derivedData') && options.derivedDataExplicit !== true) {
    throw new Error('DerivedData purge requires derivedDataExplicit: true');
  }
}

function selectedWorkspacesForScope(
  report: PurgeStorageReport,
  scope: PurgeStorageScope,
  warnings: string[],
): PurgeWorkspaceSummary[] {
  switch (scope.type) {
    case 'workspace': {
      const workspace = report.workspaces.find(
        (entry) => entry.workspaceKey === scope.workspaceKey,
      );
      if (!workspace) {
        warnings.push(`Workspace ${scope.workspaceKey} was not found`);
        return [];
      }
      return [workspace];
    }
    case 'workspaces': {
      const workspaceKeys = new Set(scope.workspaceKeys);
      const selected = report.workspaces.filter((workspace) =>
        workspaceKeys.has(workspace.workspaceKey),
      );
      for (const workspaceKey of workspaceKeys) {
        if (!selected.some((workspace) => workspace.workspaceKey === workspaceKey)) {
          warnings.push(`Workspace ${workspaceKey} was not found`);
        }
      }
      return selected;
    }
    case 'family':
      return report.workspaces.filter(
        (workspace) => workspace.recognized && workspace.family === scope.family,
      );
    case 'all':
      return report.workspaces.filter((workspace) => workspace.recognized);
  }
}

function shouldKeepForRetention(params: {
  mtimeMs: number;
  now: number;
  olderThanMs?: number;
}): string | null {
  if (params.olderThanMs !== undefined && params.now - params.mtimeMs <= params.olderThanMs) {
    return `newer than retention filter (${params.olderThanMs}ms)`;
  }
  return null;
}

function retentionMtimeForCandidate(params: {
  isDirectory: boolean;
  statMtimeMs: number;
  latestFileMtimeMs: number | null;
  latestDirectoryMtimeMs: number | null;
}): number {
  if (!params.isDirectory) {
    return params.statMtimeMs;
  }
  return params.latestFileMtimeMs ?? params.latestDirectoryMtimeMs ?? params.statMtimeMs;
}

function lifecycleLogProtectionReasonText(reason: WorkspaceLifecycleLogProtectionReason): string {
  switch (reason) {
    case 'protectedPath':
      return 'protected by active lifecycle owner';
    case 'recent':
      return 'protected by lifecycle visibility window';
    case 'liveHelperPid':
      return 'protected by active helper process';
  }
}

async function candidateFromPath(params: {
  workspaceKey: string;
  storageClass: PurgeStorageDeletableClass;
  candidatePath: string;
  reason: string;
  now: number;
  olderThanMs?: number;
  sidecarPaths?: string[];
}): Promise<PurgeStorageCandidate | PurgeStorageSkippedCandidate> {
  const skip = (reason: string): PurgeStorageSkippedCandidate => ({
    workspaceKey: params.workspaceKey,
    storageClass: params.storageClass,
    path: params.candidatePath,
    reason,
  });

  let stat: Stats;
  try {
    stat = await fs.lstat(params.candidatePath);
  } catch (error) {
    return skip(describeFsError(error, 'path disappeared during planning'));
  }

  if (stat.isSymbolicLink()) {
    return skip('symbolic link skipped');
  }

  if (!stat.isFile() && !stat.isDirectory()) {
    return skip('non-regular filesystem entry skipped');
  }

  const scan = await scanPath(params.candidatePath);
  const retentionMtimeMs = retentionMtimeForCandidate({
    isDirectory: stat.isDirectory(),
    statMtimeMs: stat.mtimeMs,
    latestFileMtimeMs: scan.latestFileMtimeMs,
    latestDirectoryMtimeMs: scan.latestDirectoryMtimeMs,
  });

  const retentionReason = shouldKeepForRetention({
    mtimeMs: retentionMtimeMs,
    now: params.now,
    olderThanMs: params.olderThanMs,
  });
  if (retentionReason) {
    return skip(retentionReason);
  }

  return {
    workspaceKey: params.workspaceKey,
    storageClass: params.storageClass,
    path: params.candidatePath,
    kind: stat.isDirectory() ? 'directory' : 'file',
    bytes: scan.bytes,
    fileCount: scan.fileCount,
    directoryCount: scan.directoryCount,
    mtimeMs: stat.mtimeMs,
    reason: params.reason,
    sidecarPaths: params.sidecarPaths ?? [],
  };
}

function isCandidate(
  candidate: PurgeStorageCandidate | PurgeStorageSkippedCandidate,
): candidate is PurgeStorageCandidate {
  return 'bytes' in candidate;
}

async function readManagedDir(dir: string): Promise<{ entries: Dirent[]; error: string | null }> {
  let stat: Stats;
  try {
    stat = await fs.lstat(dir);
  } catch (error) {
    return { entries: [], error: isEnoent(error) ? null : errorMessage(error) };
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    return { entries: [], error: null };
  }
  try {
    return { entries: await fs.readdir(dir, { withFileTypes: true }), error: null };
  } catch (error) {
    return { entries: [], error: isEnoent(error) ? null : errorMessage(error) };
  }
}

function unreadableDirSkip(
  workspaceKey: string,
  storageClass: PurgeStorageDeletableClass,
  dir: string,
  error: string,
): PurgeStorageSkippedCandidate {
  return {
    workspaceKey,
    storageClass,
    path: dir,
    reason: `directory unreadable; skipped (${error})`,
  };
}

async function collectDerivedDataCandidates(
  workspaceKey: string,
  options: RequiredPlanContext,
): Promise<Array<PurgeStorageCandidate | PurgeStorageSkippedCandidate>> {
  const derivedDataDir = getWorkspaceFilesystemLayout(workspaceKey).derivedData;
  const { entries, error } = await readManagedDir(derivedDataDir);
  const candidates = await Promise.all(
    entries.map((entry) =>
      candidateFromPath({
        workspaceKey,
        storageClass: 'derivedData',
        candidatePath: path.join(derivedDataDir, entry.name),
        reason: 'explicit DerivedData purge',
        ...options,
      }),
    ),
  );
  return error
    ? [unreadableDirSkip(workspaceKey, 'derivedData', derivedDataDir, error), ...candidates]
    : candidates;
}

async function collectLogCandidates(
  workspaceKey: string,
  options: RequiredPlanContext,
): Promise<Array<PurgeStorageCandidate | PurgeStorageSkippedCandidate>> {
  const layout = getWorkspaceFilesystemLayout(workspaceKey);
  const { entries, error } = await readManagedDir(layout.logs);
  const protectedPaths = await collectWorkspaceLifecycleProtectedLogPaths({ workspaceKey });
  const candidates = entries
    .filter((entry) => entry.isFile() && isMobileBuildMCPManagedLogName(entry.name))
    .map((entry) => ({ name: entry.name, path: path.join(layout.logs, entry.name) }));

  const planned = await Promise.all(
    candidates.map(async (candidate) => {
      let stat: Stats;
      try {
        stat = await fs.lstat(candidate.path);
      } catch (error) {
        return {
          workspaceKey,
          storageClass: 'logs' as const,
          path: candidate.path,
          reason: describeFsError(error, 'path disappeared during planning'),
        };
      }

      if (!stat.isFile()) {
        return {
          workspaceKey,
          storageClass: 'logs' as const,
          path: candidate.path,
          reason: 'non-regular filesystem entry skipped',
        };
      }

      const protectionReason = getWorkspaceLifecycleProtectedLogReason(
        { path: candidate.path, name: candidate.name, mtimeMs: stat.mtimeMs },
        {
          now: options.now,
          minVisibleMs: WORKSPACE_FILESYSTEM_LIFECYCLE_MIN_VISIBLE_MS,
          protectedPaths,
        },
      );
      if (protectionReason) {
        return {
          workspaceKey,
          storageClass: 'logs' as const,
          path: candidate.path,
          reason: lifecycleLogProtectionReasonText(protectionReason),
        };
      }

      return candidateFromPath({
        workspaceKey,
        storageClass: 'logs',
        candidatePath: candidate.path,
        reason: 'managed log',
        ...options,
      });
    }),
  );
  return error
    ? [unreadableDirSkip(workspaceKey, 'logs', layout.logs, error), ...planned]
    : planned;
}

async function collectResultBundleCandidates(
  workspaceKey: string,
  options: RequiredPlanContext,
): Promise<Array<PurgeStorageCandidate | PurgeStorageSkippedCandidate>> {
  const layout = getWorkspaceFilesystemLayout(workspaceKey);
  const { entries, error } = await readManagedDir(layout.resultBundles);
  const candidates = entries
    .filter((entry) => entry.isDirectory() && isMobileBuildMCPManagedResultBundleName(entry.name))
    .map((entry) => ({
      name: entry.name,
      bundlePath: path.join(layout.resultBundles, entry.name),
    }));
  const tempMarkers = entries
    .filter((entry) => entry.isFile() && isResultBundleCompletionMarkerTempName(entry.name))
    .map((entry) => path.join(layout.resultBundles, entry.name));

  const planned: Array<PurgeStorageCandidate | PurgeStorageSkippedCandidate> = error
    ? [unreadableDirSkip(workspaceKey, 'resultBundles', layout.resultBundles, error)]
    : [];
  for (const tempMarker of tempMarkers) {
    planned.push(
      await candidateFromPath({
        workspaceKey,
        storageClass: 'resultBundles',
        candidatePath: tempMarker,
        reason: 'orphan result bundle completion temp marker',
        ...options,
      }),
    );
  }
  for (const candidate of candidates) {
    let stat: Stats;
    try {
      stat = await fs.lstat(candidate.bundlePath);
    } catch (error) {
      planned.push({
        workspaceKey,
        storageClass: 'resultBundles',
        path: candidate.bundlePath,
        reason: describeFsError(error, 'path disappeared during planning'),
      });
      continue;
    }

    if (
      await isWorkspaceLifecycleProtectedResultBundleDirectory(
        { name: candidate.name, path: candidate.bundlePath, mtimeMs: stat.mtimeMs },
        { now: options.now, minVisibleMs: 0 },
      )
    ) {
      planned.push({
        workspaceKey,
        storageClass: 'resultBundles',
        path: candidate.bundlePath,
        reason: 'protected by active lifecycle owner',
      });
      continue;
    }

    planned.push(
      await candidateFromPath({
        workspaceKey,
        storageClass: 'resultBundles',
        candidatePath: candidate.bundlePath,
        reason: 'managed result bundle',
        sidecarPaths: [getResultBundleCompletionMarkerPath(candidate.bundlePath)],
        ...options,
      }),
    );
  }
  return planned;
}

async function collectSimulatorOsLogRegistryCandidates(
  workspaceKey: string,
  options: RequiredPlanContext,
): Promise<Array<PurgeStorageCandidate | PurgeStorageSkippedCandidate>> {
  const registryDir = getWorkspaceFilesystemLayout(workspaceKey).simulatorLaunchOsLogRegistryDir;
  const { entries, error } = await readManagedDir(registryDir);
  const candidates: Array<PurgeStorageCandidate | PurgeStorageSkippedCandidate> = error
    ? [unreadableDirSkip(workspaceKey, 'stateTransients', registryDir, error)]
    : [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }
    const candidatePath = path.join(registryDir, entry.name);
    const result = await readRegistryRecord(candidatePath);
    if (result.status === 'unreadable') {
      candidates.push({
        workspaceKey,
        storageClass: 'stateTransients',
        path: candidatePath,
        reason: `registry record unreadable; protected (${result.reason})`,
      });
      continue;
    }
    if (
      result.status === 'record' &&
      (isPidAlive(result.record.ownerPid) || isPidAlive(result.record.helperPid))
    ) {
      candidates.push({
        workspaceKey,
        storageClass: 'stateTransients',
        path: candidatePath,
        reason: 'protected by active OSLog owner',
      });
      continue;
    }
    candidates.push(
      await candidateFromPath({
        workspaceKey,
        storageClass: 'stateTransients',
        candidatePath,
        reason: 'stale simulator OSLog registry record',
        ...options,
      }),
    );
  }

  return candidates;
}

async function collectStateTransientCandidates(
  workspaceKey: string,
  options: RequiredPlanContext,
): Promise<Array<PurgeStorageCandidate | PurgeStorageSkippedCandidate>> {
  const callToolRoot = xcodeIdeCallToolTransientRoot(workspaceKey);
  const { entries: callToolEntries, error } = await readManagedDir(callToolRoot);
  const callToolCandidates = await Promise.all(
    callToolEntries
      .filter(
        (entry) => entry.isDirectory() && isStaleXcodeIdeCallToolTransientDirectoryName(entry.name),
      )
      .map((entry) =>
        candidateFromPath({
          workspaceKey,
          storageClass: 'stateTransients',
          candidatePath: path.join(callToolRoot, entry.name),
          reason: 'stale xcode-ide call-tool transient',
          ...options,
        }),
      ),
  );

  return [
    ...(error ? [unreadableDirSkip(workspaceKey, 'stateTransients', callToolRoot, error)] : []),
    ...callToolCandidates,
    ...(await collectSimulatorOsLogRegistryCandidates(workspaceKey, options)),
  ];
}

async function collectCandidatesForWorkspaceClass(
  workspaceKey: string,
  storageClass: PurgeStorageDeletableClass,
  options: RequiredPlanContext,
): Promise<Array<PurgeStorageCandidate | PurgeStorageSkippedCandidate>> {
  switch (storageClass) {
    case 'derivedData':
      return collectDerivedDataCandidates(workspaceKey, options);
    case 'logs':
      return collectLogCandidates(workspaceKey, options);
    case 'resultBundles':
      return collectResultBundleCandidates(workspaceKey, options);
    case 'testProducts':
      return collectTestProductsCandidates(workspaceKey, options);
    case 'stateTransients':
      return collectStateTransientCandidates(workspaceKey, options);
  }
}

function buildPlanContext(options: PlanPurgeStorageOptions): RequiredPlanContext {
  const context: RequiredPlanContext = {
    now: options.now ?? Date.now(),
  };
  if (options.olderThanMs !== undefined) {
    context.olderThanMs = options.olderThanMs;
  }
  return context;
}

export async function planPurgeStorage(
  options: PlanPurgeStorageOptions,
): Promise<PurgeStoragePlan> {
  assertValidPlanOptions(options);
  const report =
    options.report ?? (await enumeratePurgeStorage({ now: options.now, scope: options.scope }));
  const warnings = [...report.warnings];
  if (options.classes.includes('derivedData')) {
    warnings.push(
      'DerivedData purge has no active-build signal; safety relies on explicit selection, age filters, workspace locks, and containment checks',
    );
  }
  const selectedWorkspaces = selectedWorkspacesForScope(report, options.scope, warnings);
  const context = buildPlanContext(options);

  if (options.scope.type === 'all') {
    warnings.push('Scope "all" targets every recognized workspace on this machine.');
  } else if (options.scope.type === 'family') {
    warnings.push(
      `Scope "family ${options.scope.family}" targets every workspace whose project basename is "${options.scope.family}", which may include unrelated projects that share that name.`,
    );
  }

  const candidates: PurgeStorageCandidate[] = [];
  const skipped: PurgeStorageSkippedCandidate[] = [];
  for (const workspace of selectedWorkspaces) {
    for (const storageClass of options.classes) {
      const planned = await collectCandidatesForWorkspaceClass(
        workspace.workspaceKey,
        storageClass,
        context,
      );
      for (const item of planned) {
        if (isCandidate(item)) {
          candidates.push(item);
        } else {
          skipped.push(item);
        }
      }
    }
  }

  const plan: PurgeStoragePlan = {
    action: 'dry-run',
    scope: options.scope,
    classes: options.classes,
    report,
    selectedWorkspaceKeys: selectedWorkspaces.map((workspace) => workspace.workspaceKey),
    candidates,
    skipped,
    totals: {
      bytes: candidates.reduce((total, candidate) => total + candidate.bytes, 0),
      fileCount: candidates.reduce((total, candidate) => total + candidate.fileCount, 0),
      directoryCount: candidates.reduce((total, candidate) => total + candidate.directoryCount, 0),
      candidateCount: candidates.length,
    },
    warnings,
  };
  return plan;
}
