import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  enumeratePurgeStorage,
  executePurgeStoragePlan,
  planPurgeStorage,
} from '../purge-storage.ts';
import {
  getWorkspaceFilesystemLayout,
  setMobileBuildMCPAppDirOverrideForTests,
} from '../log-paths.ts';
import { getTestProductsCompletionMarkerPath } from '../test-products-path.ts';

const WORKSPACE_KEY = 'Demo-aaaaaaaaaaaa';

function writeTestProducts(directory: string, mtimeMs: number): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'Tests.xctestrun'), 'stub');
  const mtime = new Date(mtimeMs);
  utimesSync(directory, mtime, mtime);
}

describe('test products purge storage', () => {
  let appDir: string;

  beforeEach(() => {
    appDir = mkdtempSync(path.join(tmpdir(), 'mobilebuildmcp-test-products-purge-'));
    setMobileBuildMCPAppDirOverrideForTests(appDir);
  });

  afterEach(async () => {
    setMobileBuildMCPAppDirOverrideForTests(null);
    await rm(appDir, { recursive: true, force: true });
  });

  it('reports and deletes only managed test products in the workspace storage root', async () => {
    const now = Date.UTC(2026, 4, 6, 12);
    const layout = getWorkspaceFilesystemLayout(WORKSPACE_KEY);
    const managed = path.join(
      layout.testProducts,
      'test_sim_2026-05-02T12-00-00-000Z_pid999999999_abcdef12.xctestproducts',
    );
    const callerOwned = path.join(layout.testProducts, 'caller-provided.xctestproducts');
    const externalCallerOwned = path.join(appDir, 'external-caller.xctestproducts');
    writeTestProducts(managed, now - 4 * 24 * 60 * 60 * 1000);
    writeFileSync(getTestProductsCompletionMarkerPath(managed), 'completed');
    writeTestProducts(callerOwned, now - 4 * 24 * 60 * 60 * 1000);
    writeTestProducts(externalCallerOwned, now - 4 * 24 * 60 * 60 * 1000);

    const report = await enumeratePurgeStorage({
      scope: { type: 'workspace', workspaceKey: WORKSPACE_KEY },
    });
    expect(report.workspaces[0]?.classes.testProducts.exists).toBe(true);

    const plan = await planPurgeStorage({
      report,
      scope: { type: 'workspace', workspaceKey: WORKSPACE_KEY },
      classes: ['testProducts'],
      now,
    });
    expect(plan.candidates.map((candidate) => candidate.path)).toEqual([managed]);

    const result = await executePurgeStoragePlan(plan, { now });
    expect(result.deleted.map((entry) => entry.path)).toEqual([managed]);
    expect(existsSync(managed)).toBe(false);
    expect(existsSync(getTestProductsCompletionMarkerPath(managed))).toBe(false);
    expect(existsSync(callerOwned)).toBe(true);
    expect(existsSync(externalCallerOwned)).toBe(true);
  });
});
