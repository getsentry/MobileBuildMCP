import { log } from './logger.ts';
import type { CommandResponse } from './command.ts';
import { getDefaultCommandExecutor } from './command.ts';
import { existsSync, statSync } from 'fs';
import { createHash, randomUUID } from 'node:crypto';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { getConfig } from './config-store.ts';

let overriddenXcodemakePath: string | null = null;

export const XCODEMAKE_COMMIT = '75f47d4b69c1604cb886ab37d348c2c245d18329';
export const XCODEMAKE_SHA256 = '0934f784661f8b295f51064b8e94659c986ca25affc5062f20d5210ae0e25201';
export const XCODEMAKE_DOWNLOAD_URL = `https://raw.githubusercontent.com/cameroncooke/xcodemake/${XCODEMAKE_COMMIT}/xcodemake`;

interface XcodemakeInstallerDependencies {
  fetch: typeof fetch;
  mkdir: typeof fs.mkdir;
  writeFile: typeof fs.writeFile;
  chmod: typeof fs.chmod;
  rename: typeof fs.rename;
  unlink: typeof fs.unlink;
}

const defaultInstallerDependencies: XcodemakeInstallerDependencies = {
  fetch,
  mkdir: fs.mkdir,
  writeFile: fs.writeFile,
  chmod: fs.chmod,
  rename: fs.rename,
  unlink: fs.unlink,
};

export function isXcodemakeEnabled(): boolean {
  return getConfig().incrementalBuildsEnabled;
}

function getXcodemakeCommand(): string {
  return overriddenXcodemakePath ?? 'xcodemake';
}

function isExecutable(path: string): boolean {
  try {
    const stat = statSync(path);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

export function isXcodemakeBinaryAvailable(): boolean {
  if (overriddenXcodemakePath && isExecutable(overriddenXcodemakePath)) {
    return true;
  }

  const pathValue = process.env.PATH ?? '';
  const entries = pathValue.split(path.delimiter).filter(Boolean);
  for (const entry of entries) {
    const candidate = path.join(entry, 'xcodemake');
    if (isExecutable(candidate)) {
      return true;
    }
  }

  return false;
}

function overrideXcodemakeCommand(path: string): void {
  overriddenXcodemakePath = path;
  log('info', `Using overridden xcodemake path: ${path}`);
}

/** Verifies downloaded xcodemake bytes against the pinned SHA-256 digest. */
export function verifyXcodemakeScript(
  scriptContent: string,
  expectedSha256 = XCODEMAKE_SHA256,
): void {
  const actualSha256 = createHash('sha256').update(scriptContent).digest('hex');
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `xcodemake checksum mismatch: expected ${expectedSha256}, received ${actualSha256}`,
    );
  }
}

/** Installs the pinned, verified xcodemake script and reports whether installation succeeded. */
export async function installXcodemake(
  deps: XcodemakeInstallerDependencies = defaultInstallerDependencies,
  expectedSha256 = XCODEMAKE_SHA256,
): Promise<boolean> {
  const tempDir = os.tmpdir();
  const xcodemakeDir = path.join(tempDir, 'mobilebuildmcp');
  const xcodemakePath = path.join(xcodemakeDir, 'xcodemake');
  const stagingPath = `${xcodemakePath}.${process.pid}.${randomUUID()}.tmp`;

  log('info', `Attempting to install xcodemake to ${xcodemakePath}`);

  try {
    await deps.mkdir(xcodemakeDir, { recursive: true });

    log('info', 'Downloading xcodemake from GitHub...');
    const response = await deps.fetch(XCODEMAKE_DOWNLOAD_URL);

    if (!response.ok) {
      throw new Error(`Failed to download xcodemake: ${response.status} ${response.statusText}`);
    }

    const scriptContent = await response.text();
    verifyXcodemakeScript(scriptContent, expectedSha256);
    await deps.writeFile(stagingPath, scriptContent, 'utf8');

    await deps.chmod(stagingPath, 0o755);
    await deps.rename(stagingPath, xcodemakePath);
    log('info', 'Made xcodemake executable');

    overrideXcodemakeCommand(xcodemakePath);

    return true;
  } catch (error) {
    log(
      'error',
      `Error installing xcodemake: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  } finally {
    try {
      await deps.unlink(stagingPath);
    } catch {
      // A successful atomic rename consumes the staged path.
    }
  }
}

export async function isXcodemakeAvailable(): Promise<boolean> {
  if (!isXcodemakeEnabled()) {
    log('debug', 'xcodemake is not enabled, skipping availability check');
    return false;
  }

  try {
    if (overriddenXcodemakePath && existsSync(overriddenXcodemakePath)) {
      log('debug', `xcodemake found at overridden path: ${overriddenXcodemakePath}`);
      return true;
    }

    const result = await getDefaultCommandExecutor()(['which', 'xcodemake']);
    if (result.success) {
      log('debug', 'xcodemake found in PATH');
      return true;
    }

    log('info', 'xcodemake not found in PATH, attempting to download...');
    const installed = await installXcodemake();
    if (!installed) {
      log('warn', 'xcodemake installation failed');
      return false;
    }

    log('info', 'xcodemake installed successfully');
    return true;
  } catch (error) {
    log(
      'error',
      `Error checking for xcodemake: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

export function doesMakefileExist(projectDir: string): boolean {
  return existsSync(`${projectDir}/Makefile`);
}

export async function executeXcodemakeCommand(
  projectDir: string,
  buildArgs: string[],
  logPrefix: string,
): Promise<CommandResponse> {
  const xcodemakeCommand = [getXcodemakeCommand(), ...buildArgs];
  const prefix = projectDir + '/';
  const command = xcodemakeCommand.map((arg) => {
    if (arg.startsWith(prefix)) {
      return arg.substring(prefix.length);
    }
    return arg;
  });

  return getDefaultCommandExecutor()(command, logPrefix, false, { cwd: projectDir });
}
