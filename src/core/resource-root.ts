import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const RESOURCE_ROOT_ENV_VAR = 'MOBILEBUILDMCP_RESOURCE_ROOT';
let cachedPackageRoot: string | null = null;
let cachedResourceRoot: string | null = null;

export function resetResourceRootCacheForTests(): void {
  cachedPackageRoot = null;
  cachedResourceRoot = null;
}

function hasResourceLayout(root: string): boolean {
  return fs.existsSync(path.join(root, 'manifests')) || fs.existsSync(path.join(root, 'bundled'));
}

function findPackageRootFrom(startDir: string): string | null {
  let dir = startDir;
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return null;
}

export function getPackageRoot(): string {
  if (cachedPackageRoot) {
    return cachedPackageRoot;
  }

  const candidates: string[] = [];
  const importMetaUrl = typeof import.meta.url === 'string' ? import.meta.url : null;
  if (importMetaUrl) {
    candidates.push(path.dirname(fileURLToPath(importMetaUrl)));
  }
  candidates.push(process.cwd());
  const entry = process.argv[1];
  if (entry) {
    candidates.push(path.dirname(entry));
  }

  for (const candidate of candidates) {
    const found = findPackageRootFrom(candidate);
    if (found) {
      cachedPackageRoot = found;
      return found;
    }
  }

  throw new Error('Could not find package root (no package.json found in parent directories)');
}

function getExecutableResourceRoot(): string | null {
  const execPath = process.execPath;
  const candidateDirs = [path.dirname(execPath), path.dirname(path.dirname(execPath))];
  for (const candidate of candidateDirs) {
    if (hasResourceLayout(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function getResourceRoot(): string {
  if (cachedResourceRoot) {
    return cachedResourceRoot;
  }

  const explicitRoot = process.env[RESOURCE_ROOT_ENV_VAR];
  if (explicitRoot) {
    cachedResourceRoot = path.resolve(explicitRoot);
    return cachedResourceRoot;
  }

  const executableRoot = getExecutableResourceRoot();
  if (executableRoot) {
    cachedResourceRoot = executableRoot;
    return cachedResourceRoot;
  }

  cachedResourceRoot = getPackageRoot();
  return cachedResourceRoot;
}

export function getManifestsDir(): string {
  return path.join(getResourceRoot(), 'manifests');
}

export function getStructuredOutputSchemasDir(): string {
  return path.join(getResourceRoot(), 'schemas', 'structured-output');
}

export function getBundledAxePath(): string {
  return path.join(getResourceRoot(), 'bundled', 'axe');
}

export function getBundledFrameworksDir(): string {
  return path.join(getResourceRoot(), 'bundled', 'Frameworks');
}
