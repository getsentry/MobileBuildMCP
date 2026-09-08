import * as fs from 'node:fs';
import * as path from 'node:path';
import { getWorkspaceFilesystemLayout } from './log-paths.ts';
import { formatLogTimestamp, shortRandomSuffix } from './log-naming.ts';
import { log } from './logger.ts';
import { getRuntimeInstanceIfConfigured } from './runtime-instance.ts';
import { workspaceKeyForRoot } from './workspace-identity.ts';

export const TEST_PRODUCTS_COMPLETION_MARKER_SUFFIX = '.xcodebuildmcp-completed';

const ISO_TIMESTAMP_PATTERN = '\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z';
const SUFFIX_PATTERN = '[a-f0-9]{8}';
const TEST_PRODUCTS_NAME_PATTERN = new RegExp(
  `^[A-Za-z0-9][A-Za-z0-9_-]*_${ISO_TIMESTAMP_PATTERN}_pid\\d+_${SUFFIX_PATTERN}\\.xctestproducts$`,
);
const TEST_PRODUCTS_OWNER_PID_PATTERN = /_pid(\d+)_/u;

function resolveWorkspaceKey(): string {
  return getRuntimeInstanceIfConfigured()?.workspaceKey ?? workspaceKeyForRoot(process.cwd());
}

export function isXcodeBuildMCPManagedTestProductsName(fileName: string): boolean {
  return TEST_PRODUCTS_NAME_PATTERN.test(fileName);
}

export function getManagedTestProductsOwnerPid(fileName: string): number | null {
  const pid = Number(fileName.match(TEST_PRODUCTS_OWNER_PID_PATTERN)?.[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function getTestProductsCompletionMarkerPath(testProductsPath: string): string {
  return `${testProductsPath}${TEST_PRODUCTS_COMPLETION_MARKER_SUFFIX}`;
}

export function isTestProductsCompletionMarkerTempName(name: string): boolean {
  return name.includes(`${TEST_PRODUCTS_COMPLETION_MARKER_SUFFIX}.`) && name.endsWith('.tmp');
}

export function createDefaultTestProductsPath(toolName: string): string {
  const testProductsDir = getWorkspaceFilesystemLayout(resolveWorkspaceKey()).testProducts;

  try {
    fs.mkdirSync(testProductsDir, { recursive: true, mode: 0o700 });
    fs.accessSync(testProductsDir, fs.constants.W_OK);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Unable to create writable test products directory at ${testProductsDir}: ${message}`,
      { cause: error },
    );
  }

  return path.join(
    testProductsDir,
    `${toolName}_${formatLogTimestamp()}_pid${process.pid}_${shortRandomSuffix()}.xctestproducts`,
  );
}

async function collectXctestrunPaths(directory: string, paths: string[]): Promise<void> {
  const entries = await fs.promises.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      continue;
    }
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectXctestrunPaths(entryPath, paths);
    } else if (entry.isFile() && entry.name.endsWith('.xctestrun')) {
      paths.push(entryPath);
    }
  }
}

export async function findXctestrunPaths(testProductsPath: string): Promise<string[]> {
  try {
    const stat = await fs.promises.lstat(testProductsPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return [];
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const paths: string[] = [];
  await collectXctestrunPaths(testProductsPath, paths);
  return paths.sort((left, right) => left.localeCompare(right));
}
export async function hasMultipleSimulatorPlatforms(testProductsPath: string): Promise<boolean> {
  const xctestrunPaths = await findXctestrunPaths(testProductsPath);
  const simulatorPlatforms = new Set<string>();

  for (const xctestrunPath of xctestrunPaths) {
    const contents = await fs.promises.readFile(xctestrunPath, 'utf8');
    for (const match of contents.matchAll(/(?:^|[-/])([A-Za-z]+simulator)(?:[/\\])/gu)) {
      simulatorPlatforms.add(match[1]!.toLowerCase());
    }
    if (simulatorPlatforms.size > 1) {
      return true;
    }
  }

  return false;
}

export function markTestProductsPathCompleted(testProductsPath: string | undefined): void {
  if (!testProductsPath) {
    return;
  }

  try {
    if (!fs.existsSync(testProductsPath) || !fs.statSync(testProductsPath).isDirectory()) {
      return;
    }
    const markerPath = getTestProductsCompletionMarkerPath(testProductsPath);
    const tempPath = `${markerPath}.${process.pid}_${shortRandomSuffix()}.tmp`;
    fs.writeFileSync(tempPath, `${Date.now()}\n`);
    try {
      fs.renameSync(tempPath, markerPath);
    } catch (renameError) {
      fs.rmSync(tempPath, { force: true });
      throw renameError;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log('warn', `Unable to mark test products completed at ${testProductsPath}: ${message}`);
  }
}
