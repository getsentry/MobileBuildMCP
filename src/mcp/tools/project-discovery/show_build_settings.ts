import * as z from 'zod';
import type { ToolHandlerContext } from '../../../rendering/types.ts';
import type { BuildSettingsDomainResult } from '../../../types/domain-results.ts';
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
  scheme: z.string().describe('Scheme name to show build settings for (Required)'),
});

const showBuildSettingsSchema = z.preprocess(
  nullifyEmptyStrings,
  withProjectOrWorkspace(baseSchemaObject),
);

export type ShowBuildSettingsParams = z.infer<typeof showBuildSettingsSchema>;
type ShowBuildSettingsResult = BuildSettingsDomainResult;

function stripXcodebuildPreamble(output: string): string {
  const lines = output.split('\n');
  const startIndex = lines.findIndex((line) => line.startsWith('Build settings for action'));
  if (startIndex === -1) {
    return output;
  }
  return lines.slice(startIndex).join('\n');
}

function parseBuildSettingsEntries(output: string): Array<{ key: string; value: string }> {
  return output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const match = line.match(/^\s*([^=]+?)\s*=(.*)$/);
      if (match) {
        const entry = {
          key: match[1].trim(),
          value: match[2].trim(),
        };
        Object.defineProperties(entry, {
          __hasEquals: { value: true, enumerable: false },
          __renderValue: { value: match[2], enumerable: false },
        });
        return entry;
      }

      const entry = {
        key: line.trim(),
        value: '',
      };
      Object.defineProperties(entry, {
        __hasEquals: { value: false, enumerable: false },
        __renderValue: { value: '', enumerable: false },
      });
      return entry;
    });
}

function createShowBuildSettingsResult(
  pathValue: string,
  scheme: string,
  settingsOutput: string,
): ShowBuildSettingsResult {
  return {
    kind: 'build-settings',
    didError: false,
    error: null,
    artifacts: {
      workspacePath: pathValue,
      scheme,
    },
    entries: parseBuildSettingsEntries(settingsOutput),
  };
}

function createShowBuildSettingsErrorResult(
  pathValue: string,
  scheme: string,
  message: string,
): ShowBuildSettingsResult {
  return {
    kind: 'build-settings',
    didError: true,
    error: 'Failed to show build settings.',
    artifacts: {
      workspacePath: pathValue,
      scheme,
    },
    entries: [],
    diagnostics: extractQueryDiagnostics(message),
  };
}

function setStructuredOutput(ctx: ToolHandlerContext, result: ShowBuildSettingsResult): void {
  ctx.structuredOutput = {
    result,
    schema: 'mobilebuildmcp.output.build-settings',
    schemaVersion: '2',
  };
}

export function createShowBuildSettingsExecutor(
  executor: CommandExecutor,
): NonStreamingExecutor<ShowBuildSettingsParams, ShowBuildSettingsResult> {
  return async (params) => {
    const hasProjectPath = typeof params.projectPath === 'string';
    const pathValue = hasProjectPath ? params.projectPath! : params.workspacePath!;

    try {
      const command = ['xcodebuild', '-showBuildSettings'];

      if (hasProjectPath) {
        command.push('-project', params.projectPath!);
      } else {
        command.push('-workspace', params.workspacePath!);
      }

      command.push('-scheme', params.scheme);

      const result = await executor(command, 'Show Build Settings', false);
      if (!result.success) {
        return createShowBuildSettingsErrorResult(
          pathValue,
          params.scheme,
          result.error || result.output || 'Unknown error',
        );
      }

      const settingsOutput = stripXcodebuildPreamble(
        result.output || 'Build settings retrieved successfully.',
      );

      return createShowBuildSettingsResult(pathValue, params.scheme, settingsOutput);
    } catch (error) {
      return createShowBuildSettingsErrorResult(pathValue, params.scheme, toErrorMessage(error));
    }
  };
}

export async function showBuildSettingsLogic(
  params: ShowBuildSettingsParams,
  executor: CommandExecutor,
): Promise<void> {
  log('info', `Showing build settings for scheme ${params.scheme}`);

  const hasProjectPath = typeof params.projectPath === 'string';
  const pathValue = hasProjectPath ? params.projectPath : params.workspacePath;

  const ctx = getHandlerContext();
  const executeShowBuildSettings = createShowBuildSettingsExecutor(executor);
  const result = await executeShowBuildSettings(params);

  setStructuredOutput(ctx, result);

  if (result.didError) {
    log('error', `Error showing build settings: ${result.error ?? 'Unknown error'}`);
  }

  if (!result.didError) {
    const pathKey = hasProjectPath ? 'projectPath' : 'workspacePath';
    ctx.nextStepParams = {
      build_macos: { [pathKey]: pathValue!, scheme: params.scheme },
      build_sim: { [pathKey]: pathValue!, scheme: params.scheme, simulatorName: 'iPhone 17' },
      list_schemes: { [pathKey]: pathValue! },
    };
  }
}

const publicSchemaObject = baseSchemaObject.omit({
  projectPath: true,
  workspacePath: true,
  scheme: true,
} as const);

export const schema = getSessionAwareToolSchemaShape({
  sessionAware: publicSchemaObject,
  legacy: baseSchemaObject,
});

export const handler = createSessionAwareTool<ShowBuildSettingsParams>({
  internalSchema: toInternalSchema<ShowBuildSettingsParams>(showBuildSettingsSchema),
  logicFunction: showBuildSettingsLogic,
  getExecutor: getDefaultCommandExecutor,
  requirements: [
    { allOf: ['scheme'], message: 'scheme is required' },
    { oneOf: ['projectPath', 'workspacePath'], message: 'Provide a project or workspace' },
  ],
  exclusivePairs: [['projectPath', 'workspacePath']],
});
