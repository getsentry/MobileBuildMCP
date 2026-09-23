import { existsSync, lstatSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { describe, it } from 'vitest';
import { getWorkspaceFilesystemLayout, getWorkspacesDir } from '../../utils/log-paths.ts';
import { workspaceKeyForRoot } from '../../utils/workspace-identity.ts';
import type { SnapshotResult, SnapshotRuntime, WorkflowSnapshotHarness } from '../contracts.ts';
import {
  isXcodeIdeBridgeAvailable,
  listAvailableXcodeIdeBridgeToolNames,
} from '../xcode-ide-availability.ts';
import { createHarnessForRuntime, createWorkflowResultFixtureMatcher } from './helpers.ts';

const DOCUMENTATION_SEARCH_TOOL = 'DocumentationSearch';
const DOCUMENTATION_SEARCH_QUERY = 'AVCapturePhotoOutputMaxPhotoQualityPrioritization';
const XCODE_IDE_BRIDGE_POLL_INTERVAL_MS = 250;
const XCODE_IDE_BRIDGE_READY_TIMEOUT_MS = 15_000;
const XCODE_IDE_ENV = {
  MOBILEBUILDMCP_ENABLED_WORKFLOWS: 'xcode-ide',
  MOBILEBUILDMCP_DISABLE_SESSION_DEFAULTS: 'true',
  MOBILEBUILDMCP_DISABLE_XCODE_AUTO_SYNC: '1',
  MOBILEBUILDMCP_XCODE_IDE_DISCOVERY_TIMEOUT_MS: '5000',
};

interface XcodeIdeTestEnvironment {
  cwd: string;
  artifactRoot: string;
  workspaceKey: string;
  workspaceRoot: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getArtifactPathFromEnvelope(result: SnapshotResult): string | null {
  const data = result.structuredEnvelope?.data;
  if (!isRecord(data) || !isRecord(data.artifacts)) {
    return null;
  }

  return typeof data.artifacts.rawResponseJsonPath === 'string'
    ? data.artifacts.rawResponseJsonPath
    : null;
}

function getArtifactPathFromText(result: SnapshotResult): string | null {
  const flatMatch = result.rawText.match(/Raw Response JSON:\s*(.+)$/m);
  if (flatMatch?.[1]) {
    return flatMatch[1].trim();
  }

  const treeMatch = result.rawText.match(/^\s*[├└]──\s*(.+?)\s+—\s+Raw Response JSON$/m);
  return treeMatch?.[1]?.trim() ?? null;
}

function resolveArtifactPath(artifactDisplayPath: string, cwd: string): string {
  if (artifactDisplayPath === '~') {
    return homedir();
  }
  if (artifactDisplayPath.startsWith('~/')) {
    return join(homedir(), artifactDisplayPath.slice(2));
  }
  if (isAbsolute(artifactDisplayPath)) {
    return artifactDisplayPath;
  }
  return join(cwd, artifactDisplayPath);
}

function getArtifactPath(result: SnapshotResult, cwd: string): string | null {
  const displayPath = getArtifactPathFromEnvelope(result) ?? getArtifactPathFromText(result);
  return displayPath === null ? null : resolveArtifactPath(displayPath, cwd);
}

export function assertOwnedXcodeIdeArtifactPath(
  artifactPath: string,
  artifactRoot: string,
): string {
  const artifactStat = lstatSync(artifactPath);
  if (!artifactStat.isFile() || artifactStat.isSymbolicLink()) {
    throw new Error(`Refusing to delete non-file Xcode IDE artifact: ${artifactPath}`);
  }

  const resolvedArtifactRoot = realpathSync(artifactRoot);
  const resolvedArtifactPath = realpathSync(artifactPath);
  const relativeArtifactPath = relative(resolvedArtifactRoot, resolvedArtifactPath);
  const pathParts = relativeArtifactPath.split(sep);
  const isContained =
    relativeArtifactPath.length > 0 &&
    !relativeArtifactPath.startsWith(`..${sep}`) &&
    !isAbsolute(relativeArtifactPath);
  const hasOwnedShape =
    pathParts.length === 2 &&
    /^ownerpid\d+_[A-Za-z0-9._-]+$/u.test(pathParts[0]) &&
    pathParts[1].endsWith('.json');

  if (!isContained || !hasOwnedShape) {
    throw new Error(`Refusing to delete unowned Xcode IDE artifact: ${resolvedArtifactPath}`);
  }

  return resolvedArtifactPath;
}

function removeOwnedArtifact(result: SnapshotResult, environment: XcodeIdeTestEnvironment): void {
  const artifactPath = getArtifactPath(result, environment.cwd);
  if (artifactPath === null) {
    return;
  }

  rmSync(assertOwnedXcodeIdeArtifactPath(artifactPath, environment.artifactRoot));
}

export function assertOwnedXcodeIdeWorkspaceRoot(
  workspaceRoot: string,
  workspaceKey: string,
): string {
  const workspaceStat = lstatSync(workspaceRoot);
  if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink()) {
    throw new Error(`Refusing to delete non-directory Xcode IDE workspace: ${workspaceRoot}`);
  }

  const relativeWorkspacePath = relative(getWorkspacesDir(), workspaceRoot);
  if (relativeWorkspacePath !== workspaceKey) {
    throw new Error(`Refusing to delete unowned Xcode IDE workspace: ${workspaceRoot}`);
  }
  return workspaceRoot;
}

function removeOwnedWorkspace(environment: XcodeIdeTestEnvironment): void {
  if (!existsSync(environment.workspaceRoot)) {
    return;
  }
  rmSync(assertOwnedXcodeIdeWorkspaceRoot(environment.workspaceRoot, environment.workspaceKey), {
    recursive: true,
    force: true,
  });
}

async function cleanupXcodeIdeTest(
  harness: WorkflowSnapshotHarness | undefined,
  environment: XcodeIdeTestEnvironment,
  result?: SnapshotResult,
): Promise<void> {
  try {
    if (result !== undefined) {
      removeOwnedArtifact(result, environment);
    }
  } finally {
    try {
      await harness?.cleanup();
    } finally {
      try {
        removeOwnedWorkspace(environment);
      } finally {
        rmSync(environment.cwd, { recursive: true, force: true });
      }
    }
  }
}

function createXcodeIdeTestEnvironment(): XcodeIdeTestEnvironment {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'mobilebuildmcp-xcode-ide-snapshot-')));
  const workspaceKey = workspaceKeyForRoot(cwd);
  const workspaceLayout = getWorkspaceFilesystemLayout(workspaceKey);
  const artifactRoot = join(workspaceLayout.state, 'xcode-ide', 'call-tool');
  return { cwd, artifactRoot, workspaceKey, workspaceRoot: workspaceLayout.root };
}

