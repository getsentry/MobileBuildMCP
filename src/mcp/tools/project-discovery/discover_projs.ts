/**
 * Project Discovery Plugin: Discover Projects
 *
 * Scans a directory (defaults to workspace root) to find Xcode project (.xcodeproj)
 * and workspace (.xcworkspace) files.
 */

import * as z from 'zod';
import * as path from 'node:path';
import type { ToolHandlerContext } from '../../../rendering/types.ts';
import type { ProjectListDomainResult } from '../../../types/domain-results.ts';
import type { NonStreamingExecutor } from '../../../types/tool-execution.ts';
import { log } from '../../../utils/logging/index.ts';
import { getDefaultFileSystemExecutor, getDefaultCommandExecutor } from '../../../utils/command.ts';
import type { FileSystemExecutor } from '../../../utils/FileSystemExecutor.ts';
import { createTypedTool, getHandlerContext } from '../../../utils/typed-tool-factory.ts';
import { createBasicDiagnostics } from '../../../utils/diagnostics.ts';

const DEFAULT_MAX_DEPTH = 3;
const SKIPPED_DIRS = new Set(['build', 'DerivedData', 'Pods', '.git', 'node_modules']);

interface DirentLike {
  name: string;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

function isPathWithin(rootPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return (
    relativePath === '' ||
    (relativePath !== '..' &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath))
  );
}

function getErrorDetails(
  error: unknown,
  fallbackMessage: string,
): { code?: string; message: string } {
  if (error instanceof Error) {
    const nodeError = error as NodeJS.ErrnoException;
    return { code: nodeError.code, message: error.message };
  }

  if (typeof error === 'object' && error !== null) {
    const candidate = error as { code?: unknown; message?: unknown };
    return {
      code: typeof candidate.code === 'string' ? candidate.code : undefined,
      message: typeof candidate.message === 'string' ? candidate.message : fallbackMessage,
    };
  }

  return { message: String(error) };
}

/**
 * Recursively scans directories to find Xcode projects and workspaces.
 */
async function _findProjectsRecursive(
  currentDirAbs: string,
  workspaceRootAbs: string,
  currentDepth: number,
  maxDepth: number,
  results: { projects: string[]; workspaces: string[] },
  fileSystemExecutor: FileSystemExecutor = getDefaultFileSystemExecutor(),
): Promise<void> {
  if (currentDepth >= maxDepth) {
    log('debug', `Max depth ${maxDepth} reached at ${currentDirAbs}, stopping recursion.`);
    return;
  }

  log('debug', `Scanning directory: ${currentDirAbs} at depth ${currentDepth}`);
  try {
    const entries = await fileSystemExecutor.readdir(currentDirAbs, { withFileTypes: true });
    for (const rawEntry of entries) {
      const entry = rawEntry as DirentLike;
      const absoluteEntryPath = path.join(currentDirAbs, entry.name);
      const relativePath = path.relative(workspaceRootAbs, absoluteEntryPath);

      if (entry.isSymbolicLink()) {
        log('debug', `Skipping symbolic link: ${relativePath}`);
        continue;
      }

      if (entry.isDirectory() && SKIPPED_DIRS.has(entry.name)) {
        log('debug', `Skipping standard directory: ${relativePath}`);
        continue;
      }

      if (!isPathWithin(workspaceRootAbs, absoluteEntryPath)) {
        log(
          'warn',
          `Skipping entry outside workspace root: ${absoluteEntryPath} (Workspace: ${workspaceRootAbs})`,
        );
        continue;
      }

      if (entry.isDirectory()) {
        let isXcodeBundle = false;

        if (entry.name.endsWith('.xcodeproj')) {
          results.projects.push(absoluteEntryPath);
          log('debug', `Found project: ${absoluteEntryPath}`);
          isXcodeBundle = true;
        } else if (entry.name.endsWith('.xcworkspace')) {
          results.workspaces.push(absoluteEntryPath);
          log('debug', `Found workspace: ${absoluteEntryPath}`);
          isXcodeBundle = true;
        }

        if (!isXcodeBundle) {
          await _findProjectsRecursive(
            absoluteEntryPath,
            workspaceRootAbs,
            currentDepth + 1,
            maxDepth,
            results,
            fileSystemExecutor,
          );
        }
      }
    }
  } catch (error) {
    const { code, message } = getErrorDetails(error, 'Unknown error');

    if (code === 'EPERM' || code === 'EACCES') {
      log('debug', `Permission denied scanning directory: ${currentDirAbs}`);
    } else {
      log('warn', `Error scanning directory ${currentDirAbs}: ${message} (Code: ${code ?? 'N/A'})`);
    }
  }
}

