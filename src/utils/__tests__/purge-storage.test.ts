import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  enumeratePurgeStorage,
  executePurgeStoragePlan,
  parseWorkspaceFamilyKey,
  planPurgeStorage,
  type PurgeStoragePlan,
} from '../purge-storage.ts';
import {
  getWorkspaceFilesystemLayout,
  setMobileBuildMCPAppDirOverrideForTests,
} from '../log-paths.ts';
import { getResultBundleCompletionMarkerPath } from '../result-bundle-path.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEAD_PID = 999_999_999;

let appDir: string;

function writeFileWithMtime(filePath: string, content: string, mtimeMs: number): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  const mtime = new Date(mtimeMs);
  utimesSync(filePath, mtime, mtime);
}

function writeDirectoryWithMtime(dir: string, mtimeMs: number): void {
  mkdirSync(dir, { recursive: true });
  writeFileWithMtime(path.join(dir, 'file.txt'), 'content', mtimeMs);
  const mtime = new Date(mtimeMs);
  utimesSync(dir, mtime, mtime);
}

function managedLogName(name = 'build_sim'): string {
  return `${name}_2026-05-02T12-00-00-000Z_pid123_abcdef12.log`;
}

function managedSimulatorLogName(helperPid: number): string {
  return `simulator_2026-05-02T12-00-00-000Z_helperpid${helperPid}_ownerpid123_abcdef12.log`;
}

function managedResultBundleName(name = 'test', pid = DEAD_PID): string {
  return `${name}_2026-05-02T12-00-00-000Z_pid${pid}_abcdef12.xcresult`;
}

