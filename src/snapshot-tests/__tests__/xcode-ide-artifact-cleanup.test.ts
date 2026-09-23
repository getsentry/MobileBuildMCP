import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setMobileBuildMCPAppDirOverrideForTests } from '../../utils/log-paths.ts';
import {
  assertOwnedXcodeIdeArtifactPath,
  assertOwnedXcodeIdeWorkspaceRoot,
} from '../suites/xcode-ide-suite.ts';

const temporaryDirectories: string[] = [];

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'mobilebuildmcp-artifact-cleanup-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  setMobileBuildMCPAppDirOverrideForTests(null);
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Xcode IDE artifact ownership validation', () => {
  it('accepts a regular JSON artifact in an owned invocation directory', () => {
    const root = createTemporaryDirectory();
    const ownerDirectory = join(root, 'ownerpid123_instance-1');
    const artifactPath = join(ownerDirectory, 'response.json');
    mkdirSync(ownerDirectory);
    writeFileSync(artifactPath, '{}');

    expect(assertOwnedXcodeIdeArtifactPath(artifactPath, root)).toBe(realpathSync(artifactPath));
  });

  it('rejects a SUT-returned path outside the owned artifact root', () => {
    const root = createTemporaryDirectory();
    const outsideRoot = createTemporaryDirectory();
    const artifactPath = join(outsideRoot, 'response.json');
    writeFileSync(artifactPath, '{}');

    expect(() => assertOwnedXcodeIdeArtifactPath(artifactPath, root)).toThrow(
      'Refusing to delete unowned Xcode IDE artifact',
    );
  });

  it('rejects symlinks even when they are inside the owned artifact root', () => {
    const root = createTemporaryDirectory();
    const ownerDirectory = join(root, 'ownerpid123_instance-1');
    const targetPath = join(root, 'target.json');
    const artifactPath = join(ownerDirectory, 'response.json');
    mkdirSync(ownerDirectory);
    writeFileSync(targetPath, '{}');
    symlinkSync(targetPath, artifactPath);

    expect(() => assertOwnedXcodeIdeArtifactPath(artifactPath, root)).toThrow(
      'Refusing to delete non-file Xcode IDE artifact',
    );
  });
});

describe('Xcode IDE workspace ownership validation', () => {
  it('accepts the regular workspace directory for the exact owned workspace key', () => {
    const appDirectory = createTemporaryDirectory();
    const workspaceKey = 'snapshot-workspace-123';
    const workspaceRoot = join(appDirectory, 'workspaces', workspaceKey);
    setMobileBuildMCPAppDirOverrideForTests(appDirectory);
    mkdirSync(workspaceRoot, { recursive: true });

    expect(assertOwnedXcodeIdeWorkspaceRoot(workspaceRoot, workspaceKey)).toBe(workspaceRoot);
  });

  it('rejects a workspace directory outside the configured workspaces root', () => {
    const appDirectory = createTemporaryDirectory();
    const outsideRoot = createTemporaryDirectory();
    setMobileBuildMCPAppDirOverrideForTests(appDirectory);

    expect(() => assertOwnedXcodeIdeWorkspaceRoot(outsideRoot, 'snapshot-workspace-123')).toThrow(
      'Refusing to delete unowned Xcode IDE workspace',
    );
  });

  it('rejects a symlink at the owned workspace path', () => {
    const appDirectory = createTemporaryDirectory();
    const targetRoot = createTemporaryDirectory();
    const workspaceKey = 'snapshot-workspace-123';
    const workspaceRoot = join(appDirectory, 'workspaces', workspaceKey);
    setMobileBuildMCPAppDirOverrideForTests(appDirectory);
    mkdirSync(join(appDirectory, 'workspaces'), { recursive: true });
    symlinkSync(targetRoot, workspaceRoot);

    expect(() => assertOwnedXcodeIdeWorkspaceRoot(workspaceRoot, workspaceKey)).toThrow(
      'Refusing to delete non-directory Xcode IDE workspace',
    );
  });
});
