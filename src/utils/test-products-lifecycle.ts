import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  DEFAULT_TEST_PRODUCTS_MAX_AGE_DAYS,
  DEFAULT_TEST_PRODUCTS_MAX_COUNT,
  getConfig,
} from './config-store.ts';
import { tryAcquireFsLock, type AcquiredFsLock, type TryAcquireFsLockOptions } from './fs-lock.ts';
import { getWorkspaceFilesystemLayout } from './log-paths.ts';
import { log } from './logger.ts';
import { isPidAlive } from './process-liveness.ts';
import { getRuntimeInstanceIfConfigured } from './runtime-instance.ts';
import {
  createDefaultTestProductsPath,
  getManagedTestProductsOwnerPid,
  getTestProductsCompletionMarkerPath,
  isXcodeBuildMCPManagedTestProductsName,
} from './test-products-path.ts';
import { workspaceKeyForRoot } from './workspace-identity.ts';

export const TEST_PRODUCTS_DAY_MS = 24 * 60 * 60 * 1000;
export const TEST_PRODUCTS_MAX_AGE_MS = DEFAULT_TEST_PRODUCTS_MAX_AGE_DAYS * TEST_PRODUCTS_DAY_MS;
export const TEST_PRODUCTS_MAX_COUNT = DEFAULT_TEST_PRODUCTS_MAX_COUNT;

const TEST_PRODUCTS_READER_STATE_DIR = 'test-products-readers';
const TEST_PRODUCTS_LOCK_PURPOSE = 'filesystem-lifecycle';
const TEST_PRODUCTS_LOCK_LEASE_MS = 10 * 60 * 1000;
const TEST_PRODUCTS_LOCK_TIMEOUT_MS = TEST_PRODUCTS_LOCK_LEASE_MS;
const TEST_PRODUCTS_LOCK_RETRY_MS = 50;
const READER_MARKER_PATTERN = /^pid(\d+)_[a-f0-9-]+\.reader$/u;

interface RetainedTestProducts {
  path: string;
  name: string;
  mtimeMs: number;
}

export interface TestProductsProtectionOptions {
  now: number;
  minVisibleMs: number;
  protectedPaths?: ReadonlySet<string>;
  readerStateDir?: string;
  dependencies?: Partial<ManagedTestProductsLifecycleDependencies>;
}

export interface PruneManagedTestProductsOptions extends TestProductsProtectionOptions {
  testProductsDir: string;
  maxAgeMs?: number;
  maxCount?: number;
}

export interface ManagedTestProductsLifecycleOptions {
  workspaceKey?: string;
  maxAgeMs?: number;
  maxCount?: number;
  lockTimeoutMs?: number;
  onLockWait?: () => void;
  dependencies?: Partial<ManagedTestProductsLifecycleDependencies>;
}

export type ManagedTestProductsOutputOptions<T> = ManagedTestProductsLifecycleOptions & {
  isSuccessful?: (result: T) => boolean;
};

export interface ManagedTestProductsFileSystem {
  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<unknown>;
  readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>;
  rename(oldPath: string, newPath: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  stat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean; mtimeMs: number }>;
  writeFile(
    path: string,
    content: string,
    options: { encoding: BufferEncoding; flag?: string; mode?: number },
  ): Promise<void>;
}

export interface ManagedTestProductsLifecycleDependencies {
  fileSystem: ManagedTestProductsFileSystem;
  now(): number;
  randomUUID(): string;
  pid(): number;
  isPidAlive(pid: number): boolean;
  tryAcquireLock(options: TryAcquireFsLockOptions): Promise<AcquiredFsLock | null>;
  sleep(ms: number): Promise<void>;
  createTestProductsPath(toolName: string): string;
  cwd(): string;
}

interface ResolvedManagedTestProductsLifecycle {
  testProductsDir: string;
  readerStateDir: string;
  lockDir: string;
  maxAgeMs: number;
  maxCount: number;
  lockTimeoutMs: number;
  onLockWait?: () => void;
  dependencies: ManagedTestProductsLifecycleDependencies;
}