const discoverProjsSchema = z.object({
  workspaceRoot: z.string(),
  scanPath: z.string().optional(),
  maxDepth: z.number().int().nonnegative().optional(),
});

export interface DiscoverProjectsParams {
  workspaceRoot: string;
  scanPath?: string;
  maxDepth?: number;
}

export interface DiscoverProjectsResult {
  projects: string[];
  workspaces: string[];
}

type DiscoverProjsParams = z.infer<typeof discoverProjsSchema>;
type DiscoverProjsResult = ProjectListDomainResult;

interface DiscoverProjectsExecutionContext {
  workspaceRoot: string;
  scanPath: string;
  maxDepth: number;
}

interface DiscoverProjectsComputation {
  context: DiscoverProjectsExecutionContext;
  result?: DiscoverProjectsResult;
  error?: string;
  diagnosticMessage?: string;
}

function isBundleLikePath(workspaceRoot: string): boolean {
  return (
    workspaceRoot.endsWith('.app') ||
    workspaceRoot.endsWith('.xcworkspace') ||
    workspaceRoot.endsWith('.xcodeproj')
  );
}

async function discoverProjectsOrError(
  params: DiscoverProjectsParams,
  fileSystemExecutor: FileSystemExecutor,
): Promise<DiscoverProjectsComputation> {
  const scanPath = params.scanPath ?? '.';
  const maxDepth = params.maxDepth ?? DEFAULT_MAX_DEPTH;
  const workspaceRoot = params.workspaceRoot;

  const workspaceBoundary = isBundleLikePath(workspaceRoot)
    ? path.dirname(workspaceRoot)
    : workspaceRoot;
  const absoluteWorkspaceBoundary = path.resolve(workspaceBoundary);
  const requestedScanPath = path.resolve(absoluteWorkspaceBoundary, scanPath);
  let absoluteScanPath = requestedScanPath;
  if (!isPathWithin(absoluteWorkspaceBoundary, absoluteScanPath)) {
    log(
      'warn',
      `Requested scan path '${scanPath}' resolved outside workspace root '${workspaceRoot}'. Defaulting scan to workspace root.`,
    );
    absoluteScanPath = absoluteWorkspaceBoundary;
  }

  const context: DiscoverProjectsExecutionContext = {
    workspaceRoot: path.resolve(workspaceRoot),
    scanPath: absoluteScanPath,
    maxDepth,
  };

  log(
    'info',
    `Starting project discovery request: path=${absoluteScanPath}, maxDepth=${maxDepth}, workspace=${workspaceRoot}`,
  );

  try {
    const stats = await fileSystemExecutor.stat(absoluteScanPath);
    if (!stats.isDirectory()) {
      const errorMsg = `Scan path is not a directory: ${absoluteScanPath}`;
      log('error', errorMsg);
      return { context, error: errorMsg, diagnosticMessage: errorMsg };
    }
  } catch (error) {
    const { code, message } = getErrorDetails(error, 'Unknown error accessing scan path');
    const errorMsg = `Failed to access scan path: ${absoluteScanPath}. Error: ${message}`;
    log('error', `${errorMsg} - Code: ${code ?? 'N/A'}`);
    return { context, error: errorMsg, diagnosticMessage: errorMsg };
  }

  const results: DiscoverProjectsResult = { projects: [], workspaces: [] };
  await _findProjectsRecursive(
    absoluteScanPath,
    absoluteWorkspaceBoundary,
    0,
    maxDepth,
    results,
    fileSystemExecutor,
  );

  results.projects.sort();
  results.workspaces.sort();
  return { context, result: results };
}