async function createXcodeIdeHarness(
  runtime: SnapshotRuntime,
  cwd: string,
): Promise<WorkflowSnapshotHarness> {
  return createHarnessForRuntime(runtime, {
    cwd,
    enabledWorkflows: ['xcode-ide'],
    env: XCODE_IDE_ENV,
  });
}

async function waitForXcodeIdeTool(
  harness: WorkflowSnapshotHarness,
  remoteTool: string,
): Promise<void> {
  const deadline = Date.now() + XCODE_IDE_BRIDGE_READY_TIMEOUT_MS;
  do {
    const result = await harness.invoke('xcode-ide', 'list-tools', { refresh: true });
    if (result.outcome === 'success' && result.rawText.includes(remoteTool)) {
      return;
    }
    await delay(XCODE_IDE_BRIDGE_POLL_INTERVAL_MS);
  } while (Date.now() < deadline);

  throw new Error(`Xcode IDE bridge did not expose ${remoteTool} before the readiness timeout.`);
}

export function registerXcodeIdeSnapshotSuite(runtime: SnapshotRuntime): void {
  const expectFixture = createWorkflowResultFixtureMatcher(runtime, 'xcode-ide');

  describe(`${runtime} xcode-ide workflow`, () => {
    describe('list-tools', () => {
      it('success', async (context) => {
        if (!isXcodeIdeBridgeAvailable()) {
          context.skip();
          return;
        }

        const environment = createXcodeIdeTestEnvironment();
        let harness: WorkflowSnapshotHarness | undefined;
        let result: SnapshotResult | undefined;
        try {
          harness = await createXcodeIdeHarness(runtime, environment.cwd);
          result = await harness.invoke('xcode-ide', 'list-tools', { refresh: true });
          expectFixture(result, 'list-tools--success', 'success');
        } finally {
          await cleanupXcodeIdeTest(harness, environment, result);
        }
      }, 120_000);
    });

    describe('documentation-search', () => {
      it('success', async (context) => {
        if (!isXcodeIdeBridgeAvailable()) {
          context.skip();
          return;
        }

        const availableToolNames = await listAvailableXcodeIdeBridgeToolNames();
        if (!availableToolNames.has(DOCUMENTATION_SEARCH_TOOL)) {
          context.skip();
          return;
        }

        const environment = createXcodeIdeTestEnvironment();
        let harness: WorkflowSnapshotHarness | undefined;
        let result: SnapshotResult | undefined;
        try {
          harness = await createXcodeIdeHarness(runtime, environment.cwd);
          await waitForXcodeIdeTool(harness, DOCUMENTATION_SEARCH_TOOL);

          result = await harness.invoke('xcode-ide', 'call-tool', {
            remoteTool: DOCUMENTATION_SEARCH_TOOL,
            arguments: runtime.startsWith('mcp/')
              ? JSON.stringify({
                  query: DOCUMENTATION_SEARCH_QUERY,
                  frameworks: ['AVFoundation'],
                })
              : { query: DOCUMENTATION_SEARCH_QUERY, frameworks: ['AVFoundation'] },
            timeoutMs: 120_000,
          });
          expectFixture(result, 'documentation-search--success', 'success');
        } finally {
          await cleanupXcodeIdeTest(harness, environment, result);
        }
      }, 150_000);
    });
  });
}
