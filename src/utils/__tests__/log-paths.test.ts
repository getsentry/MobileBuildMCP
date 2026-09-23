import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import {
  getWorkspaceFilesystemLayout,
  getWorkspacesDir,
  setMobileBuildMCPAppDirOverrideForTests,
} from '../log-paths.ts';

describe('log paths', () => {
  afterEach(() => {
    setMobileBuildMCPAppDirOverrideForTests(null);
  });

  it('rejects relative path segment workspace keys', () => {
    expect(() => getWorkspaceFilesystemLayout('.')).toThrow(
      'Workspace key cannot be a relative path segment',
    );
    expect(() => getWorkspaceFilesystemLayout('..')).toThrow(
      'Workspace key cannot be a relative path segment',
    );
  });

  it('builds the workspace-first filesystem layout', () => {
    const appDir = path.join('/tmp', 'mobilebuildmcp-app');
    setMobileBuildMCPAppDirOverrideForTests(appDir);

    const layout = getWorkspaceFilesystemLayout('workspace-a');

    expect(getWorkspacesDir()).toBe(path.join(appDir, 'workspaces'));
    expect(layout).toMatchObject({
      workspaceKey: 'workspace-a',
      root: path.join(appDir, 'workspaces', 'workspace-a'),
      logs: path.join(appDir, 'workspaces', 'workspace-a', 'logs'),
      state: path.join(appDir, 'workspaces', 'workspace-a', 'state'),
      locks: path.join(appDir, 'workspaces', 'workspace-a', 'locks'),
      derivedData: path.join(appDir, 'workspaces', 'workspace-a', 'DerivedData'),
      resultBundles: path.join(appDir, 'workspaces', 'workspace-a', 'result-bundles'),
      logRetention: {
        lockDir: path.join(appDir, 'workspaces', 'workspace-a', 'locks', 'log-retention.lock'),
        markerPath: path.join(
          appDir,
          'workspaces',
          'workspace-a',
          'state',
          'log-retention',
          'last-cleanup',
        ),
      },
      filesystemLifecycle: {
        lockDir: path.join(
          appDir,
          'workspaces',
          'workspace-a',
          'locks',
          'filesystem-lifecycle.lock',
        ),
        markerPath: path.join(
          appDir,
          'workspaces',
          'workspace-a',
          'state',
          'filesystem-lifecycle',
          'last-cleanup',
        ),
      },
      simulatorLaunchOsLogRegistryDir: path.join(
        appDir,
        'workspaces',
        'workspace-a',
        'state',
        'simulator-launch-oslog',
      ),
    });
  });
});
