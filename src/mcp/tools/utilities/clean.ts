import * as z from 'zod';
import type {
  BasicDiagnostics,
  BuildResultArtifacts,
  ToolDomainResultBase,
} from '../../../types/domain-results.ts';
import type { NonStreamingExecutor } from '../../../types/tool-execution.ts';
import {
  createSessionAwareTool,
  getSessionAwareToolSchemaShape,
  getHandlerContext,
  toInternalSchema,
} from '../../../utils/typed-tool-factory.ts';
import type { CommandExecutor } from '../../../utils/execution/index.ts';
import { getDefaultCommandExecutor } from '../../../utils/execution/index.ts';
import { XcodePlatform } from '../../../types/common.ts';
import { executeXcodeBuildCommand } from '../../../utils/build/index.ts';
import { nullifyEmptyStrings, withProjectOrWorkspace } from '../../../utils/schema-helpers.ts';
import { toErrorMessage } from '../../../utils/errors.ts';
import { createBasicDiagnostics } from '../../../utils/diagnostics.ts';

const baseOptions = {
  scheme: z.string().optional().describe('Optional: The scheme to clean'),
  configuration: z
    .string()
    .optional()
    .describe('Optional: Build configuration to clean (Debug, Release, etc.)'),
  derivedDataPath: z.string().optional(),
  extraArgs: z.array(z.string()).optional(),
  preferXcodebuild: z.boolean().optional(),
  platform: z
    .enum([
      'macOS',
      'iOS',
      'iOS Simulator',
      'watchOS',
      'watchOS Simulator',
      'tvOS',
      'tvOS Simulator',
      'visionOS',
      'visionOS Simulator',
    ])
    .optional(),
};

const baseSchemaObject = z.object({
  projectPath: z.string().optional().describe('Path to the .xcodeproj file'),
  workspacePath: z.string().optional().describe('Path to the .xcworkspace file'),
  ...baseOptions,
});

const cleanSchema = z.preprocess(
  nullifyEmptyStrings,
  withProjectOrWorkspace(baseSchemaObject).refine((val) => !(val.workspacePath && !val.scheme), {
    message: 'scheme is required when workspacePath is provided.',
    path: ['scheme'],
  }),
);

export type CleanParams = z.infer<typeof cleanSchema>;
type CleanResult = ToolDomainResultBase & {
  kind: 'build-result';
  summary: {
    status: 'SUCCEEDED' | 'FAILED';
  };
  artifacts: BuildResultArtifacts;
  diagnostics: BasicDiagnostics;
};

const STRUCTURED_OUTPUT_SCHEMA = 'mobilebuildmcp.output.build-result';

const PLATFORM_MAP: Record<string, XcodePlatform> = {
  macOS: XcodePlatform.macOS,
  iOS: XcodePlatform.iOS,
  'iOS Simulator': XcodePlatform.iOSSimulator,
  watchOS: XcodePlatform.watchOS,
  'watchOS Simulator': XcodePlatform.watchOSSimulator,
  tvOS: XcodePlatform.tvOS,
  'tvOS Simulator': XcodePlatform.tvOSSimulator,
  visionOS: XcodePlatform.visionOS,
  'visionOS Simulator': XcodePlatform.visionOSSimulator,
};

const SIMULATOR_TO_DEVICE_PLATFORM: Partial<Record<XcodePlatform, XcodePlatform>> = {
  [XcodePlatform.iOSSimulator]: XcodePlatform.iOS,
  [XcodePlatform.watchOSSimulator]: XcodePlatform.watchOS,
  [XcodePlatform.tvOSSimulator]: XcodePlatform.tvOS,
  [XcodePlatform.visionOSSimulator]: XcodePlatform.visionOS,
};

function createCleanArtifacts(
  params: CleanParams,
  configuration: string | undefined,
  platform: XcodePlatform,
): CleanResult['artifacts'] {
  return {
    ...(params.workspacePath ? { workspacePath: params.workspacePath } : {}),
    ...(params.scheme ? { scheme: params.scheme } : {}),
    ...(configuration ? { configuration } : {}),
    platform: String(platform),
  };
}

const STDERR_NOISE_PATTERNS: readonly RegExp[] = [
  /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+\s+\S+\[\d+:\d+\]/u,
  /^Command line invocation:$/u,
  /^Build settings from command line:$/u,
];

