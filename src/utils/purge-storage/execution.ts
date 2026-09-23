import type { Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tryAcquireFsLock, type AcquiredFsLock } from '../fs-lock.ts';
import { getWorkspaceFilesystemLayout, getWorkspacesDir } from '../log-paths.ts';
import { isPidAlive } from '../process-liveness.ts';
import {
  getResultBundleCompletionMarkerPath,
  isResultBundleCompletionMarkerTempName,
} from '../result-bundle-path.ts';
import {
  getTestProductsCompletionMarkerPath,
  isTestProductsCompletionMarkerTempName,
  isMobileBuildMCPManagedTestProductsName,
} from '../test-products-path.ts';
import { isProtectedManagedTestProducts } from '../test-products-lifecycle.ts';
import {
  WORKSPACE_FILESYSTEM_LIFECYCLE_LOCK_LEASE_MS,
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
import { readRegistryRecord } from './registry-record.ts';
import { describeFsError, errorMessage, isEnoent } from './scan.ts';
import type {
  ExecutePurgeStoragePlanOptions,
  PurgeStorageCandidate,
  PurgeStorageDeletableClass,
  PurgeStorageDeletedEntry,
  PurgeStorageExecutionResult,
  PurgeStoragePlan,
  PurgeStorageSkippedCandidate,
} from './types.ts';

const PURGE_LOCK_PURPOSE = 'filesystem-lifecycle';

function pathIsInside(parentPath: string, childPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
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

function deletionRootForClass(
  workspaceKey: string,
  storageClass: PurgeStorageDeletableClass,
): string {
  const layout = getWorkspaceFilesystemLayout(workspaceKey);
  switch (storageClass) {
    case 'derivedData':
      return layout.derivedData;
    case 'logs':
      return layout.logs;
    case 'resultBundles':
      return layout.resultBundles;
    case 'testProducts':
      return layout.testProducts;
    case 'stateTransients':
      return layout.state;
  }
}

async function pathContainsSymlink(filePath: string, rootPath: string): Promise<boolean> {
  const relative = path.relative(rootPath, filePath);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return true;
  }

  let current = rootPath;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        return true;
      }
    } catch {
      return true;
    }
  }
  return false;
}

async function validateStateTransientCandidate(
  candidate: PurgeStorageCandidate,
): Promise<string | null> {
  const layout = getWorkspaceFilesystemLayout(candidate.workspaceKey);
  const name = path.basename(candidate.path);
  const callToolRoot = xcodeIdeCallToolTransientRoot(candidate.workspaceKey);
  if (
    path.dirname(candidate.path) === callToolRoot &&
    isStaleXcodeIdeCallToolTransientDirectoryName(name)
  ) {
    return null;
  }
  if (
    path.dirname(candidate.path) !== layout.simulatorLaunchOsLogRegistryDir ||
    !name.endsWith('.json')
  ) {
    return 'state transient candidate is outside allowlisted transient roots';
  }

  const result = await readRegistryRecord(candidate.path);
  if (result.status === 'unreadable') {
    return 'state transient candidate registry record is unreadable; protected';
  }
  if (
    result.status === 'record' &&
    (isPidAlive(result.record.ownerPid) || isPidAlive(result.record.helperPid))
  ) {
    return 'state transient candidate is protected by active OSLog owner';
  }
  return null;
}

async function validateClassSpecificDeletionCandidate(
  candidate: PurgeStorageCandidate,
  now: number,
): Promise<string | null> {
  const name = path.basename(candidate.path);
  switch (candidate.storageClass) {
    case 'derivedData':
      return null;
    case 'logs': {
      if (!isMobileBuildMCPManagedLogName(name)) {
        return 'log candidate is not a managed log';
      }
      const protectionReason = getWorkspaceLifecycleProtectedLogReason(
        { path: candidate.path, name, mtimeMs: candidate.mtimeMs },
        {
          now,
          minVisibleMs: WORKSPACE_FILESYSTEM_LIFECYCLE_MIN_VISIBLE_MS,
          protectedPaths: await collectWorkspaceLifecycleProtectedLogPaths({
            workspaceKey: candidate.workspaceKey,
          }),
        },
      );
      if (protectionReason) {
        return `log candidate is ${lifecycleLogProtectionReasonText(protectionReason)}`;
      }
      return null;
    }
    case 'resultBundles':
      if (isResultBundleCompletionMarkerTempName(name)) {
        return candidate.kind === 'file'
          ? null
          : 'result bundle temp marker candidate is not a file';
      }
      if (!isMobileBuildMCPManagedResultBundleName(name)) {
        return 'result bundle candidate is not managed';
      }
      if (
        await isWorkspaceLifecycleProtectedResultBundleDirectory(
          { name, path: candidate.path, mtimeMs: candidate.mtimeMs },
          { now, minVisibleMs: 0 },
        )
      ) {
        return 'result bundle candidate is protected by active lifecycle owner';
      }
      return null;
    case 'testProducts':
      if (isTestProductsCompletionMarkerTempName(name)) {
        return candidate.kind === 'file'
          ? null
          : 'test products temp marker candidate is not a file';
      }
      if (!isMobileBuildMCPManagedTestProductsName(name)) {
        return 'test products candidate is not managed';
      }
      if (
        await isProtectedManagedTestProducts(
          { name, path: candidate.path, mtimeMs: candidate.mtimeMs },
          { now, minVisibleMs: 0 },
        )
      ) {
        return 'test products candidate is protected by active lifecycle owner';
      }
      return null;
    case 'stateTransients':
      return validateStateTransientCandidate(candidate);
  }
}

