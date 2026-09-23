import * as fs from 'node:fs';
import * as path from 'node:path';
import { log } from './logger.ts';
import { getWorkspaceFilesystemLayout } from './log-paths.ts';
import { formatLogTimestamp, shortRandomSuffix } from './log-naming.ts';
import { getRuntimeInstanceIfConfigured } from './runtime-instance.ts';
import { workspaceKeyForRoot } from './workspace-identity.ts';

export const RESULT_BUNDLE_COMPLETION_MARKER_SUFFIX = '.mobilebuildmcp-completed';

export function isResultBundleCompletionMarkerTempName(name: string): boolean {
  return name.includes(`${RESULT_BUNDLE_COMPLETION_MARKER_SUFFIX}.`) && name.endsWith('.tmp');
}

function resolveWorkspaceKey(): string {
  return getRuntimeInstanceIfConfigured()?.workspaceKey ?? workspaceKeyForRoot(process.cwd());
}

export function getResultBundleCompletionMarkerPath(resultBundlePath: string): string {
  return `${resultBundlePath}${RESULT_BUNDLE_COMPLETION_MARKER_SUFFIX}`;
}

export function createDefaultResultBundlePath(toolName: string): string {
  const resultBundleDir = getWorkspaceFilesystemLayout(resolveWorkspaceKey()).resultBundles;

  try {
    fs.mkdirSync(resultBundleDir, { recursive: true, mode: 0o700 });
    fs.accessSync(resultBundleDir, fs.constants.W_OK);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Unable to create writable result bundle directory at ${resultBundleDir}: ${message}`,
    );
  }

  return path.join(
    resultBundleDir,
    `${toolName}_${formatLogTimestamp()}_pid${process.pid}_${shortRandomSuffix()}.xcresult`,
  );
}

export function markResultBundlePathCompleted(resultBundlePath: string | undefined): void {
  if (!resultBundlePath) {
    return;
  }

  try {
    if (!fs.existsSync(resultBundlePath) || !fs.statSync(resultBundlePath).isDirectory()) {
      return;
    }
    const markerPath = getResultBundleCompletionMarkerPath(resultBundlePath);
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
    log('warn', `Unable to mark result bundle completed at ${resultBundlePath}: ${message}`);
  }
}