function extractStderrErrorLines(stderrChunks: string[]): string[] {
  if (stderrChunks.length === 0) {
    return [];
  }
  return stderrChunks
    .join('')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !STDERR_NOISE_PATTERNS.some((pattern) => pattern.test(line)));
}

function createCleanResult(
  params: CleanParams,
  status: CleanResult['summary']['status'],
  diagnostics: CleanResult['diagnostics'],
  error: string | null,
  options?: {
    configuration?: string;
    cleanPlatform?: XcodePlatform;
  },
): CleanResult {
  const cleanPlatform = options?.cleanPlatform ?? resolveCleanPlatform(params) ?? XcodePlatform.iOS;
  const configuration = options?.configuration ?? params.configuration;

  return {
    kind: 'build-result',
    didError: status === 'FAILED',
    error,
    summary: { status },
    artifacts: createCleanArtifacts(params, configuration, cleanPlatform),
    diagnostics,
  };
}

function resolveCleanPlatform(params: CleanParams): XcodePlatform | null {
  const targetPlatform = params.platform ?? 'iOS';
  const platformEnum = PLATFORM_MAP[targetPlatform];
  if (!platformEnum) {
    return null;
  }
  return SIMULATOR_TO_DEVICE_PLATFORM[platformEnum] ?? platformEnum;
}

export function createCleanExecutor(
  executor: CommandExecutor,
): NonStreamingExecutor<CleanParams, CleanResult> {
  return async (params) => {
    if (params.workspacePath && !params.scheme) {
      const message = 'scheme is required when workspacePath is provided.';
      return createCleanResult(
        params,
        'FAILED',
        {
          warnings: [],
          errors: [{ message }],
        },
        message,
      );
    }

    const cleanPlatform = resolveCleanPlatform(params);
    if (!cleanPlatform) {
      const message = `Unsupported platform: "${params.platform ?? 'iOS'}".`;
      return createCleanResult(
        params,
        'FAILED',
        {
          warnings: [],
          errors: [{ message }],
        },
        message,
      );
    }

    const configuration = params.configuration;
    const stderrChunks: string[] = [];

    try {
      const response = await executeXcodeBuildCommand(
        {
          projectPath: params.projectPath,
          workspacePath: params.workspacePath,
          scheme: params.scheme ?? '',
          configuration,
          derivedDataPath: params.derivedDataPath,
          extraArgs: params.extraArgs,
        },
        {
          platform: cleanPlatform,
          logPrefix: 'Clean',
        },
        params.preferXcodebuild ?? false,
        'clean',
        executor,
        {
          onStderr: (chunk) => {
            stderrChunks.push(chunk);
          },
        },
      );

      const didError = response.isError === true;
      const stderrLines = extractStderrErrorLines(stderrChunks);

      const diagnostics = createBasicDiagnostics({
        errors: didError ? (stderrLines.length > 0 ? stderrLines : ['Unknown error']) : [],
      });

      return createCleanResult(
        params,
        didError ? 'FAILED' : 'SUCCEEDED',
        diagnostics,
        didError ? 'Clean failed.' : null,
        {
          configuration,
          cleanPlatform,
        },
      );
    } catch (error) {
      const diagnosticMessage = toErrorMessage(error);
      return createCleanResult(
        params,
        'FAILED',
        createBasicDiagnostics({ errors: [diagnosticMessage] }),
        'Clean failed.',
        {
          configuration,
          cleanPlatform,
        },
      );
    }
  };
}

export async function cleanLogic(params: CleanParams, executor: CommandExecutor): Promise<void> {
  const ctx = getHandlerContext();
  const executeClean = createCleanExecutor(executor);
  const result = await executeClean(params);

  ctx.structuredOutput = { result, schema: STRUCTURED_OUTPUT_SCHEMA, schemaVersion: '2' };
}

const publicSchemaObject = baseSchemaObject.omit({
  projectPath: true,
  workspacePath: true,
  scheme: true,
  configuration: true,
  derivedDataPath: true,
  preferXcodebuild: true,
} as const);

export const schema = getSessionAwareToolSchemaShape({
  sessionAware: publicSchemaObject,
  legacy: baseSchemaObject,
});

export const handler = createSessionAwareTool<CleanParams>({
  internalSchema: toInternalSchema<CleanParams>(cleanSchema),
  logicFunction: cleanLogic,
  getExecutor: getDefaultCommandExecutor,
  requirements: [
    { oneOf: ['projectPath', 'workspacePath'], message: 'Provide a project or workspace' },
  ],
  exclusivePairs: [['projectPath', 'workspacePath']],
});
