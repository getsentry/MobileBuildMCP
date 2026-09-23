import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import {
  resolveWorkspaceIdentity,
  resolveWorkspaceRoot,
  workspaceKeyForRoot,
} from '../workspace-identity.ts';

describe('workspace identity', () => {
  it('uses the project root when a project config path is available', () => {
    const workspaceRoot = path.join('/repo', 'app');
    const projectConfigPath = path.join(workspaceRoot, '.mobilebuildmcp', 'config.yaml');

    expect(resolveWorkspaceRoot({ cwd: '/elsewhere', projectConfigPath })).toBe(workspaceRoot);
    expect(resolveWorkspaceIdentity({ cwd: '/elsewhere', projectConfigPath })).toEqual({
      workspaceRoot,
      workspaceKey: workspaceKeyForRoot(workspaceRoot),
    });
  });

  it('uses cwd when no project config path is available', () => {
    const workspaceRoot = '/definitely-not-a-real-workspace-root';

    expect(resolveWorkspaceIdentity({ cwd: workspaceRoot })).toEqual({
      workspaceRoot,
      workspaceKey: workspaceKeyForRoot(workspaceRoot),
    });
  });

  it('prefixes the workspace key with a filesystem-safe workspace name', () => {
    const key = workspaceKeyForRoot('/Users/dev/My Weather App!');

    expect(key).toMatch(/^My-Weather-App-[a-f0-9]{12}$/);
  });

  it('falls back to a generic name when the root has no usable basename', () => {
    const key = workspaceKeyForRoot('/');

    expect(key).toMatch(/^workspace-[a-f0-9]{12}$/);
  });
});
