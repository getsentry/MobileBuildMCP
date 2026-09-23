/**
 * AXe Helper Functions
 *
 * This utility module provides functions to resolve and execute AXe.
 * Prefers bundled AXe when present, but allows env and PATH fallback.
 */

import { accessSync, constants, existsSync, readdirSync, statSync } from 'fs';
import { delimiter, join, resolve } from 'path';
import type { CommandExecutor } from './execution/index.ts';
import { getDefaultCommandExecutor } from './execution/index.ts';
import { getConfig } from './config-store.ts';
import { getBundledAxePath, getBundledFrameworksDir } from '../core/resource-root.ts';

export type AxeBinarySource = 'env' | 'source' | 'bundled' | 'path';

export type AxeBinary = {
  path: string;
  source: AxeBinarySource;
};

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveAxePathFromConfig(): string | null {
  const value = getConfig().axePath;
  if (!value) return null;
  const resolved = resolve(value);
  return isExecutable(resolved) ? resolved : null;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function getAxeSourceBuildCandidates(sourcePath: string): string[] {
  const candidates = [join(sourcePath, '.build', 'release', 'axe')];
  const swiftBuildDir = join(sourcePath, '.build');

  if (isDirectory(swiftBuildDir)) {
    for (const entry of readdirSync(swiftBuildDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.endsWith('-apple-macosx')) {
        candidates.push(join(swiftBuildDir, entry.name, 'release', 'axe'));
      }
    }
  }

  return candidates;
}

function resolveAxePathFromSourceConfig(): string | null {
  const value = getConfig().axeSourcePath;
  if (!value) return null;

  const sourcePath = resolve(value);
  if (!isDirectory(sourcePath)) {
    throw new Error(`Configured axeSourcePath does not exist or is not a directory: ${sourcePath}`);
  }

  const candidates = getAxeSourceBuildCandidates(sourcePath);
  for (const candidate of candidates) {
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Configured axeSourcePath does not contain an executable release AXe build. Expected one of: ${candidates.join(', ')}`,
  );
}

function resolveBundledAxePath(): string | null {
  const candidates = new Set<string>();
  candidates.add(getBundledAxePath());
  candidates.add(join(process.cwd(), 'bundled', 'axe'));

  for (const candidate of candidates) {
    if (existsSync(candidate) && isExecutable(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolveAxePathFromPath(): string | null {
  const pathValue = process.env.PATH ?? '';
  const entries = pathValue.split(delimiter).filter(Boolean);
  for (const entry of entries) {
    const candidate = join(entry, 'axe');
    if (isExecutable(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function resolveAxeBinary(): AxeBinary | null {
  const configPath = resolveAxePathFromConfig();
  if (configPath) {
    return { path: configPath, source: 'env' };
  }

  const sourcePath = resolveAxePathFromSourceConfig();
  if (sourcePath) {
    return { path: sourcePath, source: 'source' };
  }

  const bundledPath = resolveBundledAxePath();
  if (bundledPath) {
    return { path: bundledPath, source: 'bundled' };
  }

  const pathBinary = resolveAxePathFromPath();
  if (pathBinary) {
    return { path: pathBinary, source: 'path' };
  }

  return null;
}

/**
 * Get the path to the available axe binary
 */
export function getAxePath(): string | null {
  return resolveAxeBinary()?.path ?? null;
}

/**
 * Get environment variables needed for bundled AXe to run
 */
export function getBundledAxeEnvironment(): Record<string, string> {
  const resolved = resolveAxeBinary();
  if (resolved?.source !== 'bundled') {
    return {};
  }

  const frameworksDir = getBundledFrameworksDir();
  if (!existsSync(frameworksDir)) {
    return {};
  }

  const currentFrameworkPath = process.env.DYLD_FRAMEWORK_PATH;
  const frameworkPath = currentFrameworkPath
    ? `${frameworksDir}${delimiter}${currentFrameworkPath}`
    : frameworksDir;

  return { DYLD_FRAMEWORK_PATH: frameworkPath };
}

/**
 * Check if axe tool is available (bundled, env override, or PATH)
 */
export function areAxeToolsAvailable(): boolean {
  return getAxePath() !== null;
}

export const AXE_NOT_AVAILABLE_MESSAGE =
  'AXe tool not found. UI automation features are not available.\n\n' +
  'Install AXe (brew tap cameroncooke/axe && brew install axe) or set MOBILEBUILDMCP_AXE_PATH.\n' +
  'For local source validation, set MOBILEBUILDMCP_AXE_SOURCE_PATH to an AXe checkout with a release build.\n' +
  'Ensure bundled artifacts are included or PATH is configured.';

/**
 * Compare two semver strings a and b.
 * Returns 1 if a > b, -1 if a < b, 0 if equal.
 */
function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10));
  const pb = b.split('.').map((n) => parseInt(n, 10));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = Number.isFinite(pa[i]) ? pa[i] : 0;
    const db = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

/**
 * Determine whether the bundled AXe meets a minimum version requirement.
 * Runs `axe --version` and parses a semantic version (e.g., "1.1.0").
 * If AXe is missing or the version cannot be parsed, returns false.
 */
export async function isAxeAtLeastVersion(
  required: string,
  executor?: CommandExecutor,
): Promise<boolean> {
  const axePath = getAxePath();
  if (!axePath) return false;

  const exec = executor ?? getDefaultCommandExecutor();
  try {
    const res = await exec([axePath, '--version'], 'AXe Version', true);
    if (!res.success) return false;

    const output = res.output ?? '';
    const versionMatch = output.match(/(\d+\.\d+\.\d+)/);
    if (!versionMatch) return false;

    const current = versionMatch[1];
    return compareSemver(current, required) >= 0;
  } catch {
    return false;
  }
}