async function validateDeletionPath(
  candidate: PurgeStorageCandidate,
  now: number,
): Promise<string | null> {
  const workspaceLayout = getWorkspaceFilesystemLayout(candidate.workspaceKey);
  const root = deletionRootForClass(candidate.workspaceKey, candidate.storageClass);
  if (candidate.path === root || !pathIsInside(root, candidate.path)) {
    return 'candidate is outside the intended class root';
  }
  if (!pathIsInside(workspaceLayout.root, candidate.path)) {
    return 'candidate is outside the workspace root';
  }
  if (await pathContainsSymlink(candidate.path, getWorkspacesDir())) {
    return 'candidate path contains a symbolic link or disappeared';
  }
  const stableError = await validateCandidateStillMatchesPlan(candidate);
  if (stableError) {
    return stableError;
  }
  return validateClassSpecificDeletionCandidate(candidate, now);
}

async function validateCandidateStillMatchesPlan(
  candidate: PurgeStorageCandidate,
): Promise<string | null> {
  let stat: Stats;
  try {
    stat = await fs.lstat(candidate.path);
  } catch (error) {
    return isEnoent(error) ? 'path disappeared during deletion' : String(error);
  }
  if (stat.isSymbolicLink()) {
    return 'candidate path contains a symbolic link or disappeared';
  }
  if (candidate.kind === 'directory' && !stat.isDirectory()) {
    return 'candidate kind changed since planning';
  }
  if (candidate.kind === 'file' && !stat.isFile()) {
    return 'candidate kind changed since planning';
  }
  if (stat.mtimeMs !== candidate.mtimeMs) {
    return 'candidate changed since planning';
  }
  return null;
}

async function validateSidecarPath(
  candidate: PurgeStorageCandidate,
  sidecarPath: string,
): Promise<string | null> {
  const layout = getWorkspaceFilesystemLayout(candidate.workspaceKey);
  const expectedSidecarPath =
    candidate.storageClass === 'resultBundles'
      ? getResultBundleCompletionMarkerPath(candidate.path)
      : candidate.storageClass === 'testProducts'
        ? getTestProductsCompletionMarkerPath(candidate.path)
        : null;
  if (expectedSidecarPath === null) {
    return 'sidecar path is not associated with a managed artifact';
  }
  if (sidecarPath !== expectedSidecarPath) {
    return 'sidecar path does not match the candidate completion marker';
  }
  const sidecarRoot =
    candidate.storageClass === 'resultBundles' ? layout.resultBundles : layout.testProducts;
  if (!pathIsInside(sidecarRoot, sidecarPath)) {
    return 'sidecar path is outside the managed artifact root';
  }
  try {
    await fs.lstat(sidecarPath);
  } catch (error) {
    return isEnoent(error) ? null : errorMessage(error);
  }
  if (await pathContainsSymlink(sidecarPath, getWorkspacesDir())) {
    return 'sidecar path contains a symbolic link or disappeared';
  }
  return null;
}

async function deleteCandidate(candidate: PurgeStorageCandidate): Promise<string[]> {
  const warnings: string[] = [];
  if (candidate.kind === 'directory') {
    await fs.rm(candidate.path, { recursive: true, force: false });
  } else {
    await fs.unlink(candidate.path);
  }

  for (const sidecarPath of candidate.sidecarPaths) {
    const sidecarError = await validateSidecarPath(candidate, sidecarPath);
    if (sidecarError) {
      continue;
    }
    await fs.unlink(sidecarPath).catch((error: unknown) => {
      if (!isEnoent(error)) {
        warnings.push(`Sidecar ${sidecarPath} was not deleted: ${errorMessage(error)}`);
      }
    });
  }
  return warnings;
}

