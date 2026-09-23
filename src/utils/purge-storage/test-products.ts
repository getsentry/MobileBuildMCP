import type { Dirent, Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getWorkspaceFilesystemLayout } from '../log-paths.ts';
import {
  getTestProductsCompletionMarkerPath,
  isTestProductsCompletionMarkerTempName,
  isMobileBuildMCPManagedTestProductsName,
} from '../test-products-path.ts';
import { isProtectedManagedTestProducts } from '../test-products-lifecycle.ts';
import { describeFsError, errorMessage, isEnoent, scanPath } from './scan.ts';
import type {
  PurgeStorageCandidate,
  PurgeStorageSkippedCandidate,
  RequiredPlanContext,
} from './types.ts';

type PlannedTestProductsCandidate = PurgeStorageCandidate | PurgeStorageSkippedCandidate;

function skipped(
  workspaceKey: string,
  candidatePath: string,
  reason: string,
): PurgeStorageSkippedCandidate {
  return { workspaceKey, storageClass: 'testProducts', path: candidatePath, reason };
}

async function readManagedDir(
  directory: string,
): Promise<{ entries: Dirent[]; error: string | null }> {
  try {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return { entries: [], error: null };
    }
    return { entries: await fs.readdir(directory, { withFileTypes: true }), error: null };
  } catch (error) {
    return { entries: [], error: isEnoent(error) ? null : errorMessage(error) };
  }
}

async function candidateFromPath(params: {
  workspaceKey: string;
  candidatePath: string;
  reason: string;
  now: number;
  olderThanMs?: number;
  sidecarPaths?: string[];
}): Promise<PlannedTestProductsCandidate> {
  let stat: Stats;
  try {
    stat = await fs.lstat(params.candidatePath);
  } catch (error) {
    return skipped(
      params.workspaceKey,
      params.candidatePath,
      describeFsError(error, 'path disappeared during planning'),
    );
  }
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
    return skipped(
      params.workspaceKey,
      params.candidatePath,
      'non-regular filesystem entry skipped',
    );
  }

  const scan = await scanPath(params.candidatePath);
  const retentionMtimeMs = stat.isDirectory()
    ? (scan.latestFileMtimeMs ?? scan.latestDirectoryMtimeMs ?? stat.mtimeMs)
    : stat.mtimeMs;
  if (params.olderThanMs !== undefined && params.now - retentionMtimeMs <= params.olderThanMs) {
    return skipped(
      params.workspaceKey,
      params.candidatePath,
      `newer than retention filter (${params.olderThanMs}ms)`,
    );
  }

  return {
    workspaceKey: params.workspaceKey,
    storageClass: 'testProducts',
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

export async function collectTestProductsCandidates(
  workspaceKey: string,
  options: RequiredPlanContext,
): Promise<PlannedTestProductsCandidate[]> {
  const testProductsDir = getWorkspaceFilesystemLayout(workspaceKey).testProducts;
  const { entries, error } = await readManagedDir(testProductsDir);
  const planned: PlannedTestProductsCandidate[] = error
    ? [skipped(workspaceKey, testProductsDir, `directory unreadable; skipped (${error})`)]
    : [];

  for (const entry of entries) {
    const candidatePath = path.join(testProductsDir, entry.name);
    if (entry.isFile() && isTestProductsCompletionMarkerTempName(entry.name)) {
      planned.push(
        await candidateFromPath({
          workspaceKey,
          candidatePath,
          reason: 'orphan test products completion temp marker',
          ...options,
        }),
      );
      continue;
    }
    if (!entry.isDirectory() || !isMobileBuildMCPManagedTestProductsName(entry.name)) {
      continue;
    }

    let stat: Stats;
    try {
      stat = await fs.lstat(candidatePath);
    } catch (statError) {
      planned.push(
        skipped(
          workspaceKey,
          candidatePath,
          describeFsError(statError, 'path disappeared during planning'),
        ),
      );
      continue;
    }
    if (
      await isProtectedManagedTestProducts(
        { name: entry.name, path: candidatePath, mtimeMs: stat.mtimeMs },
        { now: options.now, minVisibleMs: 0 },
      )
    ) {
      planned.push(skipped(workspaceKey, candidatePath, 'protected by active lifecycle owner'));
      continue;
    }

    planned.push(
      await candidateFromPath({
        workspaceKey,
        candidatePath,
        reason: 'managed test products',
        sidecarPaths: [getTestProductsCompletionMarkerPath(candidatePath)],
        ...options,
      }),
    );
  }
  return planned;
}
