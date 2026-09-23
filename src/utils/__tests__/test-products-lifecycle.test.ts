import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  TEST_PRODUCTS_MAX_AGE_MS,
  pruneManagedTestProductsDirectory,
} from '../test-products-lifecycle.ts';
import {
  getTestProductsCompletionMarkerPath,
  isMobileBuildMCPManagedTestProductsName,
} from '../test-products-path.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEAD_OWNER_PID = 999_999_999;

function managedName(name: string, pid = DEAD_OWNER_PID): string {
  return `${name}_2026-05-02T12-00-00-000Z_pid${pid}_abcdef12.xctestproducts`;
}

function writeTestProducts(directory: string, mtimeMs: number, completed = false): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'Tests.xctestrun'), 'stub');
  const mtime = new Date(mtimeMs);
  utimesSync(directory, mtime, mtime);
  if (completed) {
    writeFileSync(getTestProductsCompletionMarkerPath(directory), 'completed');
  }
}

describe('test products lifecycle', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'mobilebuildmcp-test-products-lifecycle-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('prunes managed products after three days while preserving caller-owned paths', async () => {
    const now = Date.UTC(2026, 4, 6, 12);
    const oldManaged = path.join(root, managedName('old'));
    const recentManaged = path.join(root, managedName('recent'));
    const callerOwned = path.join(root, 'caller-provided.xctestproducts');
    const externalCallerOwned = path.join(
      path.dirname(root),
      `${path.basename(root)}-external-caller.xctestproducts`,
    );
    writeTestProducts(oldManaged, now - TEST_PRODUCTS_MAX_AGE_MS - 1, true);
    writeTestProducts(recentManaged, now - 2 * DAY_MS, true);
    writeTestProducts(callerOwned, now - 10 * DAY_MS, true);
    writeTestProducts(externalCallerOwned, now - 10 * DAY_MS, true);

    const result = await pruneManagedTestProductsDirectory({
      testProductsDir: root,
      now,
      minVisibleMs: 0,
    });

    expect(result).toEqual({ scanned: 2, deleted: 1 });
    expect(existsSync(oldManaged)).toBe(false);
    expect(existsSync(recentManaged)).toBe(true);
    expect(existsSync(callerOwned)).toBe(true);
    expect(existsSync(externalCallerOwned)).toBe(true);
    await rm(externalCallerOwned, { recursive: true, force: true });
  });

  it('protects live in-progress products until their completion marker exists', async () => {
    const now = Date.UTC(2026, 4, 6, 12);
    const live = path.join(root, managedName('live', process.pid));
    writeTestProducts(live, now - 4 * DAY_MS);

    expect(isMobileBuildMCPManagedTestProductsName(path.basename(live))).toBe(true);
    expect(
      await pruneManagedTestProductsDirectory({ testProductsDir: root, now, minVisibleMs: 0 }),
    ).toEqual({ scanned: 1, deleted: 0 });
    expect(existsSync(live)).toBe(true);

    writeFileSync(getTestProductsCompletionMarkerPath(live), 'completed');
    expect(
      await pruneManagedTestProductsDirectory({ testProductsDir: root, now, minVisibleMs: 0 }),
    ).toEqual({ scanned: 1, deleted: 1 });
    expect(existsSync(live)).toBe(false);
  });

  it('uses a separate count cap for retained test products', async () => {
    const now = Date.UTC(2026, 4, 6, 12);
    const oldest = path.join(root, managedName('oldest'));
    const middle = path.join(root, managedName('middle'));
    const newest = path.join(root, managedName('newest'));
    writeTestProducts(oldest, now - 3 * DAY_MS, true);
    writeTestProducts(middle, now - 2 * DAY_MS, true);
    writeTestProducts(newest, now - DAY_MS, true);

    const result = await pruneManagedTestProductsDirectory({
      testProductsDir: root,
      now,
      minVisibleMs: 0,
      maxAgeMs: 10 * DAY_MS,
      maxCount: 2,
    });

    expect(result).toEqual({ scanned: 3, deleted: 1 });
    expect(existsSync(oldest)).toBe(false);
    expect(existsSync(middle)).toBe(true);
    expect(existsSync(newest)).toBe(true);
  });
});