const defaultFileSystem: ManagedTestProductsFileSystem = {
  mkdir: (filePath, options) => fs.mkdir(filePath, options),
  readdir: (filePath, options) => fs.readdir(filePath, options),
  rename: (oldPath, newPath) => fs.rename(oldPath, newPath),
  rmdir: (filePath) => fs.rmdir(filePath),
  rm: (filePath, options) => fs.rm(filePath, options),
  stat: (filePath) => fs.stat(filePath),
  writeFile: (filePath, content, options) => fs.writeFile(filePath, content, options),
};

const defaultDependencies: ManagedTestProductsLifecycleDependencies = {
  fileSystem: defaultFileSystem,
  now: () => Date.now(),
  randomUUID,
  pid: () => process.pid,
  isPidAlive,
  tryAcquireLock: tryAcquireFsLock,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  createTestProductsPath: createDefaultTestProductsPath,
  cwd: () => process.cwd(),
};

export function getManagedTestProductsReaderStateDir(workspaceKey: string): string {
  return path.join(
    getWorkspaceFilesystemLayout(workspaceKey).state,
    TEST_PRODUCTS_READER_STATE_DIR,
  );
}

function resolveDependencies(
  overrides: Partial<ManagedTestProductsLifecycleDependencies> | undefined,
): ManagedTestProductsLifecycleDependencies {
  return { ...defaultDependencies, ...overrides };
}

function resolveWorkspaceKey(
  workspaceKey: string | undefined,
  dependencies: ManagedTestProductsLifecycleDependencies,
): string {
  return (
    workspaceKey ??
    getRuntimeInstanceIfConfigured()?.workspaceKey ??
    workspaceKeyForRoot(dependencies.cwd())
  );
}

function resolveManagedTestProductsLifecycle(
  options: ManagedTestProductsLifecycleOptions,
): ResolvedManagedTestProductsLifecycle {
  const dependencies = resolveDependencies(options.dependencies);
  const layout = getWorkspaceFilesystemLayout(
    resolveWorkspaceKey(options.workspaceKey, dependencies),
  );
  const config = getConfig();
  const maxAgeMs = options.maxAgeMs ?? config.testProductsMaxAgeDays * TEST_PRODUCTS_DAY_MS;
  const maxCount = options.maxCount ?? config.testProductsMaxCount;
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
    throw new Error('Managed test products maxAgeMs must be a positive finite number');
  }
  if (!Number.isInteger(maxCount) || maxCount < 1) {
    throw new Error('Managed test products maxCount must be a positive integer');
  }
  return {
    testProductsDir: layout.testProducts,
    readerStateDir: getManagedTestProductsReaderStateDir(
      resolveWorkspaceKey(options.workspaceKey, dependencies),
    ),
    lockDir: layout.filesystemLifecycle.lockDir,
    maxAgeMs,
    maxCount,
    lockTimeoutMs: options.lockTimeoutMs ?? TEST_PRODUCTS_LOCK_TIMEOUT_MS,
    onLockWait: options.onLockWait,
    dependencies,
  };
}

async function hasCompletionMarker(
  testProductsPath: string,
  dependencies: ManagedTestProductsLifecycleDependencies,
): Promise<boolean> {
  try {
    return (
      await dependencies.fileSystem.stat(getTestProductsCompletionMarkerPath(testProductsPath))
    ).isFile();
  } catch {
    return false;
  }
}

function readerDirectory(readerStateDir: string, artifactName: string): string {
  return path.join(readerStateDir, artifactName);
}

async function removeReaderDirectoryIfEmpty(
  directory: string,
  dependencies: ManagedTestProductsLifecycleDependencies,
): Promise<void> {
  try {
    await dependencies.fileSystem.rmdir(directory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY') {
      throw error;
    }
  }
}