export async function discoverProjects(
  params: DiscoverProjectsParams,
  fileSystemExecutor: FileSystemExecutor,
): Promise<DiscoverProjectsResult> {
  const computation = await discoverProjectsOrError(params, fileSystemExecutor);
  if (typeof computation.error === 'string' || !computation.result) {
    throw new Error(computation.error ?? 'Failed to discover projects');
  }
  return computation.result;
}

function createDiscoverProjectsResult(
  context: DiscoverProjectsExecutionContext,
  result: DiscoverProjectsResult,
): DiscoverProjsResult {
  return {
    kind: 'project-list',
    didError: false,
    error: null,
    summary: {
      status: 'SUCCEEDED',
      projectCount: result.projects.length,
      workspaceCount: result.workspaces.length,
      maxDepth: context.maxDepth,
    },
    artifacts: {
      workspaceRoot: context.workspaceRoot,
      scanPath: context.scanPath,
    },
    projects: result.projects.map((projectPath) => ({ path: projectPath })),
    workspaces: result.workspaces.map((workspacePath) => ({ path: workspacePath })),
  };
}

function createDiscoverProjectsErrorResult(
  context: DiscoverProjectsExecutionContext,
  message: string,
  diagnosticMessage?: string,
): DiscoverProjsResult {
  return {
    kind: 'project-list',
    didError: true,
    error: 'Failed to discover projects.',
    summary: {
      status: 'FAILED',
      maxDepth: context.maxDepth,
    },
    artifacts: {
      workspaceRoot: context.workspaceRoot,
      scanPath: context.scanPath,
    },
    projects: [],
    workspaces: [],
    diagnostics: createBasicDiagnostics({ errors: [diagnosticMessage ?? message] }),
  };
}

function setStructuredOutput(ctx: ToolHandlerContext, result: DiscoverProjsResult): void {
  ctx.structuredOutput = {
    result,
    schema: 'mobilebuildmcp.output.project-list',
    schemaVersion: '2',
  };
}

export function createDiscoverProjectsExecutor(
  fileSystemExecutor: FileSystemExecutor,
): NonStreamingExecutor<DiscoverProjsParams, DiscoverProjsResult> {
  return async (params) => {
    const computation = await discoverProjectsOrError(params, fileSystemExecutor);
    const context = computation.context;

    if (typeof computation.error === 'string' || !computation.result) {
      return createDiscoverProjectsErrorResult(
        context,
        computation.error ?? 'Failed to discover projects',
        computation.diagnosticMessage,
      );
    }

    const discoveryResult = computation.result;

    return createDiscoverProjectsResult(context, discoveryResult);
  };
}

/**
 * Business logic for discovering projects.
 * Exported for testing purposes.
 */
export async function discover_projsLogic(
  params: DiscoverProjsParams,
  fileSystemExecutor: FileSystemExecutor,
): Promise<void> {
  const ctx = getHandlerContext();
  const executeDiscoverProjects = createDiscoverProjectsExecutor(fileSystemExecutor);
  const result = await executeDiscoverProjects(params);

  setStructuredOutput(ctx, result);

  if (result.didError) {
    log('error', `Error discovering projects: ${result.error ?? 'Unknown error'}`);
  } else {
    log(
      'info',
      `Discovery finished. Found ${result.projects.length} projects and ${result.workspaces.length} workspaces.`,
    );
  }
}

export const schema = discoverProjsSchema.shape;

export const handler = createTypedTool(
  discoverProjsSchema,
  (params: DiscoverProjsParams) => discover_projsLogic(params, getDefaultFileSystemExecutor()),
  getDefaultCommandExecutor,
);
