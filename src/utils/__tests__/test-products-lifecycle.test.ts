import {
  type Dirent,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import * as fileSystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMockFileSystemExecutor } from '../../test-utils/mock-executors.ts';
import {
  TEST_PRODUCTS_MAX_AGE_MS,
  pruneManagedTestProductsDirectory,
  type ManagedTestProductsFileSystem,
  type ManagedTestProductsLifecycleDependencies,
  withManagedTestProductsOutput,
  withManagedTestProductsReader,
} from '../test-products-lifecycle.ts';
import {
  getTestProductsCompletionMarkerPath,
  isXcodeBuildMCPManagedTestProductsName,
} from '../test-products-path.ts';
import {
  getWorkspaceFilesystemLayout,
  setXcodeBuildMCPAppDirOverrideForTests,
} from '../log-paths.ts';
import { setRuntimeInstanceForTests } from '../runtime-instance.ts';
import { tryAcquireFsLock, type AcquiredFsLock } from '../fs-lock.ts';

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

function createTestFileSystem(): ManagedTestProductsFileSystem {
  const mkdir: ManagedTestProductsFileSystem['mkdir'] = async (filePath, options) => {
    await fileSystem.mkdir(filePath, options);
  };
  const readdir: ManagedTestProductsFileSystem['readdir'] = (filePath, options) =>
    fileSystem.readdir(filePath, options);
  const rm: ManagedTestProductsFileSystem['rm'] = (filePath, options) =>
    fileSystem.rm(filePath, options);
  const stat: ManagedTestProductsFileSystem['stat'] = (filePath) => fileSystem.stat(filePath);
  const writeFile: ManagedTestProductsFileSystem['writeFile'] = (filePath, content, options) =>
    fileSystem.writeFile(filePath, content, options);
  const executor = createMockFileSystemExecutor({
    mkdir: async (filePath, options) => {
      await mkdir(filePath, options);
    },
    readdir,
    rm,
    stat,
    writeFile: (filePath, content, encoding) => fileSystem.writeFile(filePath, content, encoding),
  });
  return {
    mkdir: executor.mkdir,
    readdir: (filePath, options) => executor.readdir(filePath, options) as Promise<Dirent[]>,
    rename: (oldPath, newPath) => fileSystem.rename(oldPath, newPath),
    rmdir: (filePath) => fileSystem.rmdir(filePath),
    rm: executor.rm,
    stat,
    writeFile,
  };
}

function acquiredLock(): AcquiredFsLock {
  return {
    owner: {
      token: 'test-lock',
      pid: process.pid,
      purpose: 'filesystem-lifecycle',
      acquiredAtMs: 0,
      expiresAtMs: 10 * 60 * 1000,
    },
    release: async () => undefined,
  };
}