async function hasLiveReader(
  artifact: RetainedTestProducts,
  readerStateDir: string,
  dependencies: ManagedTestProductsLifecycleDependencies,
): Promise<boolean> {
  const directory = readerDirectory(readerStateDir, artifact.name);
  let entries: Dirent[];
  try {
    entries = await dependencies.fileSystem.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }

  let liveReader = false;
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const match = entry.name.match(READER_MARKER_PATTERN);
    if (!match) {
      continue;
    }
    const pid = Number(match[1]);
    if (Number.isInteger(pid) && pid > 0 && dependencies.isPidAlive(pid)) {
      liveReader = true;
    } else {
      await dependencies.fileSystem.rm(path.join(directory, entry.name), { force: true });
    }
  }
  if (!liveReader) {
    await removeReaderDirectoryIfEmpty(directory, dependencies);
  }
  return liveReader;
}

export async function isProtectedManagedTestProducts(
  artifact: RetainedTestProducts,
  options: TestProductsProtectionOptions,
): Promise<boolean> {
  const dependencies = resolveDependencies(options.dependencies);
  if (options.protectedPaths?.has(path.resolve(artifact.path))) {
    return true;
  }
  if (
    options.readerStateDir &&
    (await hasLiveReader(artifact, options.readerStateDir, dependencies))
  ) {
    return true;
  }
  if (options.now - artifact.mtimeMs < options.minVisibleMs) {
    return true;
  }

  const ownerPid = getManagedTestProductsOwnerPid(artifact.name);
  return Boolean(
    ownerPid &&
      dependencies.isPidAlive(ownerPid) &&
      !(await hasCompletionMarker(artifact.path, dependencies)),
  );
}

export async function pruneManagedTestProductsDirectory(
  options: PruneManagedTestProductsOptions,
): Promise<{ scanned: number; deleted: number }> {
  const dependencies = resolveDependencies(options.dependencies);
  const fileSystem = dependencies.fileSystem;
  const config = getConfig();
  const maxAgeMs = options.maxAgeMs ?? config.testProductsMaxAgeDays * TEST_PRODUCTS_DAY_MS;
  const maxCount = options.maxCount ?? config.testProductsMaxCount;
  const readerStateDir =
    options.readerStateDir ??
    path.join(path.dirname(options.testProductsDir), 'state', TEST_PRODUCTS_READER_STATE_DIR);
  const protectedPaths = new Set(
    [...(options.protectedPaths ?? [])].map((protectedPath) => path.resolve(protectedPath)),
  );

  await fileSystem.mkdir(options.testProductsDir, { recursive: true, mode: 0o700 });
  const entries = await fileSystem.readdir(options.testProductsDir, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isDirectory() && isXcodeBuildMCPManagedTestProductsName(entry.name))
    .map((entry) => ({
      name: entry.name,
      path: path.join(options.testProductsDir, entry.name),
    }));
  const stats = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        return {
          ...candidate,
          mtimeMs: (await fileSystem.stat(candidate.path)).mtimeMs,
        } satisfies RetainedTestProducts;
      } catch {
        return null;
      }
    }),
  );

  const protectedArtifacts: RetainedTestProducts[] = [];
  const retained: RetainedTestProducts[] = [];
  const expired: RetainedTestProducts[] = [];
  for (const artifact of stats) {
    if (!artifact) {
      continue;
    }
    if (
      await isProtectedManagedTestProducts(artifact, {
        now: options.now,
        minVisibleMs: options.minVisibleMs,
        protectedPaths,
        readerStateDir,
        dependencies,
      })
    ) {
      protectedArtifacts.push(artifact);
    } else if (options.now - artifact.mtimeMs > maxAgeMs) {
      expired.push(artifact);
    } else {
      retained.push(artifact);
    }
  }

  const retainedCapacity = Math.max(0, maxCount - protectedArtifacts.length);
  const excessCount = retained.length - retainedCapacity;
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
        await fileSystem.rm(artifact.path, { recursive: true, force: true });
        await fileSystem.rm(getTestProductsCompletionMarkerPath(artifact.path), { force: true });
        await fileSystem.rm(readerDirectory(readerStateDir, artifact.name), {
          recursive: true,
          force: true,
        });
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