describe('purge storage', () => {
  beforeEach(() => {
    appDir = mkdtempSync(path.join(tmpdir(), 'mobilebuildmcp-purge-storage-'));
    setMobileBuildMCPAppDirOverrideForTests(appDir);
  });

  afterEach(async () => {
    setMobileBuildMCPAppDirOverrideForTests(null);
    await rm(appDir, { recursive: true, force: true });
  });

  it('parses only exact lowercase workspace family keys', () => {
    expect(parseWorkspaceFamilyKey('DemoApp-123456789abc')).toEqual({
      family: 'DemoApp',
      hash: '123456789abc',
    });
    expect(parseWorkspaceFamilyKey('DemoApp-Main-123456789abc')).toEqual({
      family: 'DemoApp-Main',
      hash: '123456789abc',
    });
    expect(parseWorkspaceFamilyKey('DemoApp-123456789ABC')).toBeNull();
    expect(parseWorkspaceFamilyKey('DemoApp')).toBeNull();
  });

  it('enumerates workspace storage and groups only recognized family keys', async () => {
    const now = Date.UTC(2026, 4, 2, 12);
    const first = getWorkspaceFilesystemLayout('DemoApp-123456789abc');
    const second = getWorkspaceFilesystemLayout('DemoApp-abcdefabcdef');
    const separateFamily = getWorkspaceFilesystemLayout('DemoApp-Main-123456789abc');
    const unknown = getWorkspaceFilesystemLayout('manual-workspace');
    writeFileWithMtime(path.join(first.logs, managedLogName()), 'old', now);
    writeFileWithMtime(path.join(second.derivedData, 'Build', 'artifact'), 'derived', now);
    mkdirSync(separateFamily.root, { recursive: true });
    mkdirSync(unknown.root, { recursive: true });

    const report = await enumeratePurgeStorage({ now });

    expect(report.workspaces.map((workspace) => workspace.workspaceKey)).toEqual([
      'DemoApp-123456789abc',
      'DemoApp-abcdefabcdef',
      'DemoApp-Main-123456789abc',
      'manual-workspace',
    ]);
    expect(report.families.map((family) => [family.family, family.workspaceKeys])).toEqual([
      ['DemoApp', ['DemoApp-123456789abc', 'DemoApp-abcdefabcdef']],
      ['DemoApp-Main', ['DemoApp-Main-123456789abc']],
    ]);
    expect(
      report.workspaces.find((workspace) => workspace.workspaceKey === 'manual-workspace'),
    ).toMatchObject({
      recognized: false,
      family: null,
      hash: null,
    });
    expect(report.totals.bytes).toBeGreaterThan(0);
  });

  it('skips symlinks during recursive census scans', async () => {
    const now = Date.UTC(2026, 4, 2, 12);
    const layout = getWorkspaceFilesystemLayout('DemoApp-123456789abc');
    const outside = path.join(appDir, 'outside');
    writeFileWithMtime(path.join(outside, 'secret.txt'), 'outside', now);
    mkdirSync(layout.derivedData, { recursive: true });
    symlinkSync(outside, path.join(layout.derivedData, 'linked-outside'));

    const report = await enumeratePurgeStorage({ now });
    const workspace = report.workspaces[0];

    expect(workspace.classes.derivedData.fileCount).toBe(0);
    expect(workspace.classes.derivedData.scanComplete).toBe(false);
    expect(workspace.classes.derivedData.warnings.join('\n')).toContain('symbolic link skipped');
  });

  it('skips recent managed logs during planning', async () => {
    const now = Date.UTC(2026, 4, 2, 12);
    const layout = getWorkspaceFilesystemLayout('DemoApp-123456789abc');
    const recentLog = path.join(layout.logs, managedLogName('recent'));
    writeFileWithMtime(recentLog, 'recent', now - 1000);

    const plan = await planPurgeStorage({
      scope: { type: 'all' },
      classes: ['logs'],
      now,
    });

    expect(plan.candidates).toHaveLength(0);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0].path).toBe(recentLog);
    expect(plan.skipped[0].reason).toContain('lifecycle visibility window');
    expect(existsSync(recentLog)).toBe(true);
  });

  it('skips helper-owned managed logs during planning', async () => {
    const now = Date.UTC(2026, 4, 2, 12);
    const layout = getWorkspaceFilesystemLayout('DemoApp-123456789abc');
    const helperLog = path.join(layout.logs, managedSimulatorLogName(process.pid));
    writeFileWithMtime(helperLog, 'helper', now - 10 * DAY_MS);

    const plan = await planPurgeStorage({
      scope: { type: 'all' },
      classes: ['logs'],
      now,
    });

    expect(plan.candidates).toHaveLength(0);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0].path).toBe(helperLog);
    expect(plan.skipped[0].reason).toContain('active helper process');
    expect(existsSync(helperLog)).toBe(true);
  });

  it('plans managed logs and result bundles without selecting unknown files', async () => {
    const now = Date.UTC(2026, 4, 2, 12);
    const layout = getWorkspaceFilesystemLayout('DemoApp-123456789abc');
    const oldLog = path.join(layout.logs, managedLogName('old'));
    const unknownLog = path.join(layout.logs, 'manual.log');
    const bundle = path.join(layout.resultBundles, managedResultBundleName('old'));
    writeFileWithMtime(oldLog, 'old', now - 10 * DAY_MS);
    writeFileWithMtime(unknownLog, 'unknown', now - 10 * DAY_MS);
    writeDirectoryWithMtime(bundle, now - 10 * DAY_MS);
    writeFileWithMtime(getResultBundleCompletionMarkerPath(bundle), 'done', now - 10 * DAY_MS);

    const plan = await planPurgeStorage({
      scope: { type: 'all' },
      classes: ['logs', 'resultBundles'],
      now,
    });

    expect(plan.candidates.map((candidate) => path.basename(candidate.path)).sort()).toEqual([
      managedLogName('old'),
      managedResultBundleName('old'),
    ]);
    expect(plan.candidates.some((candidate) => candidate.path === unknownLog)).toBe(false);
  });

  it('requires DerivedData to be explicitly enabled before planning DerivedData candidates', async () => {
    const now = Date.UTC(2026, 4, 2, 12);
    const layout = getWorkspaceFilesystemLayout('DemoApp-123456789abc');
    writeDirectoryWithMtime(path.join(layout.derivedData, 'Project-a'), now - 10 * DAY_MS);

    await expect(
      planPurgeStorage({
        scope: { type: 'all' },
        classes: ['derivedData'],
        now,
      }),
    ).rejects.toThrow('DerivedData purge requires derivedDataExplicit: true');

    const plan = await planPurgeStorage({
      scope: { type: 'all' },
      classes: ['derivedData'],
      now,
      derivedDataExplicit: true,
    });

    expect(plan.candidates).toHaveLength(1);
    expect(path.basename(plan.candidates[0].path)).toBe('Project-a');
  });

  it('applies the older-than filter but otherwise deletes recent artifacts', async () => {
    const now = Date.UTC(2026, 4, 2, 12);
    const layout = getWorkspaceFilesystemLayout('DemoApp-123456789abc');
    const oldDerivedData = path.join(layout.derivedData, 'OldProject');
    const newDerivedData = path.join(layout.derivedData, 'NewProject');
    const recentDerivedData = path.join(layout.derivedData, 'RecentProject');
    writeDirectoryWithMtime(oldDerivedData, now - 30 * DAY_MS);
    writeDirectoryWithMtime(newDerivedData, now - 2 * DAY_MS);
    writeDirectoryWithMtime(recentDerivedData, now - 1000);

    const retentionPlan = await planPurgeStorage({
      scope: { type: 'all' },
      classes: ['derivedData'],
      now,
      olderThanMs: 7 * DAY_MS,
      derivedDataExplicit: true,
    });

    expect(retentionPlan.candidates.map((candidate) => path.basename(candidate.path))).toEqual([
      'OldProject',
    ]);
    expect(retentionPlan.skipped.map((candidate) => path.basename(candidate.path)).sort()).toEqual([
      'NewProject',
      'RecentProject',
    ]);

    const fullPlan = await planPurgeStorage({
      scope: { type: 'all' },
      classes: ['derivedData'],
      now,
      derivedDataExplicit: true,
    });

    expect(fullPlan.candidates.map((candidate) => path.basename(candidate.path)).sort()).toEqual([
      'NewProject',
      'OldProject',
      'RecentProject',
    ]);
    expect(fullPlan.skipped).toHaveLength(0);
  });

  it('excludes unknown workspace keys from all and family scopes but allows explicit workspace scope', async () => {
    const now = Date.UTC(2026, 4, 2, 12);
    const recognized = getWorkspaceFilesystemLayout('DemoApp-123456789abc');
    const unknown = getWorkspaceFilesystemLayout('manual-workspace');
    writeFileWithMtime(
      path.join(recognized.logs, managedLogName('known')),
      'known',
      now - 10 * DAY_MS,
    );
    writeFileWithMtime(
      path.join(unknown.logs, managedLogName('unknown')),
      'unknown',
      now - 10 * DAY_MS,
    );

    const allPlan = await planPurgeStorage({
      scope: { type: 'all' },
      classes: ['logs'],
      now,
    });
    const familyPlan = await planPurgeStorage({
      scope: { type: 'family', family: 'manual-workspace' },
      classes: ['logs'],
      now,
    });
    const explicitPlan = await planPurgeStorage({
      scope: { type: 'workspace', workspaceKey: 'manual-workspace' },
      classes: ['logs'],
      now,
    });

    expect(allPlan.selectedWorkspaceKeys).toEqual(['DemoApp-123456789abc']);
    expect(familyPlan.selectedWorkspaceKeys).toEqual([]);
    expect(explicitPlan.selectedWorkspaceKeys).toEqual(['manual-workspace']);
    expect(explicitPlan.candidates).toHaveLength(1);
  });

  it('plans only allowlisted stale state transients', async () => {
    const now = Date.UTC(2026, 4, 2, 12);
    const layout = getWorkspaceFilesystemLayout('DemoApp-123456789abc');
    const staleCallTool = path.join(
      layout.state,
      'xcode-ide',
      'call-tool',
      'ownerpid999999999_stale',
    );
    const liveCallTool = path.join(
      layout.state,
      'xcode-ide',
      'call-tool',
      `ownerpid${process.pid}_live`,
    );
    const staleRegistry = path.join(layout.simulatorLaunchOsLogRegistryDir, 'stale.json');
    const liveRegistry = path.join(layout.simulatorLaunchOsLogRegistryDir, 'live.json');
    writeDirectoryWithMtime(staleCallTool, now - 10 * DAY_MS);
    writeDirectoryWithMtime(liveCallTool, now - 10 * DAY_MS);
    writeFileWithMtime(
      staleRegistry,
      JSON.stringify({ owner: { pid: DEAD_PID }, helperPid: DEAD_PID }),
      now - 10 * DAY_MS,
    );
    writeFileWithMtime(
      liveRegistry,
      JSON.stringify({ owner: { pid: process.pid }, helperPid: DEAD_PID }),
      now - 10 * DAY_MS,
    );

    const plan = await planPurgeStorage({
      scope: { type: 'all' },
      classes: ['stateTransients'],
      now,
    });

    expect(plan.candidates.map((candidate) => path.basename(candidate.path)).sort()).toEqual([
      'ownerpid999999999_stale',
      'stale.json',
    ]);
    expect(plan.skipped.map((candidate) => path.basename(candidate.path))).toEqual(['live.json']);
  });

  it('revalidates helper-owned managed logs before deletion', async () => {
    const now = Date.UTC(2026, 4, 2, 12);
    const workspaceKey = 'DemoApp-123456789abc';
    const layout = getWorkspaceFilesystemLayout(workspaceKey);
    const helperLog = path.join(layout.logs, managedSimulatorLogName(process.pid));
    writeFileWithMtime(helperLog, 'helper', now - 10 * DAY_MS);
    const stat = lstatSync(helperLog);
    const report = await enumeratePurgeStorage({ now });
    const plan: PurgeStoragePlan = {
      action: 'dry-run',
      scope: { type: 'all' },
      classes: ['logs'],
      report,
      selectedWorkspaceKeys: [workspaceKey],
      candidates: [
        {
          workspaceKey,
          storageClass: 'logs',
          path: helperLog,
          kind: 'file',
          bytes: stat.size,
          fileCount: 1,
          directoryCount: 0,
          mtimeMs: stat.mtimeMs,
          reason: 'managed log',
          sidecarPaths: [],
        },
      ],
      skipped: [],
      totals: {
        bytes: stat.size,
        fileCount: 1,
        directoryCount: 0,
        candidateCount: 1,
      },
      warnings: [],
    };

    const result = await executePurgeStoragePlan(plan, { now });

    expect(result.totals.deletedCount).toBe(0);
    expect(result.totals.skippedCount).toBe(1);
    expect(result.skipped[0].reason).toContain('active helper process');
    expect(existsSync(helperLog)).toBe(true);
  });

  it('deletes planned candidates and managed result-bundle completion markers', async () => {
    const now = Date.UTC(2026, 4, 2, 12);
    const layout = getWorkspaceFilesystemLayout('DemoApp-123456789abc');
    const bundle = path.join(layout.resultBundles, managedResultBundleName('old'));
    const marker = getResultBundleCompletionMarkerPath(bundle);
    writeDirectoryWithMtime(bundle, now - 10 * DAY_MS);
    writeFileWithMtime(marker, 'done', now - 10 * DAY_MS);

    const plan = await planPurgeStorage({
      scope: { type: 'all' },
      classes: ['resultBundles'],
      now,
    });
    const result = await executePurgeStoragePlan(plan, { now });

    expect(result.totals.deletedCount).toBe(1);
    expect(result.totals.skippedCount).toBe(0);
    expect(existsSync(bundle)).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });

  it('reports deleted result bundles even when a sidecar cannot be unlinked', async () => {
    const now = Date.UTC(2026, 4, 2, 12);
    const layout = getWorkspaceFilesystemLayout('DemoApp-123456789abc');
    const bundle = path.join(layout.resultBundles, managedResultBundleName('old'));
    const marker = getResultBundleCompletionMarkerPath(bundle);
    writeDirectoryWithMtime(bundle, now - 10 * DAY_MS);
    mkdirSync(marker, { recursive: true });

    const plan = await planPurgeStorage({
      scope: { type: 'all' },
      classes: ['resultBundles'],
      now,
    });
    const result = await executePurgeStoragePlan(plan, { now });

    expect(result.totals.deletedCount).toBe(1);
    expect(result.totals.skippedCount).toBe(0);
    expect(result.warnings.join('\n')).toContain('Sidecar');
    expect(existsSync(bundle)).toBe(false);
    expect(existsSync(marker)).toBe(true);
  });

  it('deletes orphan result-bundle completion temp markers', async () => {
    const now = Date.UTC(2026, 4, 2, 12);
    const layout = getWorkspaceFilesystemLayout('DemoApp-123456789abc');
    const tempMarker = path.join(
      layout.resultBundles,
      `${managedResultBundleName('old')}.mobilebuildmcp-completed.1234_abcd1234.tmp`,
    );
    writeFileWithMtime(tempMarker, 'tmp', now - 10 * DAY_MS);

    const plan = await planPurgeStorage({
      scope: { type: 'all' },
      classes: ['resultBundles'],
      now,
    });
    const result = await executePurgeStoragePlan(plan, { now });

    expect(plan.candidates.map((candidate) => candidate.path)).toEqual([tempMarker]);
    expect(result.totals.deletedCount).toBe(1);
    expect(result.totals.skippedCount).toBe(0);
    expect(existsSync(tempMarker)).toBe(false);
  });

  it('skips deletion when the per-workspace lifecycle lock is held', async () => {
    const now = Date.UTC(2026, 4, 2, 12);
    const layout = getWorkspaceFilesystemLayout('DemoApp-123456789abc');
    const oldLog = path.join(layout.logs, managedLogName('old'));
    writeFileWithMtime(oldLog, 'old', now - 10 * DAY_MS);
    mkdirSync(layout.filesystemLifecycle.lockDir, { recursive: true });

    const plan = await planPurgeStorage({
      scope: { type: 'all' },
      classes: ['logs'],
      now,
    });
    const result = await executePurgeStoragePlan(plan, { now });

    expect(result.totals.deletedCount).toBe(0);
    expect(result.totals.skippedCount).toBe(1);
    expect(result.warnings.join('\n')).toContain('filesystem lock is held');
    expect(existsSync(oldLog)).toBe(true);
  });

  it('reports planned candidates that disappear before deletion as skipped', async () => {
    const now = Date.UTC(2026, 4, 2, 12);
    const layout = getWorkspaceFilesystemLayout('DemoApp-123456789abc');
    const oldLog = path.join(layout.logs, managedLogName('old'));
    writeFileWithMtime(oldLog, 'old', now - 10 * DAY_MS);

    const plan = await planPurgeStorage({
      scope: { type: 'all' },
      classes: ['logs'],
      now,
    });
    rmSync(oldLog, { force: true });
    const result = await executePurgeStoragePlan(plan, { now });

    expect(result.totals.deletedCount).toBe(0);
    expect(result.totals.skippedCount).toBe(1);
    expect(result.skipped[0].reason).toContain('disappeared');
  });

  it('revalidates containment and symlink ancestors under the lock before deleting', async () => {
    const now = Date.UTC(2026, 4, 2, 12);
    const layout = getWorkspaceFilesystemLayout('DemoApp-123456789abc');
    const project = path.join(layout.derivedData, 'Project-a');
    const outsideDerivedData = path.join(appDir, 'outside-derived-data');
    const outsideProject = path.join(outsideDerivedData, 'Project-a');
    writeDirectoryWithMtime(project, now - 10 * DAY_MS);
    writeDirectoryWithMtime(outsideProject, now - 10 * DAY_MS);

    const plan = await planPurgeStorage({
      scope: { type: 'all' },
      classes: ['derivedData'],
      now,
      derivedDataExplicit: true,
    });
    rmSync(layout.derivedData, { recursive: true, force: true });
    symlinkSync(outsideDerivedData, layout.derivedData);

    const result = await executePurgeStoragePlan(plan, { now });

    expect(result.totals.deletedCount).toBe(0);
    expect(result.totals.skippedCount).toBe(1);
    expect(result.skipped[0].reason).toContain('symbolic link');
    expect(existsSync(outsideProject)).toBe(true);
  });

  it('uses newest file mtime for non-empty directory retention instead of directory metadata mtime', async () => {
    const now = Date.UTC(2026, 4, 2, 12);
    const layout = getWorkspaceFilesystemLayout('DemoApp-123456789abc');
    const freshDirOldFile = path.join(layout.derivedData, 'FreshDirOldFile');
    writeFileWithMtime(path.join(freshDirOldFile, 'old.txt'), 'old', now - 30 * DAY_MS);
    const freshMtime = new Date(now - 1000);
    utimesSync(freshDirOldFile, freshMtime, freshMtime);

    const plan = await planPurgeStorage({
      scope: { type: 'all' },
      classes: ['derivedData'],
      now,
      olderThanMs: 7 * DAY_MS,
      derivedDataExplicit: true,
    });

    expect(plan.candidates.map((candidate) => path.basename(candidate.path))).toEqual([
      'FreshDirOldFile',
    ]);
    expect(plan.skipped).toHaveLength(0);
  });

  it('uses directory mtime as the older-than fallback for empty directory candidates', async () => {
    const now = Date.UTC(2026, 4, 2, 12);
    const layout = getWorkspaceFilesystemLayout('DemoApp-123456789abc');
    const emptyRecentDir = path.join(layout.derivedData, 'EmptyRecentDir');
    mkdirSync(emptyRecentDir, { recursive: true });
    const freshMtime = new Date(now - 1000);
    utimesSync(emptyRecentDir, freshMtime, freshMtime);

    const plan = await planPurgeStorage({
      scope: { type: 'all' },
      classes: ['derivedData'],
      now,
      olderThanMs: 7 * DAY_MS,
      derivedDataExplicit: true,
    });

    expect(plan.candidates).toHaveLength(0);
    expect(plan.skipped.map((candidate) => path.basename(candidate.path))).toEqual([
      'EmptyRecentDir',
    ]);
  });

  it('uses newest file mtime to keep non-empty directory candidates with fresh files', async () => {
    const now = Date.UTC(2026, 4, 2, 12);
    const layout = getWorkspaceFilesystemLayout('DemoApp-123456789abc');
    const staleDirFreshFile = path.join(layout.derivedData, 'StaleDirFreshFile');
    mkdirSync(staleDirFreshFile, { recursive: true });
    writeFileWithMtime(path.join(staleDirFreshFile, 'fresh.txt'), 'fresh', now - 1000);
    const oldMtime = new Date(now - 30 * DAY_MS);
    utimesSync(staleDirFreshFile, oldMtime, oldMtime);

    const plan = await planPurgeStorage({
      scope: { type: 'all' },
      classes: ['derivedData'],
      now,
      olderThanMs: 7 * DAY_MS,
      derivedDataExplicit: true,
    });

    expect(plan.candidates).toHaveLength(0);
    expect(plan.skipped.map((candidate) => path.basename(candidate.path))).toEqual([
      'StaleDirFreshFile',
    ]);
  });
});
