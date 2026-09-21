import type { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { cleanupWorkspaceDaemonFiles, readDaemonRegistryEntry } from '../daemon/daemon-registry.ts';
import { getWorkspaceFilesystemLayout } from './log-paths.ts';
import { listSimulatorLaunchOsLogProtectedPaths } from './log-capture/simulator-launch-oslog-registry.ts';
import {
  reconcileSimulatorLaunchOsLogOrphansForWorkspace,
  stopOwnedSimulatorLaunchOsLogSessions,
  terminateLiveSimulatorLaunchOsLogSessionsSync,
} from './log-capture/simulator-launch-oslog-sessions.ts';
import { log } from './logging/index.ts';
import { getRuntimeInstance, getRuntimeInstanceIfConfigured } from './runtime-instance.ts';
import { tryAcquireFsLock, type AcquiredFsLock } from './fs-lock.ts';
import { isPidAlive } from './process-liveness.ts';
import { getResultBundleCompletionMarkerPath } from './result-bundle-path.ts';
import { pruneManagedTestProductsDirectory } from './test-products-lifecycle.ts';

export const WORKSPACE_FILESYSTEM_LIFECYCLE_LOG_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
export const WORKSPACE_FILESYSTEM_LIFECYCLE_LOG_MAX_FILES = 10_000;
export const WORKSPACE_FILESYSTEM_LIFECYCLE_COOLDOWN_MS = 60 * 60 * 1000;
export const WORKSPACE_FILESYSTEM_LIFECYCLE_SCHEDULE_DELAY_MS = 250;
export const WORKSPACE_FILESYSTEM_LIFECYCLE_MIN_VISIBLE_MS = 60 * 60 * 1000;
export const WORKSPACE_FILESYSTEM_LIFECYCLE_LOCK_LEASE_MS = 10 * 60 * 1000;

const FALLBACK_MARKER_FILE = '.last-cleanup';
const FALLBACK_LOCK_DIR_NAME = '.filesystem-lifecycle.lock';
const runningScheduledSweeps = new Set<string>();
const lastScheduledAtByScope = new Map<string, number>();
const lastScheduledAtByPreKey = new Map<string, number>();
const scheduledSweepTimers = new Set<ReturnType<typeof setTimeout>>();

const HELPER_PID_PATTERN = /(?:^|_)helperpid(\d+)(?:_|\.|$)/g;
const ISO_TIMESTAMP_PATTERN = '\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z';
const SUFFIX_PATTERN = '[a-f0-9]{8}';
const XCODEBUILD_LOG_NAME_PATTERN = new RegExp(
  `^[A-Za-z0-9][A-Za-z0-9_-]*_${ISO_TIMESTAMP_PATTERN}_pid\\d+_${SUFFIX_PATTERN}\\.log$`,
);
const SIMULATOR_LOG_NAME_PATTERN = new RegExp(
  `^.+_${ISO_TIMESTAMP_PATTERN}_(?:helperpid\\d+_)?ownerpid\\d+_${SUFFIX_PATTERN}\\.log$`,
);
const RESULT_BUNDLE_NAME_PATTERN = new RegExp(
  `^[A-Za-z0-9][A-Za-z0-9_-]*_${ISO_TIMESTAMP_PATTERN}_pid\\d+_${SUFFIX_PATTERN}\\.xcresult$`,
);
const RESULT_BUNDLE_OWNER_PID_PATTERN = /_pid(\d+)_/u;
const XCODE_IDE_CALL_TOOL_TRANSIENT_DIR = path.join('xcode-ide', 'call-tool');
const XCODE_IDE_CALL_TOOL_OWNER_DIR_PATTERN = /^ownerpid(\d+)_/u;

export type WorkspaceFilesystemLifecycleTrigger =
  | 'startup'
  | 'artifact-created'
  | 'shutdown'
  | 'force-stop'
  | 'manual';

export interface WorkspaceFilesystemLifecycleOptions {
  workspaceKey?: string;
  trigger: WorkspaceFilesystemLifecycleTrigger;
  logDir?: string;
  markerPath?: string;
  lockDir?: string;
  now?: number;
  maxAgeMs?: number;
  maxFiles?: number;
  cooldownMs?: number;
  force?: boolean;
  minVisibleMs?: number;
  protectedLogPaths?: string[];
  timeoutMs?: number;
  lockPurpose?: string;
  daemonCleanup?: {
    socketPath?: string;
    pid?: number;
    instanceId?: string;
    allowLiveOwner?: boolean;
  };
}

export interface WorkspaceFilesystemLifecycleResult {
  workspaceKey: string;
  trigger: WorkspaceFilesystemLifecycleTrigger;
  logDir: string;
  scanned: number;
  deleted: number;
  stopped: number;
  skippedByCooldown: boolean;
  skippedByLock: boolean;
  errors: string[];
}

interface ResolvedWorkspaceFilesystemLifecycleOptions {
  workspaceKey: string;
  trigger: WorkspaceFilesystemLifecycleTrigger;
  logDir: string;
  markerPath: string;
  lockDir: string;
  resultBundleDir: string | null;
  testProductsDir: string | null;
  now: number;
  maxAgeMs: number;
  maxFiles: number;
  cooldownMs: number;
  force: boolean;
  minVisibleMs: number;
  protectedLogPaths: string[];
  timeoutMs: number;
  lockPurpose: string;
  daemonCleanup?: WorkspaceFilesystemLifecycleOptions['daemonCleanup'];
}

interface RetainedLogFile {
  path: string;
  name: string;
  mtimeMs: number;
}

export interface WorkspaceLifecycleProtectedLogPathsOptions {
  workspaceKey: string;
  protectedLogPaths?: string[];
}

export interface WorkspaceLifecycleRetainedArtifact {
  path: string;
  name: string;
  mtimeMs: number;
}

export type WorkspaceLifecycleLogProtectionReason = 'protectedPath' | 'recent' | 'liveHelperPid';

export interface WorkspaceLifecycleLogProtectionOptions {
  now: number;
  minVisibleMs: number;
  protectedPaths: ReadonlySet<string>;
}

export interface WorkspaceLifecycleResultBundleProtectionOptions {
  now: number;
  minVisibleMs: number;
}

function resolveWorkspaceKey(options: WorkspaceFilesystemLifecycleOptions): string {
  if (options.workspaceKey) {
    return options.workspaceKey;
  }
  const runtimeInstance = getRuntimeInstanceIfConfigured();
  if (runtimeInstance) {
    return runtimeInstance.workspaceKey;
  }
  if (options.logDir) {
    return 'custom-log-dir';
  }
  return getRuntimeInstance().workspaceKey;
}

function resolveOptions(
  options: WorkspaceFilesystemLifecycleOptions,
): ResolvedWorkspaceFilesystemLifecycleOptions {
  const workspaceKey = resolveWorkspaceKey(options);
  const layout = options.logDir ? null : getWorkspaceFilesystemLayout(workspaceKey);
  const logDir = options.logDir ?? layout?.logs;
  if (!logDir) {
    throw new Error('Workspace filesystem lifecycle requires a log directory');
  }

  return {
    workspaceKey,
    trigger: options.trigger,
    logDir,
    markerPath:
      options.markerPath ??
      layout?.filesystemLifecycle.markerPath ??
      path.join(logDir, FALLBACK_MARKER_FILE),
    lockDir:
      options.lockDir ??
      layout?.filesystemLifecycle.lockDir ??
      path.join(logDir, FALLBACK_LOCK_DIR_NAME),
    resultBundleDir: layout?.resultBundles ?? null,
    testProductsDir: layout?.testProducts ?? null,
    now: options.now ?? Date.now(),
    maxAgeMs: options.maxAgeMs ?? WORKSPACE_FILESYSTEM_LIFECYCLE_LOG_MAX_AGE_MS,
    maxFiles: options.maxFiles ?? WORKSPACE_FILESYSTEM_LIFECYCLE_LOG_MAX_FILES,
    cooldownMs: options.cooldownMs ?? WORKSPACE_FILESYSTEM_LIFECYCLE_COOLDOWN_MS,
    force: options.force ?? false,
    minVisibleMs: options.minVisibleMs ?? WORKSPACE_FILESYSTEM_LIFECYCLE_MIN_VISIBLE_MS,
    protectedLogPaths: options.protectedLogPaths ?? [],
    timeoutMs: options.timeoutMs ?? 1000,
    lockPurpose: options.lockPurpose ?? 'filesystem-lifecycle',
    daemonCleanup: options.daemonCleanup,
  };
}

async function shouldSkipForCooldown(
  markerPath: string,
  now: number,
  cooldownMs: number,
): Promise<boolean> {
  try {
    const markerStat = await fs.stat(markerPath);
    return now - markerStat.mtimeMs < cooldownMs;
  } catch {
    return false;
  }
}

async function touchCleanupMarker(markerPath: string, now: number): Promise<void> {
  await fs.mkdir(path.dirname(markerPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(markerPath, String(now));
  const markerDate = new Date(now);
  await fs.utimes(markerPath, markerDate, markerDate);
}

function hasLiveHelperPidInName(fileName: string): boolean {
  for (const match of fileName.matchAll(HELPER_PID_PATTERN)) {
    const pid = Number(match[1]);
    if (Number.isInteger(pid) && pid > 0 && isPidAlive(pid)) {
      return true;
    }
  }
  return false;
}

export function isXcodeBuildMCPManagedLogName(fileName: string): boolean {
  if (fileName === 'daemon.log') {
    return true;
  }
  return XCODEBUILD_LOG_NAME_PATTERN.test(fileName) || SIMULATOR_LOG_NAME_PATTERN.test(fileName);
}

export function isXcodeBuildMCPManagedResultBundleName(fileName: string): boolean {
  return RESULT_BUNDLE_NAME_PATTERN.test(fileName);
}

export function getManagedResultBundleOwnerPid(fileName: string): number | null {
  const pid = Number(fileName.match(RESULT_BUNDLE_OWNER_PID_PATTERN)?.[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

async function deleteFile(filePath: string): Promise<boolean> {
  try {
    await fs.unlink(filePath);
    return true;
  } catch {
    return false;
  }
}

export function getWorkspaceLifecycleProtectedLogReason(
  file: WorkspaceLifecycleRetainedArtifact,
  options: WorkspaceLifecycleLogProtectionOptions,
): WorkspaceLifecycleLogProtectionReason | null {
  if (options.protectedPaths.has(file.path)) {
    return 'protectedPath';
  }
  if (options.now - file.mtimeMs < options.minVisibleMs) {
    return 'recent';
  }
  if (hasLiveHelperPidInName(file.name)) {
    return 'liveHelperPid';
  }
  return null;
}

function isProtectedLogFile(
  file: RetainedLogFile,
  options: ResolvedWorkspaceFilesystemLifecycleOptions,
  protectedPaths: Set<string>,
): boolean {
  return (
    getWorkspaceLifecycleProtectedLogReason(file, {
      now: options.now,
      minVisibleMs: options.minVisibleMs,
      protectedPaths,
    }) !== null
  );
}

export async function collectWorkspaceLifecycleProtectedLogPaths(
  options: WorkspaceLifecycleProtectedLogPathsOptions,
): Promise<Set<string>> {
  const protectedPaths = new Set(options.protectedLogPaths ?? []);

  try {
    for (const osLogPath of await listSimulatorLaunchOsLogProtectedPaths({
      workspaceKey: options.workspaceKey,
    })) {
      protectedPaths.add(osLogPath);
    }
  } catch {
    // ignore
  }

  const daemonEntry = readDaemonRegistryEntry(options.workspaceKey);
  if (daemonEntry?.logPath && isPidAlive(daemonEntry.pid)) {
    protectedPaths.add(daemonEntry.logPath);
  }

  return protectedPaths;
}

async function collectProtectedLogPaths(
  options: ResolvedWorkspaceFilesystemLifecycleOptions,
): Promise<Set<string>> {
  return collectWorkspaceLifecycleProtectedLogPaths({
    workspaceKey: options.workspaceKey,
    protectedLogPaths: options.protectedLogPaths,
  });
}

async function pruneKnownLogDirectory(
  options: ResolvedWorkspaceFilesystemLifecycleOptions,
  protectedPaths: Set<string>,
): Promise<{ scanned: number; deleted: number }> {
  await fs.mkdir(options.logDir, { recursive: true, mode: 0o700 });
  const entries = await fs.readdir(options.logDir, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isFile() && isXcodeBuildMCPManagedLogName(entry.name))
    .map((entry) => ({ name: entry.name, path: path.join(options.logDir, entry.name) }));

  const stats = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        const stat = await fs.stat(candidate.path);
        return { ...candidate, mtimeMs: stat.mtimeMs } satisfies RetainedLogFile;
      } catch {
        return null;
      }
    }),
  );

  const retainedDeletable: RetainedLogFile[] = [];
  const expired: RetainedLogFile[] = [];
  let scanned = 0;

  for (const file of stats) {
    if (!file) continue;
    scanned += 1;
    if (isProtectedLogFile(file, options, protectedPaths)) {
      continue;
    }
    if (options.now - file.mtimeMs > options.maxAgeMs) {
      expired.push(file);
      continue;
    }
    retainedDeletable.push(file);
  }

  const excessFileCount = retainedDeletable.length - options.maxFiles;
  const overflow =
    excessFileCount > 0
      ? retainedDeletable
          .slice()
          .sort((left, right) => left.mtimeMs - right.mtimeMs)
          .slice(0, excessFileCount)
      : [];

  const deletions = await Promise.all(
    [...expired, ...overflow].map((file) => deleteFile(file.path)),
  );
  const deleted = deletions.reduce((count, success) => count + (success ? 1 : 0), 0);

  return { scanned, deleted };
}

async function hasResultBundleCompletionMarker(bundlePath: string): Promise<boolean> {
  try {
    const markerStat = await fs.stat(getResultBundleCompletionMarkerPath(bundlePath));
    return markerStat.isFile();
  } catch {
    return false;
  }
}

export async function isWorkspaceLifecycleProtectedResultBundleDirectory(
  bundle: WorkspaceLifecycleRetainedArtifact,
  options: WorkspaceLifecycleResultBundleProtectionOptions,
): Promise<boolean> {
  if (options.now - bundle.mtimeMs < options.minVisibleMs) {
    return true;
  }

  const ownerPid = getManagedResultBundleOwnerPid(bundle.name);
  if (ownerPid && isPidAlive(ownerPid) && !(await hasResultBundleCompletionMarker(bundle.path))) {
    return true;
  }

  return false;
}

async function isProtectedResultBundleDirectory(
  bundle: RetainedLogFile,
  options: ResolvedWorkspaceFilesystemLifecycleOptions,
): Promise<boolean> {
  return isWorkspaceLifecycleProtectedResultBundleDirectory(bundle, {
    now: options.now,
    minVisibleMs: options.minVisibleMs,
  });
}

async function pruneKnownResultBundleDirectory(
  options: ResolvedWorkspaceFilesystemLifecycleOptions,
): Promise<{ scanned: number; deleted: number }> {
  if (!options.resultBundleDir) {
    return { scanned: 0, deleted: 0 };
  }

  const resultBundleDir = options.resultBundleDir;
  await fs.mkdir(resultBundleDir, { recursive: true, mode: 0o700 });
  const entries = await fs.readdir(resultBundleDir, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isDirectory() && isXcodeBuildMCPManagedResultBundleName(entry.name))
    .map((entry) => ({ name: entry.name, path: path.join(resultBundleDir, entry.name) }));

  const stats = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        const stat = await fs.stat(candidate.path);
        return { ...candidate, mtimeMs: stat.mtimeMs } satisfies RetainedLogFile;
      } catch {
        return null;
      }
    }),
  );

  const retainedDeletable: RetainedLogFile[] = [];
  const expired: RetainedLogFile[] = [];
  let scanned = 0;

  for (const bundle of stats) {
    if (!bundle) continue;
    scanned += 1;
    if (await isProtectedResultBundleDirectory(bundle, options)) {
      continue;
    }
    if (options.now - bundle.mtimeMs > options.maxAgeMs) {
      expired.push(bundle);
      continue;
    }
    retainedDeletable.push(bundle);
  }

  const excessFileCount = retainedDeletable.length - options.maxFiles;
  const overflow =
    excessFileCount > 0
      ? retainedDeletable
          .slice()
          .sort((left, right) => left.mtimeMs - right.mtimeMs)
          .slice(0, excessFileCount)
      : [];

  const deletions = await Promise.all(
    [...expired, ...overflow].map(async (bundle) => {
      try {
        await fs.rm(bundle.path, { recursive: true, force: true });
        await deleteFile(getResultBundleCompletionMarkerPath(bundle.path));
        return true;
      } catch {
        return false;
      }
    }),
  );
  const deleted = deletions.reduce((count, success) => count + (success ? 1 : 0), 0);

  return { scanned, deleted };
}