async function acquireLifecycleLock(
  lifecycle: ResolvedManagedTestProductsLifecycle,
): Promise<AcquiredFsLock> {
  const { dependencies } = lifecycle;
  const deadline = dependencies.now() + lifecycle.lockTimeoutMs;
  while (true) {
    const lock = await dependencies.tryAcquireLock({
      lockDir: lifecycle.lockDir,
      purpose: TEST_PRODUCTS_LOCK_PURPOSE,
      leaseMs: TEST_PRODUCTS_LOCK_LEASE_MS,
      now: dependencies.now(),
      pid: dependencies.pid(),
    });
    if (lock) {
      return lock;
    }
    lifecycle.onLockWait?.();
    if (dependencies.now() >= deadline) {
      throw new Error(
        `Timed out waiting for managed test products lifecycle lock at ${lifecycle.lockDir}`,
      );
    }
    await dependencies.sleep(TEST_PRODUCTS_LOCK_RETRY_MS);
  }
}

async function withLifecycleLock<T>(
  lifecycle: ResolvedManagedTestProductsLifecycle,
  operation: () => Promise<T>,
): Promise<T> {
  const lock = await acquireLifecycleLock(lifecycle);
  try {
    return await operation();
  } finally {
    await lock.release();
  }
}

async function pruneForLifecycle(
  lifecycle: ResolvedManagedTestProductsLifecycle,
  maxCount: number,
  protectedPaths?: ReadonlySet<string>,
): Promise<void> {
  await pruneManagedTestProductsDirectory({
    testProductsDir: lifecycle.testProductsDir,
    readerStateDir: lifecycle.readerStateDir,
    now: lifecycle.dependencies.now(),
    minVisibleMs: 0,
    maxAgeMs: lifecycle.maxAgeMs,
    maxCount,
    protectedPaths,
    dependencies: lifecycle.dependencies,
  });
}

async function finalizeAfterOperation(
  operationFailed: boolean,
  finalize: () => Promise<void>,
): Promise<void> {
  try {
    await finalize();
  } catch (finalizeError) {
    if (!operationFailed) {
      throw finalizeError;
    }
    const message = finalizeError instanceof Error ? finalizeError.message : String(finalizeError);
    log('warn', `Managed test products finalization failed after operation error: ${message}`);
  }
}