describe('test products lifecycle', () => {
  let root: string;
  let dependencies: Partial<ManagedTestProductsLifecycleDependencies>;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'xcodebuildmcp-test-products-lifecycle-'));
    setXcodeBuildMCPAppDirOverrideForTests(root);
    setRuntimeInstanceForTests({
      instanceId: 'test-products-lifecycle',
      pid: process.pid,
      workspaceKey: 'workspace-a',
    });
    dependencies = { fileSystem: createTestFileSystem() };
  });

  afterEach(async () => {
    setRuntimeInstanceForTests(null);
    setXcodeBuildMCPAppDirOverrideForTests(null);
    await fileSystem.rm(root, { recursive: true, force: true });
  });

  it('prunes managed products after one day while preserving caller-owned paths', async () => {
    const now = Date.UTC(2026, 4, 6, 12);
    const oldManaged = path.join(root, managedName('old'));
    const recentManaged = path.join(root, managedName('recent'));
    const callerOwned = path.join(root, 'caller-provided.xctestproducts');
    const externalCallerOwned = path.join(
      path.dirname(root),
      `${path.basename(root)}-external-caller.xctestproducts`,
    );
    writeTestProducts(oldManaged, now - TEST_PRODUCTS_MAX_AGE_MS - 1, true);
    writeTestProducts(recentManaged, now - DAY_MS + 1, true);
    writeTestProducts(callerOwned, now - 10 * DAY_MS, true);
    writeTestProducts(externalCallerOwned, now - 10 * DAY_MS, true);

    const result = await pruneManagedTestProductsDirectory({
      testProductsDir: root,
      now,
      minVisibleMs: 0,
      dependencies,
    });

    expect(result).toEqual({ scanned: 2, deleted: 1 });
    expect(existsSync(oldManaged)).toBe(false);
    expect(existsSync(recentManaged)).toBe(true);
    expect(existsSync(callerOwned)).toBe(true);
    expect(existsSync(externalCallerOwned)).toBe(true);
    await fileSystem.rm(externalCallerOwned, { recursive: true, force: true });
  });

  it('protects live in-progress products until their completion marker exists', async () => {
    const now = Date.UTC(2026, 4, 6, 12);
    const live = path.join(root, managedName('live', process.pid));
    writeTestProducts(live, now - 4 * DAY_MS);

    expect(isXcodeBuildMCPManagedTestProductsName(path.basename(live))).toBe(true);
    expect(
      await pruneManagedTestProductsDirectory({
        testProductsDir: root,
        now,
        minVisibleMs: 0,
        dependencies,
      }),
    ).toEqual({ scanned: 1, deleted: 0 });
    expect(existsSync(live)).toBe(true);

    writeFileSync(getTestProductsCompletionMarkerPath(live), 'completed');
    expect(
      await pruneManagedTestProductsDirectory({
        testProductsDir: root,
        now,
        minVisibleMs: 0,
        dependencies,
      }),
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
      dependencies,
    });

    expect(result).toEqual({ scanned: 3, deleted: 1 });
    expect(existsSync(oldest)).toBe(false);
    expect(existsSync(middle)).toBe(true);
    expect(existsSync(newest)).toBe(true);
  });

  it('prunes before and after managed output production while preserving the new bundle', async () => {
    const now = Date.now();
    const layout = getWorkspaceFilesystemLayout('workspace-a');
    const oldest = path.join(layout.testProducts, managedName('oldest'));
    const middle = path.join(layout.testProducts, managedName('middle'));
    const newest = path.join(layout.testProducts, managedName('newest'));
    writeTestProducts(oldest, now - 3 * DAY_MS, true);
    writeTestProducts(middle, now - 2 * DAY_MS, true);
    writeTestProducts(newest, now - DAY_MS, true);

    let resolveOperationLock!: (lock: AcquiredFsLock) => void;
    const operationLockAcquired = new Promise<AcquiredFsLock>((resolve) => {
      resolveOperationLock = resolve;
    });
    let resolveLockWait!: () => void;
    const lockWaitObserved = new Promise<void>((resolve) => {
      resolveLockWait = resolve;
    });
    const outputPromise = withManagedTestProductsOutput(
      'build_sim',
      async (testProductsPath) => {
        mkdirSync(testProductsPath);
        writeFileSync(path.join(testProductsPath, 'Tests.xctestrun'), 'stub');
        const lock = await tryAcquireFsLock({
          lockDir: layout.filesystemLifecycle.lockDir,
          purpose: 'filesystem-lifecycle',
          leaseMs: 10 * 60 * 1000,
        });
        if (!lock) throw new Error('Unable to acquire test lifecycle lock');
        resolveOperationLock(lock);
        return testProductsPath;
      },
      {
        workspaceKey: 'workspace-a',
        maxAgeMs: 10 * DAY_MS,
        maxCount: 2,
        onLockWait: resolveLockWait,
        dependencies: { ...dependencies, now: () => now },
      },
    );
    const operationLock = await operationLockAcquired;
    try {
      await lockWaitObserved;
      const pendingOutputPath = readdirSync(layout.testProducts)
        .filter(isXcodeBuildMCPManagedTestProductsName)
        .map((name) => path.join(layout.testProducts, name))
        .find((candidate) => !existsSync(getTestProductsCompletionMarkerPath(candidate)));
      expect(pendingOutputPath).toBeDefined();
    } finally {
      await operationLock.release();
    }
    const outputPath = await outputPromise;

    const retained = readdirSync(layout.testProducts).filter(
      isXcodeBuildMCPManagedTestProductsName,
    );
    expect(retained).toHaveLength(2);
    expect(existsSync(outputPath)).toBe(true);
    expect(existsSync(getTestProductsCompletionMarkerPath(outputPath))).toBe(true);
    expect(existsSync(newest)).toBe(true);
    expect(existsSync(middle)).toBe(false);
    expect(existsSync(oldest)).toBe(false);
  });

  it('protects a managed bundle while its nested xctestrun file is active', async () => {
    const now = Date.now();
    const layout = getWorkspaceFilesystemLayout('workspace-a');
    const testProductsPath = path.join(layout.testProducts, managedName('prepared'));
    writeTestProducts(testProductsPath, now - 2 * DAY_MS, true);

    await withManagedTestProductsReader(
      path.join(testProductsPath, 'Tests.xctestrun'),
      async () => {
        expect(
          await pruneManagedTestProductsDirectory({
            testProductsDir: layout.testProducts,
            now,
            minVisibleMs: 0,
            maxAgeMs: 10 * DAY_MS,
            maxCount: 0,
            dependencies,
          }),
        ).toEqual({ scanned: 1, deleted: 0 });
      },
      {
        workspaceKey: 'workspace-a',
        maxAgeMs: 10 * DAY_MS,
        maxCount: 3,
        dependencies: { ...dependencies, now: () => now },
      },
    );

    expect(existsSync(testProductsPath)).toBe(true);
    expect(
      await pruneManagedTestProductsDirectory({
        testProductsDir: layout.testProducts,
        now,
        minVisibleMs: 0,
        maxAgeMs: 10 * DAY_MS,
        maxCount: 0,
        dependencies,
      }),
    ).toEqual({ scanned: 1, deleted: 1 });
  });

  it('removes a managed bundle when its completion marker cannot be published', async () => {
    let outputPath = '';
    await expect(
      withManagedTestProductsOutput(
        'build_sim',
        async (testProductsPath) => {
          outputPath = testProductsPath;
          mkdirSync(testProductsPath);
          mkdirSync(getTestProductsCompletionMarkerPath(testProductsPath));
        },
        { dependencies },
      ),
    ).rejects.toThrow();

    expect(existsSync(outputPath)).toBe(false);
    expect(existsSync(getTestProductsCompletionMarkerPath(outputPath))).toBe(false);
  });

  it('fails loudly when a successful operation does not create its managed output', async () => {
    await expect(
      withManagedTestProductsOutput('build_sim', async () => 'success', { dependencies }),
    ).rejects.toThrow('Managed test products output was not created');
  });

  it('preserves an operation error when managed-output finalization also fails', async () => {
    const operationError = new Error('xcodebuild failed');
    const injectedFileSystem = dependencies.fileSystem!;
    const finalizationFailureFileSystem: ManagedTestProductsFileSystem = {
      ...injectedFileSystem,
      rm: async () => {
        throw new Error('cleanup failed');
      },
    };

    await expect(
      withManagedTestProductsOutput(
        'build_sim',
        async () => {
          throw operationError;
        },
        {
          dependencies: { ...dependencies, fileSystem: finalizationFailureFileSystem },
        },
      ),
    ).rejects.toBe(operationError);
  });

  it('retries lifecycle lock acquisition until its timeout is exhausted', async () => {
    let attempts = 0;
    let now = 0;

    await expect(
      withManagedTestProductsOutput('build_sim', async () => undefined, {
        lockTimeoutMs: 2,
        dependencies: {
          ...dependencies,
          now: () => now,
          tryAcquireLock: async () => {
            attempts += 1;
            now += 1;
            return null;
          },
          sleep: async () => undefined,
        },
      }),
    ).rejects.toThrow('Timed out waiting for managed test products lifecycle lock');

    expect(attempts).toBe(2);
  });

  it('uses fresh time when pruning after managed output production', async () => {
    let now = Date.UTC(2026, 4, 6, 12);
    const layout = getWorkspaceFilesystemLayout('workspace-a');
    const crossingAgeLimit = path.join(layout.testProducts, managedName('crossing-age-limit'));
    writeTestProducts(crossingAgeLimit, now - DAY_MS + 1, true);

    await withManagedTestProductsOutput(
      'build_sim',
      async (testProductsPath) => {
        mkdirSync(testProductsPath);
        writeFileSync(path.join(testProductsPath, 'Tests.xctestrun'), 'stub');
        now += 2;
      },
      {
        workspaceKey: 'workspace-a',
        maxAgeMs: DAY_MS,
        maxCount: 3,
        dependencies: { ...dependencies, now: () => now },
      },
    );

    expect(existsSync(crossingAgeLimit)).toBe(false);
  });

  it('removes its reader marker before a release-time lock timeout', async () => {
    const now = Date.now();
    const layout = getWorkspaceFilesystemLayout('workspace-a');
    const testProductsPath = path.join(layout.testProducts, managedName('prepared'));
    const readerDirectory = path.join(
      layout.state,
      'test-products-readers',
      path.basename(testProductsPath),
    );
    writeTestProducts(testProductsPath, now, true);
    const operationError = new Error('test operation failed');
    let lockAttempts = 0;

    await expect(
      withManagedTestProductsReader(
        testProductsPath,
        async () => {
          throw operationError;
        },
        {
          workspaceKey: 'workspace-a',
          lockTimeoutMs: 0,
          dependencies: {
            ...dependencies,
            now: () => now,
            randomUUID: () => 'abcdef12',
            tryAcquireLock: async () => {
              lockAttempts += 1;
              return lockAttempts === 1 ? acquiredLock() : null;
            },
          },
        },
      ),
    ).rejects.toBe(operationError);

    expect(lockAttempts).toBe(2);
    expect(existsSync(readerDirectory)).toBe(false);
  });

  it('cleans dead reader markers before pruning', async () => {
    const now = Date.now();
    const layout = getWorkspaceFilesystemLayout('workspace-a');
    const testProductsPath = path.join(layout.testProducts, managedName('prepared'));
    const readerDir = path.join(
      layout.state,
      'test-products-readers',
      path.basename(testProductsPath),
    );
    writeTestProducts(testProductsPath, now - 2 * DAY_MS, true);
    mkdirSync(readerDir, { recursive: true });
    writeFileSync(path.join(readerDir, `pid${DEAD_OWNER_PID}_abcdef12.reader`), 'reader');

    expect(
      await pruneManagedTestProductsDirectory({
        testProductsDir: layout.testProducts,
        now,
        minVisibleMs: 0,
        maxAgeMs: 10 * DAY_MS,
        maxCount: 0,
        dependencies,
      }),
    ).toEqual({ scanned: 1, deleted: 1 });
    expect(existsSync(readerDir)).toBe(false);
  });

  it('leaves managed-looking reader paths outside the active workspace caller-owned', async () => {
    const otherWorkspacePath = path.join(root, 'other-workspace', managedName('prepared'));
    let operationRan = false;

    await withManagedTestProductsReader(
      otherWorkspacePath,
      async () => {
        operationRan = true;
      },
      { workspaceKey: 'workspace-a', dependencies },
    );

    expect(operationRan).toBe(true);
  });
});
