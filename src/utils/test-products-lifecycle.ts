import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isPidAlive } from './process-liveness.ts';
import {
  getManagedTestProductsOwnerPid,
  getTestProductsCompletionMarkerPath,
  isMobileBuildMCPManagedTestProductsName,
} from './test-products-path.ts';

export const TEST_PRODUCTS_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
export const TEST_PRODUCTS_MAX_COUNT = 100;

interface RetainedTestProducts {
  path: string;
  name: string;
  mtimeMs: number;
}

export interface TestProductsProtectionOptions {
  now: number;
  minVisibleMs: number;
}

export interface PruneManagedTestProductsOptions extends TestProductsProtectionOptions {
  testProductsDir: string;
  maxAgeMs?: number;
  maxCount?: number;
}

async function hasCompletionMarker(testProductsPath: string): Promise<boolean> {
  try {
    return (await fs.stat(getTestProductsCompletionMarkerPath(testProductsPath))).isFile();
  } catch {
    return false;
  }
}

export async function isProtectedManagedTestProducts(
  artifact: RetainedTestProducts,
  options: TestProductsProtectionOptions,
): Promise<boolean> {
  if (options.now - artifact.mtimeMs < options.minVisibleMs) {
    return true;
  }

  const ownerPid = getManagedTestProductsOwnerPid(artifact.name);
  return Boolean(ownerPid && isPidAlive(ownerPid) && !(await hasCompletionMarker(artifact.path)));
}

export async function pruneManagedTestProductsDirectory(
  options: PruneManagedTestProductsOptions,
): Promise<{ scanned: number; deleted: number }> {
  await fs.mkdir(options.testProductsDir, { recursive: true, mode: 0o700 });
  const entries = await fs.readdir(options.testProductsDir, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isDirectory() && isMobileBuildMCPManagedTestProductsName(entry.name))
    .map((entry) => ({
      name: entry.name,
      path: path.join(options.testProductsDir, entry.name),
    }));
  const stats = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        return {
          ...candidate,
          mtimeMs: (await fs.stat(candidate.path)).mtimeMs,
        } satisfies RetainedTestProducts;
      } catch {
        return null;
      }
    }),
  );

  const retained: RetainedTestProducts[] = [];
  const expired: RetainedTestProducts[] = [];
  for (const artifact of stats) {
    if (!artifact || (await isProtectedManagedTestProducts(artifact, options))) {
      continue;
    }
    if (options.now - artifact.mtimeMs > (options.maxAgeMs ?? TEST_PRODUCTS_MAX_AGE_MS)) {
      expired.push(artifact);
    } else {
      retained.push(artifact);
    }
  }

  const excessCount = retained.length - (options.maxCount ?? TEST_PRODUCTS_MAX_COUNT);
  const overflow =
    excessCount > 0
      ? retained
          .slice()
          .sort((left, right) => left.mtimeMs - right.mtimeMs)
          .slice(0, excessCount)
      : [];
  const deletions = await Promise.all(
    [...expired, ...overflow].map(async (artifact) => {
      try {
        await fs.rm(artifact.path, { recursive: true, force: true });
        await fs.rm(getTestProductsCompletionMarkerPath(artifact.path), { force: true });
        return true;
      } catch {
        return false;
      }
    }),
  );

  return {
    scanned: stats.filter((artifact) => artifact !== null).length,
    deleted: deletions.filter(Boolean).length,
  };
}