async function markManagedTestProductsCompleted(
  testProductsPath: string,
  dependencies: ManagedTestProductsLifecycleDependencies,
): Promise<void> {
  try {
    if (!(await dependencies.fileSystem.stat(testProductsPath)).isDirectory()) {
      throw new Error(`Managed test products output is not a directory: ${testProductsPath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Managed test products output was not created: ${testProductsPath}`, {
        cause: error,
      });
    }
    throw error;
  }

  const markerPath = getTestProductsCompletionMarkerPath(testProductsPath);
  const tempPath = `${markerPath}.${dependencies.pid()}_${dependencies.randomUUID()}.tmp`;
  await dependencies.fileSystem.writeFile(tempPath, `${dependencies.now()}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  try {
    await dependencies.fileSystem.rename(tempPath, markerPath);
  } catch (error) {
    await dependencies.fileSystem.rm(tempPath, { force: true });
    throw error;
  }
}

async function removeManagedTestProductsOutput(
  testProductsPath: string,
  lifecycle: ResolvedManagedTestProductsLifecycle,
): Promise<void> {
  await lifecycle.dependencies.fileSystem.rm(testProductsPath, {
    recursive: true,
    force: true,
  });
  await lifecycle.dependencies.fileSystem.rm(
    getTestProductsCompletionMarkerPath(testProductsPath),
    { recursive: true, force: true },
  );
}

export async function withManagedTestProductsOutput<T>(
  toolName: string,
  operation: (testProductsPath: string) => Promise<T>,
  options: ManagedTestProductsOutputOptions<T> = {},
): Promise<T> {
  const lifecycle = resolveManagedTestProductsLifecycle(options);
  let testProductsPath = '';
  await withLifecycleLock(lifecycle, async () => {
    await pruneForLifecycle(lifecycle, lifecycle.maxCount - 1);
    testProductsPath = lifecycle.dependencies.createTestProductsPath(toolName);
  });

  let result: T | undefined;
  let operationFailed = false;
  let operationError: unknown;
  try {
    result = await operation(testProductsPath);
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  const operationSucceeded = !operationFailed && (options.isSuccessful?.(result as T) ?? true);

  if (!operationSucceeded) {
    await finalizeAfterOperation(operationFailed, async () => {
      await withLifecycleLock(lifecycle, async () => {
        await removeManagedTestProductsOutput(testProductsPath, lifecycle);
        await pruneForLifecycle(lifecycle, lifecycle.maxCount);
      });
    });
    if (operationFailed) {
      throw operationError;
    }
    return result as T;
  }

  await finalizeAfterOperation(false, async () => {
    await withLifecycleLock(lifecycle, async () => {
      try {
        await markManagedTestProductsCompleted(testProductsPath, lifecycle.dependencies);
      } catch (error) {
        await removeManagedTestProductsOutput(testProductsPath, lifecycle);
        throw error;
      }
      await pruneForLifecycle(
        lifecycle,
        lifecycle.maxCount,
        new Set([path.resolve(testProductsPath)]),
      );
    });
  });

  return result as T;
}

function resolveManagedReaderPath(
  sourcePath: string,
  lifecycle: ResolvedManagedTestProductsLifecycle,
): string | null {
  const managedRoot = path.resolve(lifecycle.testProductsDir);
  const resolvedSourcePath = path.resolve(sourcePath);
  const relative = path.relative(managedRoot, resolvedSourcePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }

  let candidate = resolvedSourcePath;
  while (true) {
    if (
      path.dirname(candidate) === managedRoot &&
      isXcodeBuildMCPManagedTestProductsName(path.basename(candidate))
    ) {
      return candidate;
    }
    if (candidate === managedRoot) {
      return null;
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) {
      return null;
    }
    candidate = parent;
  }
}

export async function withManagedTestProductsReader<T>(
  sourcePath: string,
  operation: () => Promise<T>,
  options: ManagedTestProductsLifecycleOptions = {},
): Promise<T> {
  const lifecycle = resolveManagedTestProductsLifecycle(options);
  const testProductsPath = resolveManagedReaderPath(sourcePath, lifecycle);
  if (!testProductsPath) {
    return operation();
  }

  const resolvedPath = path.resolve(testProductsPath);
  const directory = readerDirectory(lifecycle.readerStateDir, path.basename(resolvedPath));
  const markerPath = path.join(
    directory,
    `pid${lifecycle.dependencies.pid()}_${lifecycle.dependencies.randomUUID()}.reader`,
  );
  await withLifecycleLock(lifecycle, async () => {
    await lifecycle.dependencies.fileSystem.mkdir(directory, { recursive: true, mode: 0o700 });
    await lifecycle.dependencies.fileSystem.writeFile(markerPath, `${resolvedPath}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  });

  let result: T | undefined;
  let operationFailed = false;
  let operationError: unknown;
  try {
    result = await operation();
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  await finalizeAfterOperation(operationFailed, async () => {
    await lifecycle.dependencies.fileSystem.rm(markerPath, { force: true });
    await removeReaderDirectoryIfEmpty(directory, lifecycle.dependencies);
    await withLifecycleLock(lifecycle, async () => {
      await pruneForLifecycle(lifecycle, lifecycle.maxCount);
    });
  });

  if (operationFailed) {
    throw operationError;
  }
  return result as T;
}
