import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { getBundledAxeEnvironment, resolveAxeBinary } from '../axe-helpers.ts';
import { resetResourceRootCacheForTests } from '../../core/resource-root.ts';
import { __resetConfigStoreForTests } from '../config-store.ts';

function writeExecutable(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '');
  chmodSync(path, 0o755);
}

describe('axe-helpers', () => {
  let originalResourceRoot: string | undefined;
  let originalDyldFrameworkPath: string | undefined;
  let originalAxePath: string | undefined;
  let originalLegacyAxePath: string | undefined;
  let originalAxeSourcePath: string | undefined;
  let originalLegacyAxeSourcePath: string | undefined;
  let tempDir: string;

  beforeEach(() => {
    originalResourceRoot = process.env.MOBILEBUILDMCP_RESOURCE_ROOT;
    originalDyldFrameworkPath = process.env.DYLD_FRAMEWORK_PATH;
    originalAxePath = process.env.MOBILEBUILDMCP_AXE_PATH;
    originalLegacyAxePath = process.env.AXE_PATH;
    originalAxeSourcePath = process.env.MOBILEBUILDMCP_AXE_SOURCE_PATH;
    originalLegacyAxeSourcePath = process.env.AXE_SOURCE_PATH;
    tempDir = mkdtempSync(join(tmpdir(), 'mobilebuildmcp-axe-helpers-'));
    delete process.env.MOBILEBUILDMCP_AXE_PATH;
    delete process.env.AXE_PATH;
    delete process.env.MOBILEBUILDMCP_AXE_SOURCE_PATH;
    delete process.env.AXE_SOURCE_PATH;
    __resetConfigStoreForTests();
    resetResourceRootCacheForTests();
  });

  afterEach(() => {
    if (originalResourceRoot === undefined) {
      delete process.env.MOBILEBUILDMCP_RESOURCE_ROOT;
    } else {
      process.env.MOBILEBUILDMCP_RESOURCE_ROOT = originalResourceRoot;
    }

    if (originalDyldFrameworkPath === undefined) {
      delete process.env.DYLD_FRAMEWORK_PATH;
    } else {
      process.env.DYLD_FRAMEWORK_PATH = originalDyldFrameworkPath;
    }

    if (originalAxePath === undefined) {
      delete process.env.MOBILEBUILDMCP_AXE_PATH;
    } else {
      process.env.MOBILEBUILDMCP_AXE_PATH = originalAxePath;
    }

    if (originalLegacyAxePath === undefined) {
      delete process.env.AXE_PATH;
    } else {
      process.env.AXE_PATH = originalLegacyAxePath;
    }

    if (originalAxeSourcePath === undefined) {
      delete process.env.MOBILEBUILDMCP_AXE_SOURCE_PATH;
    } else {
      process.env.MOBILEBUILDMCP_AXE_SOURCE_PATH = originalAxeSourcePath;
    }

    if (originalLegacyAxeSourcePath === undefined) {
      delete process.env.AXE_SOURCE_PATH;
    } else {
      process.env.AXE_SOURCE_PATH = originalLegacyAxeSourcePath;
    }

    rmSync(tempDir, { recursive: true, force: true });
    __resetConfigStoreForTests();
    resetResourceRootCacheForTests();
  });

  it('returns DYLD_FRAMEWORK_PATH when bundled axe is resolved from resource root', () => {
    const resourceRoot = join(tempDir, 'portable-root');
    const axePath = join(resourceRoot, 'bundled', 'axe');
    const frameworksDir = join(resourceRoot, 'bundled', 'Frameworks');
    mkdirSync(frameworksDir, { recursive: true });
    writeExecutable(axePath);
    process.env.MOBILEBUILDMCP_RESOURCE_ROOT = resourceRoot;
    delete process.env.DYLD_FRAMEWORK_PATH;

    const env = getBundledAxeEnvironment();
    expect(env).toEqual({
      DYLD_FRAMEWORK_PATH: frameworksDir,
    });
  });

  it('preserves existing DYLD_FRAMEWORK_PATH entries when using bundled axe', () => {
    const resourceRoot = join(tempDir, 'portable-root');
    const axePath = join(resourceRoot, 'bundled', 'axe');
    const frameworksDir = join(resourceRoot, 'bundled', 'Frameworks');
    mkdirSync(frameworksDir, { recursive: true });
    writeExecutable(axePath);
    process.env.MOBILEBUILDMCP_RESOURCE_ROOT = resourceRoot;
    process.env.DYLD_FRAMEWORK_PATH = '/existing/frameworks';

    const env = getBundledAxeEnvironment();
    expect(env).toEqual({
      DYLD_FRAMEWORK_PATH: `${frameworksDir}:/existing/frameworks`,
    });
  });

  it('resolves an explicit AXe source checkout before bundled and PATH fallback', () => {
    const sourceRoot = join(tempDir, 'AXe');
    const sourceAxePath = join(sourceRoot, '.build', 'arm64-apple-macosx', 'release', 'axe');
    const resourceRoot = join(tempDir, 'portable-root');
    const bundledAxePath = join(resourceRoot, 'bundled', 'axe');
    writeExecutable(sourceAxePath);
    writeExecutable(bundledAxePath);
    process.env.MOBILEBUILDMCP_AXE_SOURCE_PATH = sourceRoot;
    process.env.MOBILEBUILDMCP_RESOURCE_ROOT = resourceRoot;

    expect(resolveAxeBinary()).toEqual({ path: sourceAxePath, source: 'source' });
  });

  it('keeps explicit axePath precedence over axeSourcePath', () => {
    const configuredAxePath = join(tempDir, 'configured', 'axe');
    writeExecutable(configuredAxePath);
    process.env.MOBILEBUILDMCP_AXE_PATH = configuredAxePath;
    process.env.MOBILEBUILDMCP_AXE_SOURCE_PATH = join(tempDir, 'missing-source');

    expect(resolveAxeBinary()).toEqual({ path: configuredAxePath, source: 'env' });
  });

  it('preserves existing invalid axePath fallback behavior', () => {
    const sourceRoot = join(tempDir, 'AXe');
    const sourceAxePath = join(sourceRoot, '.build', 'arm64-apple-macosx', 'release', 'axe');
    writeExecutable(sourceAxePath);
    process.env.MOBILEBUILDMCP_AXE_PATH = join(tempDir, 'missing', 'axe');
    process.env.MOBILEBUILDMCP_AXE_SOURCE_PATH = sourceRoot;

    expect(resolveAxeBinary()).toEqual({ path: sourceAxePath, source: 'source' });
  });

  it('fails loudly for invalid explicit axeSourcePath instead of falling back', () => {
    const resourceRoot = join(tempDir, 'portable-root');
    writeExecutable(join(resourceRoot, 'bundled', 'axe'));
    process.env.MOBILEBUILDMCP_RESOURCE_ROOT = resourceRoot;
    process.env.MOBILEBUILDMCP_AXE_SOURCE_PATH = join(tempDir, 'missing-source');

    expect(() => resolveAxeBinary()).toThrow(
      'Configured axeSourcePath does not exist or is not a directory',
    );
  });
});
