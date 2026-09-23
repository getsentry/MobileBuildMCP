/**
 * Vitest unit-test setup: installs blocking executor/spawner overrides.
 *
 * This ensures unit tests fail fast if they accidentally reach a real system
 * executor, filesystem, or interactive spawner without explicit mock injection.
 *
 * Only loaded by vitest.config.ts (unit tests). Snapshot and smoke configs
 * intentionally do NOT load this file.
 */

import { beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  __setTestCommandExecutorOverride,
  __setTestFileSystemExecutorOverride,
  __clearTestExecutorOverrides,
  __setTestInteractiveSpawnerOverride,
  __clearTestInteractiveSpawnerOverride,
} from '../utils/execution/index.ts';
import {
  createNoopExecutor,
  createNoopFileSystemExecutor,
  createNoopInteractiveSpawner,
} from './mock-executors.ts';
import { setXcodebuildLogDirOverrideForTests } from '../utils/xcodebuild-log-capture.ts';
import { resetWorkspaceFilesystemLifecycleStateForTests } from '../utils/workspace-filesystem-lifecycle.ts';
import { setMobileBuildMCPAppDirOverrideForTests } from '../utils/log-paths.ts';

let xcodebuildLogDir: string | null = null;
let appDir: string | null = null;

beforeEach(() => {
  __setTestCommandExecutorOverride(createNoopExecutor());
  __setTestFileSystemExecutorOverride(createNoopFileSystemExecutor());
  __setTestInteractiveSpawnerOverride(createNoopInteractiveSpawner());
  appDir = mkdtempSync(path.join(tmpdir(), 'mobilebuildmcp-test-app-dir-'));
  setMobileBuildMCPAppDirOverrideForTests(appDir);
  xcodebuildLogDir = mkdtempSync(path.join(tmpdir(), 'mobilebuildmcp-test-logs-'));
  setXcodebuildLogDirOverrideForTests(xcodebuildLogDir);
});

afterEach(async () => {
  __clearTestExecutorOverrides();
  __clearTestInteractiveSpawnerOverride();
  setXcodebuildLogDirOverrideForTests(null);
  setMobileBuildMCPAppDirOverrideForTests(null);
  resetWorkspaceFilesystemLifecycleStateForTests();
  if (xcodebuildLogDir) {
    await rm(xcodebuildLogDir, { recursive: true, force: true });
    xcodebuildLogDir = null;
  }
  if (appDir) {
    await rm(appDir, { recursive: true, force: true });
    appDir = null;
  }
});
