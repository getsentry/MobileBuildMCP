import { chmodSync, existsSync, lstatSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import {
  resolveWorkspaceRoot,
  shortWorkspaceHash,
  workspaceKeyForRoot,
  resolveWorkspaceIdentity,
} from '../utils/workspace-identity.ts';
import { getWorkspaceFilesystemLayout } from '../utils/log-paths.ts';

export { resolveWorkspaceRoot, workspaceKeyForRoot, resolveWorkspaceIdentity };

let daemonRunDirOverrideForTests: string | null = null;

function compactWorkspaceKey(workspaceKey: string): string {
  const hashSuffix = workspaceKey.match(/-([a-f0-9]{12})$/u)?.[1];
  return hashSuffix ?? shortWorkspaceHash(workspaceKey);
}

export function daemonRunDir(): string {
  return daemonRunDirOverrideForTests ?? tmpdir();
}

export function setDaemonRunDirOverrideForTests(dir: string | null): void {
  daemonRunDirOverrideForTests = dir;
}

export function daemonDirForWorkspaceKey(key: string): string {
  return join(daemonRunDir(), `mobilebuildmcp-${compactWorkspaceKey(key)}`);
}

export function socketPathForWorkspaceRoot(workspaceRoot: string): string {
  const key = workspaceKeyForRoot(workspaceRoot);
  return join(daemonDirForWorkspaceKey(key), 'd.sock');
}

export function registryPathForWorkspaceKey(key: string): string {
  return join(getWorkspaceFilesystemLayout(key).state, 'daemon', 'daemon.json');
}

export function logPathForWorkspaceKey(key: string): string {
  return join(getWorkspaceFilesystemLayout(key).logs, 'daemon.log');
}

export interface GetSocketPathOptions {
  cwd?: string;
  projectConfigPath?: string;
  env?: NodeJS.ProcessEnv;
}

export function getSocketPath(opts?: GetSocketPathOptions): string {
  const env = opts?.env ?? process.env;

  if (env.MOBILEBUILDMCP_SOCKET) {
    return env.MOBILEBUILDMCP_SOCKET;
  }

  const cwd = opts?.cwd ?? process.cwd();
  const workspaceRoot = resolveWorkspaceRoot({
    cwd,
    projectConfigPath: opts?.projectConfigPath,
  });

  return socketPathForWorkspaceRoot(workspaceRoot);
}

function validateSocketDir(dir: string): void {
  const linkStat = lstatSync(dir);
  if (linkStat.isSymbolicLink()) {
    throw new Error(`Daemon socket directory cannot be a symlink: ${dir}`);
  }

  const stat = statSync(dir);
  if (!stat.isDirectory()) {
    throw new Error(`Daemon socket path parent is not a directory: ${dir}`);
  }

  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error(`Daemon socket directory is not owned by the current user: ${dir}`);
  }

  if ((stat.mode & 0o077) !== 0) {
    chmodSync(dir, 0o700);
  }
}

export function ensureSocketDir(socketPath: string): void {
  const dir = dirname(socketPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  validateSocketDir(dir);
}

export function removeStaleSocket(socketPath: string): void {
  if (existsSync(socketPath)) {
    unlinkSync(socketPath);
  }
}

/**
 * Get the daemon socket path for the current workspace context.
 * @deprecated Use getSocketPath() with explicit workspace context instead.
 */
export function defaultSocketPath(): string {
  return getSocketPath();
}
