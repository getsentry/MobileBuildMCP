import * as path from 'node:path';
import * as os from 'node:os';

export const APP_DIR = path.join(os.homedir(), 'Library', 'Developer', 'MobileBuildMCP');

let appDirOverrideForTests: string | null = null;

export interface LogRetentionPaths {
  lockDir: string;
  markerPath: string;
}

export interface WorkspaceFilesystemLifecyclePaths {
  lockDir: string;
  markerPath: string;
}

export interface WorkspaceFilesystemLayout {
  workspaceKey: string;
  root: string;
  logs: string;
  state: string;
  locks: string;
  derivedData: string;
  resultBundles: string;
  testProducts: string;
  logRetention: LogRetentionPaths;
  filesystemLifecycle: WorkspaceFilesystemLifecyclePaths;
  simulatorLaunchOsLogRegistryDir: string;
}

export function getMobileBuildMCPAppDir(): string {
  return appDirOverrideForTests ?? APP_DIR;
}

export function getWorkspacesDir(): string {
  return path.join(getMobileBuildMCPAppDir(), 'workspaces');
}

function normalizeWorkspaceKey(workspaceKey: string): string {
  const normalized = workspaceKey.trim();
  if (!normalized) {
    throw new Error('Workspace key cannot be empty');
  }
  if (normalized.includes('/') || normalized.includes('\\')) {
    throw new Error(`Workspace key cannot contain path separators: ${workspaceKey}`);
  }
  if (normalized === '.' || normalized === '..') {
    throw new Error(`Workspace key cannot be a relative path segment: ${workspaceKey}`);
  }
  return normalized;
}

export function getWorkspaceFilesystemLayout(workspaceKey: string): WorkspaceFilesystemLayout {
  const normalizedWorkspaceKey = normalizeWorkspaceKey(workspaceKey);
  const root = path.join(getWorkspacesDir(), normalizedWorkspaceKey);
  const logs = path.join(root, 'logs');
  const state = path.join(root, 'state');
  const locks = path.join(root, 'locks');
  const derivedData = path.join(root, 'DerivedData');
  const resultBundles = path.join(root, 'result-bundles');
  const testProducts = path.join(root, 'test-products');

  return {
    workspaceKey: normalizedWorkspaceKey,
    root,
    logs,
    state,
    locks,
    derivedData,
    resultBundles,
    testProducts,
    logRetention: {
      lockDir: path.join(locks, 'log-retention.lock'),
      markerPath: path.join(state, 'log-retention', 'last-cleanup'),
    },
    filesystemLifecycle: {
      lockDir: path.join(locks, 'filesystem-lifecycle.lock'),
      markerPath: path.join(state, 'filesystem-lifecycle', 'last-cleanup'),
    },
    simulatorLaunchOsLogRegistryDir: path.join(state, 'simulator-launch-oslog'),
  };
}

export function setMobileBuildMCPAppDirOverrideForTests(dir: string | null): void {
  appDirOverrideForTests = dir;
}
