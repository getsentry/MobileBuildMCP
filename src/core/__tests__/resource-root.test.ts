import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  getBundledAxePath,
  getBundledFrameworksDir,
  getManifestsDir,
  getResourceRoot,
  getStructuredOutputSchemasDir,
  resetResourceRootCacheForTests,
} from '../resource-root.ts';

describe('resource-root', () => {
  let originalExecPath: string;
  let originalResourceRoot: string | undefined;
  let tempDir: string;

  beforeEach(() => {
    originalExecPath = process.execPath;
    originalResourceRoot = process.env.MOBILEBUILDMCP_RESOURCE_ROOT;
    tempDir = mkdtempSync(join(tmpdir(), 'mobilebuildmcp-resource-root-'));
    resetResourceRootCacheForTests();
  });

  afterEach(() => {
    process.execPath = originalExecPath;
    if (originalResourceRoot === undefined) {
      delete process.env.MOBILEBUILDMCP_RESOURCE_ROOT;
    } else {
      process.env.MOBILEBUILDMCP_RESOURCE_ROOT = originalResourceRoot;
    }
    rmSync(tempDir, { recursive: true, force: true });
    resetResourceRootCacheForTests();
  });

  it('uses MOBILEBUILDMCP_RESOURCE_ROOT when set', () => {
    const explicitRoot = join(tempDir, 'explicit-root');
    process.env.MOBILEBUILDMCP_RESOURCE_ROOT = explicitRoot;

    expect(getResourceRoot()).toBe(resolve(explicitRoot));
    expect(getManifestsDir()).toBe(join(resolve(explicitRoot), 'manifests'));
    expect(getStructuredOutputSchemasDir()).toBe(
      join(resolve(explicitRoot), 'schemas', 'structured-output'),
    );
    expect(getBundledAxePath()).toBe(join(resolve(explicitRoot), 'bundled', 'axe'));
  });

  it('falls back to executable-relative root when resources exist next to executable', () => {
    delete process.env.MOBILEBUILDMCP_RESOURCE_ROOT;
    const executableRoot = join(tempDir, 'portable-install', 'libexec');
    mkdirSync(join(executableRoot, 'manifests', 'tools'), { recursive: true });
    process.execPath = join(executableRoot, 'mobilebuildmcp');

    expect(getResourceRoot()).toBe(executableRoot);
    expect(getBundledFrameworksDir()).toBe(join(executableRoot, 'bundled', 'Frameworks'));
  });
});
