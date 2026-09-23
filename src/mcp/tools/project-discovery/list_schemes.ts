import * as z from 'zod';
import type { ToolHandlerContext } from '../../../rendering/types.ts';
import type { SchemeListDomainResult } from '../../../types/domain-results.ts';
import type { NonStreamingExecutor } from '../../../types/tool-execution.ts';
import { log } from '../../../utils/logging/index.ts';
import type { CommandExecutor } from '../../../utils/execution/index.ts';
import { getDefaultCommandExecutor } from '../../../utils/execution/index.ts';
import {
  createSessionAwareTool,
  getSessionAwareToolSchemaShape,
  getHandlerContext,
  toInternalSchema,
} from '../../../utils/typed-tool-factory.ts';
import { nullifyEmptyStrings, withProjectOrWorkspace } from '../../../utils/schema-helpers.ts';
import { toErrorMessage } from '../../../utils/errors.ts';
import { extractQueryDiagnostics } from '../../../utils/xcodebuild-error-utils.ts';

const baseSchemaObject = z.object({
  projectPath: z.string().optional().describe('Path to the .xcodeproj file'),
  workspacePath: z.string().optional().describe('Path to the .xcworkspace file'),
});

const listSchemesSchema = z.preprocess(
  nullifyEmptyStrings,
  withProjectOrWorkspace(baseSchemaObject),
);

export type ListSchemesParams = z.infer<typeof listSchemesSchema>;
type ListSchemesResult = SchemeListDomainResult;

export function parseSchemesFromXcodebuildListOutput(output: string): string[] {
  const schemesMatch = output.match(/Schemes:([\s\S]*?)(?=\n\n|$)/);
  if (!schemesMatch) {
    throw new Error('No schemes found in the output');
  }

  return schemesMatch[1]
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export async function listSchemes(
  params: ListSchemesParams,
  executor: CommandExecutor,
): Promise<string[]> {
  const command = ['xcodebuild', '-list'];

  if (typeof params.projectPath === 'string') {
    command.push('-project', params.projectPath);
  } else {
    command.push('-workspace', params.workspacePath!);
  }

  const result = await executor(command, 'List Schemes', false);
  if (!result.success) {
    throw new Error(result.error || result.output || 'Unknown error');
  }

  return parseSchemesFromXcodebuildListOutput(result.output);
}

type SchemeListArtifacts = ListSchemesResult['artifacts'];

function buildSchemeListArtifacts(params: ListSchemesParams): SchemeListArtifacts {
  if (params.projectPath) {
    return { projectPath: params.projectPath };
  }
  return { workspacePath: params.workspacePath ?? '' };
}

function createListSchemesResult(
  artifacts: SchemeListArtifacts,
  schemes: string[],
): ListSchemesResult {
  return {
    kind: 'scheme-list',
    didError: false,
    error: null,
    artifacts,
    schemes,
  };
}

function createListSchemesErrorResult(
  artifacts: SchemeListArtifacts,
  message: string,
): ListSchemesResult {
  return {
    kind: 'scheme-list',
    didError: true,
    error: 'Failed to list schemes.',
    artifacts,
    schemes: [],
    diagnostics: extractQueryDiagnostics(message),
  };
}

function setStructuredOutput(ctx: ToolHandlerContext, result: ListSchemesResult): void {
  ctx.structuredOutput = {
    result,
    schema: 'mobilebuildmcp.output.scheme-list',
    schemaVersion: '2',
  };
}

export function createListSchemesExecutor(
  executor: CommandExecutor,
): NonStreamingExecutor<ListSchemesParams, ListSchemesResult> {
  return async (params) => {
    const artifacts = buildSchemeListArtifacts(params);

    try {
      const schemes = await listSchemes(params, executor);
      return createListSchemesResult(artifacts, schemes);
    } catch (error) {
      return createListSchemesErrorResult(artifacts, toErrorMessage(error));
    }
  };
}

export async function listSchemesLogic(
  params: ListSchemesParams,
  executor: CommandExecutor,
): Promise<void> {
  log('info', 'Listing schemes');

  const hasProjectPath = typeof params.projectPath === 'string';
  const projectOrWorkspace = hasProjectPath ? 'project' : 'workspace';
  const pathValue = hasProjectPath ? params.projectPath : params.workspacePath;

  const ctx = getHandlerContext();
  const executeListSchemes = createListSchemesExecutor(executor);
  const result = await executeListSchemes(params);

  setStructuredOutput(ctx, result);

  if (result.didError) {
    log('error', `Error listing schemes: ${result.error ?? 'Unknown error'}`);
  }

  if (result.schemes.length > 0 && !result.didError) {
    const firstScheme = result.schemes[0];

    ctx.nextStepParams = {
      build_macos: { [`${projectOrWorkspace}Path`]: pathValue!, scheme: firstScheme },
      build_run_sim: {
        [`${projectOrWorkspace}Path`]: pathValue!,
        scheme: firstScheme,
        simulatorName: 'iPhone 17',
      },
      build_sim: {
        [`${projectOrWorkspace}Path`]: pathValue!,
        scheme: firstScheme,
        simulatorName: 'iPhone 17',
      },
      show_build_settings: { [`${projectOrWorkspace}Path`]: pathValue!, scheme: firstScheme },
    };
  }
}

export const schema = getSessionAwareToolSchemaShape({
  sessionAware: baseSchemaObject,
  legacy: baseSchemaObject,
});

export const handler = createSessionAwareTool<ListSchemesParams>({
  internalSchema: toInternalSchema<ListSchemesParams>(listSchemesSchema),
  logicFunction: listSchemesLogic,
  getExecutor: getDefaultCommandExecutor,
  requirements: [
    { oneOf: ['projectPath', 'workspacePath'], message: 'Provide a project or workspace' },
  ],
  exclusivePairs: [['projectPath', 'workspacePath']],
});