function zeroResult(
  options: ResolvedWorkspaceFilesystemLifecycleOptions,
  skippedByCooldown: boolean,
  skippedByLock: boolean,
  stopped = 0,
  errors: string[] = [],
): WorkspaceFilesystemLifecycleResult {
  return {
    workspaceKey: options.workspaceKey,
    trigger: options.trigger,
    logDir: options.logDir,
    scanned: 0,
    deleted: 0,
    stopped,
    skippedByCooldown,
    skippedByLock,
    errors,
  };
}

async function runStartupReconciliation(
  options: ResolvedWorkspaceFilesystemLifecycleOptions,
  errors: string[],
): Promise<number> {
  if (options.trigger !== 'startup') {
    return 0;
  }
  try {
    const reconciliation = await reconcileSimulatorLaunchOsLogOrphansForWorkspace(
      options.workspaceKey,
      options.timeoutMs,
    );
    errors.push(...reconciliation.errors);
    return reconciliation.stoppedSessionCount;
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    return 0;
  }
}

function runDaemonCleanup(options: ResolvedWorkspaceFilesystemLifecycleOptions): void {
  if (!options.daemonCleanup) {
    return;
  }
  cleanupWorkspaceDaemonFiles(options.workspaceKey, options.daemonCleanup);
}

export function xcodeIdeCallToolTransientRoot(workspaceKey: string): string {
  return path.join(
    getWorkspaceFilesystemLayout(workspaceKey).state,
    XCODE_IDE_CALL_TOOL_TRANSIENT_DIR,
  );
}