function groupCandidatesByWorkspace(
  candidates: PurgeStorageCandidate[],
): Map<string, PurgeStorageCandidate[]> {
  const candidatesByWorkspace = new Map<string, PurgeStorageCandidate[]>();
  for (const candidate of candidates) {
    const existing = candidatesByWorkspace.get(candidate.workspaceKey) ?? [];
    existing.push(candidate);
    candidatesByWorkspace.set(candidate.workspaceKey, existing);
  }
  return candidatesByWorkspace;
}

function skipWorkspaceCandidates(params: {
  workspaceKey: string;
  candidates: PurgeStorageCandidate[];
  message: string;
  skipped: PurgeStorageSkippedCandidate[];
}): void {
  for (const candidate of params.candidates) {
    params.skipped.push({
      workspaceKey: params.workspaceKey,
      storageClass: candidate.storageClass,
      path: candidate.path,
      reason: params.message,
    });
  }
}

async function executeWorkspaceCandidates(params: {
  workspaceKey: string;
  candidates: PurgeStorageCandidate[];
  deleted: PurgeStorageDeletedEntry[];
  skipped: PurgeStorageSkippedCandidate[];
  warnings: string[];
  now: number;
}): Promise<void> {
  for (const candidate of params.candidates) {
    const validationError = await validateDeletionPath(candidate, params.now);
    if (validationError) {
      params.skipped.push({
        workspaceKey: params.workspaceKey,
        storageClass: candidate.storageClass,
        path: candidate.path,
        reason: validationError,
      });
      continue;
    }

    try {
      params.warnings.push(...(await deleteCandidate(candidate)));
      params.deleted.push({
        workspaceKey: params.workspaceKey,
        storageClass: candidate.storageClass,
        path: candidate.path,
        bytes: candidate.bytes,
      });
    } catch (error) {
      params.skipped.push({
        workspaceKey: params.workspaceKey,
        storageClass: candidate.storageClass,
        path: candidate.path,
        reason: describeFsError(error, 'path disappeared during deletion'),
      });
    }
  }
}

export async function executePurgeStoragePlan(
  plan: PurgeStoragePlan,
  options: ExecutePurgeStoragePlanOptions = {},
): Promise<PurgeStorageExecutionResult> {
  const deleted: PurgeStorageDeletedEntry[] = [];
  const skipped: PurgeStorageSkippedCandidate[] = [...plan.skipped];
  const warnings: string[] = [...plan.warnings];

  const now = options.now ?? Date.now();
  for (const [workspaceKey, candidates] of groupCandidatesByWorkspace(plan.candidates).entries()) {
    const layout = getWorkspaceFilesystemLayout(workspaceKey);
    let lock: AcquiredFsLock | null;
    try {
      lock = await tryAcquireFsLock({
        lockDir: layout.filesystemLifecycle.lockDir,
        purpose: PURGE_LOCK_PURPOSE,
        leaseMs: WORKSPACE_FILESYSTEM_LIFECYCLE_LOCK_LEASE_MS,
        now,
      });
    } catch (error) {
      const message = `Workspace ${workspaceKey} skipped because its filesystem lock could not be acquired: ${errorMessage(error)}`;
      warnings.push(message);
      skipWorkspaceCandidates({ workspaceKey, candidates, message, skipped });
      continue;
    }

    if (!lock) {
      const message = `Workspace ${workspaceKey} skipped because its filesystem lock is held`;
      warnings.push(message);
      skipWorkspaceCandidates({ workspaceKey, candidates, message, skipped });
      continue;
    }

    try {
      await executeWorkspaceCandidates({
        workspaceKey,
        candidates,
        deleted,
        skipped,
        warnings,
        now,
      });
    } finally {
      await lock.release();
    }
  }

  return {
    action: 'delete',
    scope: plan.scope,
    classes: plan.classes,
    selectedWorkspaceKeys: plan.selectedWorkspaceKeys,
    deleted,
    skipped,
    totals: {
      bytes: deleted.reduce((total, entry) => total + entry.bytes, 0),
      deletedCount: deleted.length,
      skippedCount: skipped.length,
    },
    warnings,
  };
}