export function getXcodeIdeCallToolTransientOwnerPid(directoryName: string): number | null {
  const ownerPid = Number(directoryName.match(XCODE_IDE_CALL_TOOL_OWNER_DIR_PATTERN)?.[1]);
  return Number.isInteger(ownerPid) && ownerPid > 0 ? ownerPid : null;
}

export function isStaleXcodeIdeCallToolTransientDirectoryName(directoryName: string): boolean {
  const ownerPid = getXcodeIdeCallToolTransientOwnerPid(directoryName);
  return ownerPid !== null && !isPidAlive(ownerPid);
}

async function cleanupXcodeIdeCallToolTransientArtifacts(
  workspaceKey: string,
  errors: string[],
  options: { includeCurrentOwner: boolean },
): Promise<void> {
  const root = xcodeIdeCallToolTransientRoot(workspaceKey);
  const runtimeInstance = getRuntimeInstanceIfConfigured();
  const currentOwnerDir = runtimeInstance
    ? `ownerpid${runtimeInstance.pid}_${runtimeInstance.instanceId}`
    : null;

  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    errors.push(error instanceof Error ? error.message : String(error));
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const ownedByCurrentRuntime = options.includeCurrentOwner && currentOwnerDir === entry.name;
    const ownedByDeadRuntime = isStaleXcodeIdeCallToolTransientDirectoryName(entry.name);
    if (!ownedByCurrentRuntime && !ownedByDeadRuntime) {
      continue;
    }
    try {
      await fs.rm(path.join(root, entry.name), { recursive: true, force: true });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
}

function cleanupXcodeIdeCallToolTransientArtifactsSync(): {
  attemptedCount: number;
  errors: string[];
} {
  const runtimeInstance = getRuntimeInstanceIfConfigured();
  if (!runtimeInstance) {
    return { attemptedCount: 0, errors: [] };
  }
  const ownerDir = `ownerpid${runtimeInstance.pid}_${runtimeInstance.instanceId}`;
  const ownerPath = path.join(
    xcodeIdeCallToolTransientRoot(runtimeInstance.workspaceKey),
    ownerDir,
  );
  try {
    fsSync.rmSync(ownerPath, { recursive: true, force: true });
    return { attemptedCount: 1, errors: [] };
  } catch (error) {
    return {
      attemptedCount: 1,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

export async function runWorkspaceFilesystemLifecycleSweep(
  options: WorkspaceFilesystemLifecycleOptions,
): Promise<WorkspaceFilesystemLifecycleResult> {
  const resolved = resolveOptions(options);
  const errors: string[] = [];
  const stopped = await runStartupReconciliation(resolved, errors);
  if (resolved.trigger === 'startup') {
    await cleanupXcodeIdeCallToolTransientArtifacts(resolved.workspaceKey, errors, {
      includeCurrentOwner: false,
    });
  }

  if (
    !resolved.force &&
    (await shouldSkipForCooldown(resolved.markerPath, resolved.now, resolved.cooldownMs))
  ) {
    return zeroResult(resolved, true, false, stopped, errors);
  }

  let lock: AcquiredFsLock | null;
  try {
    lock = await tryAcquireFsLock({
      lockDir: resolved.lockDir,
      purpose: resolved.lockPurpose,
      leaseMs: WORKSPACE_FILESYSTEM_LIFECYCLE_LOCK_LEASE_MS,
      now: resolved.now,
    });
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    return zeroResult(resolved, false, true, stopped, errors);
  }
  if (!lock) {
    return zeroResult(resolved, false, true, stopped, errors);
  }

  try {
    if (
      !resolved.force &&
      (await shouldSkipForCooldown(resolved.markerPath, resolved.now, resolved.cooldownMs))
    ) {
      return zeroResult(resolved, true, false, stopped, errors);
    }

    runDaemonCleanup(resolved);
    const protectedPaths = await collectProtectedLogPaths(resolved);
    const logPrune = await pruneKnownLogDirectory(resolved, protectedPaths);
    const resultBundlePrune = await pruneKnownResultBundleDirectory(resolved);
    const testProductsPrune = resolved.testProductsDir
      ? await pruneManagedTestProductsDirectory({
          testProductsDir: resolved.testProductsDir,
          now: resolved.now,
          minVisibleMs: resolved.minVisibleMs,
        })
      : { scanned: 0, deleted: 0 };
    await touchCleanupMarker(resolved.markerPath, resolved.now);

    return {
      workspaceKey: resolved.workspaceKey,
      trigger: resolved.trigger,
      logDir: resolved.logDir,
      scanned: logPrune.scanned + resultBundlePrune.scanned + testProductsPrune.scanned,
      deleted: logPrune.deleted + resultBundlePrune.deleted + testProductsPrune.deleted,
      stopped,
      skippedByCooldown: false,
      skippedByLock: false,
      errors,
    };
  } finally {
    await lock.release();
  }
}

function buildSchedulePreKey(options: WorkspaceFilesystemLifecycleOptions): string | null {
  if (options.workspaceKey) {
    return `workspace:${options.workspaceKey}`;
  }
  if (options.logDir) {
    return `logDir:${options.logDir}`;
  }
  return null;
}

export function scheduleWorkspaceFilesystemLifecycleSweep(
  options: WorkspaceFilesystemLifecycleOptions,
): void {
  const preKey = buildSchedulePreKey(options);
  if (preKey !== null && !options.force) {
    const lastAt = lastScheduledAtByPreKey.get(preKey);
    if (
      lastAt !== undefined &&
      (options.now ?? Date.now()) - lastAt < WORKSPACE_FILESYSTEM_LIFECYCLE_COOLDOWN_MS
    ) {
      return;
    }
  }

  const resolved = resolveOptions(options);
  const scheduleKey = `${resolved.workspaceKey}:${resolved.logDir}`;
  const lastScheduledAt = lastScheduledAtByScope.get(scheduleKey);

  if (
    !resolved.force &&
    lastScheduledAt !== undefined &&
    resolved.now - lastScheduledAt < resolved.cooldownMs
  ) {
    return;
  }
  if (runningScheduledSweeps.has(scheduleKey)) {
    return;
  }

  runningScheduledSweeps.add(scheduleKey);

  const timer = setTimeout(() => {
    void runWorkspaceFilesystemLifecycleSweep(resolved)
      .then((result) => {
        if (!result.skippedByCooldown && !result.skippedByLock) {
          const completedAt = Date.now();
          lastScheduledAtByScope.set(scheduleKey, completedAt);
          if (preKey !== null) {
            lastScheduledAtByPreKey.set(preKey, completedAt);
          }
          if (result.deleted > 0) {
            log('info', `[FilesystemLifecycle] Deleted ${result.deleted} old filesystem artifacts`);
          }
        }
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        log('warn', `[FilesystemLifecycle] Cleanup failed: ${message}`);
      })
      .finally(() => {
        scheduledSweepTimers.delete(timer);
        runningScheduledSweeps.delete(scheduleKey);
      });
  }, WORKSPACE_FILESYSTEM_LIFECYCLE_SCHEDULE_DELAY_MS);
  scheduledSweepTimers.add(timer);
  timer.unref?.();
}

export async function cleanupOwnedWorkspaceFilesystemArtifacts(
  options: Omit<WorkspaceFilesystemLifecycleOptions, 'trigger'> & {
    trigger?: 'shutdown' | 'force-stop';
  } = {},
): Promise<WorkspaceFilesystemLifecycleResult> {
  const runtimeInstance = getRuntimeInstanceIfConfigured();
  const workspaceKey = options.workspaceKey ?? runtimeInstance?.workspaceKey;
  if (!workspaceKey) {
    return {
      workspaceKey: 'unconfigured',
      trigger: options.trigger ?? 'shutdown',
      logDir: '',
      scanned: 0,
      deleted: 0,
      stopped: 0,
      skippedByCooldown: false,
      skippedByLock: false,
      errors: [],
    };
  }

  const stopResult = await stopOwnedSimulatorLaunchOsLogSessions(options.timeoutMs ?? 1000);
  if (options.daemonCleanup) {
    cleanupWorkspaceDaemonFiles(workspaceKey, options.daemonCleanup);
  }
  const errors = [...stopResult.errors];
  await cleanupXcodeIdeCallToolTransientArtifacts(workspaceKey, errors, {
    includeCurrentOwner: true,
  });

  return {
    workspaceKey,
    trigger: options.trigger ?? 'shutdown',
    logDir: getWorkspaceFilesystemLayout(workspaceKey).logs,
    scanned: 0,
    deleted: 0,
    stopped: stopResult.stoppedSessionCount,
    skippedByCooldown: false,
    skippedByLock: false,
    errors,
  };
}

export function terminateOwnedWorkspaceFilesystemArtifactsSync(): {
  attemptedCount: number;
  errorCount: number;
  errors: string[];
} {
  const simulatorCleanup = terminateLiveSimulatorLaunchOsLogSessionsSync();
  const transientArtifactCleanup = cleanupXcodeIdeCallToolTransientArtifactsSync();
  const errors = [...simulatorCleanup.errors, ...transientArtifactCleanup.errors];
  return {
    attemptedCount: simulatorCleanup.attemptedCount + transientArtifactCleanup.attemptedCount,
    errorCount: simulatorCleanup.errorCount + transientArtifactCleanup.errors.length,
    errors,
  };
}

export function resetWorkspaceFilesystemLifecycleStateForTests(): void {
  for (const timer of scheduledSweepTimers) {
    clearTimeout(timer);
  }
  scheduledSweepTimers.clear();
  runningScheduledSweeps.clear();
  lastScheduledAtByScope.clear();
  lastScheduledAtByPreKey.clear();
}

export function scheduleArtifactCreatedSweep(logDir: { path: string; isOverride: boolean }): void {
  if (logDir.isOverride) {
    scheduleWorkspaceFilesystemLifecycleSweep({
      trigger: 'artifact-created',
      logDir: logDir.path,
    });
    return;
  }
  scheduleWorkspaceFilesystemLifecycleSweep({
    trigger: 'artifact-created',
    workspaceKey: getRuntimeInstance().workspaceKey,
  });
}
