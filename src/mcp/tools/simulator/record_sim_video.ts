import { dirname } from 'node:path';
import * as z from 'zod';
import type { ToolHandlerContext } from '../../../rendering/types.ts';
import type { CaptureResultDomainResult } from '../../../types/domain-results.ts';
import type { NonStreamingExecutor } from '../../../types/tool-execution.ts';
import {
  getDefaultCommandExecutor,
  getDefaultFileSystemExecutor,
} from '../../../utils/execution/index.ts';
import type { CommandExecutor, FileSystemExecutor } from '../../../utils/execution/index.ts';
import {
  areAxeToolsAvailable,
  isAxeAtLeastVersion,
  AXE_NOT_AVAILABLE_MESSAGE,
} from '../../../utils/axe/index.ts';
import {
  startSimulatorVideoCapture,
  stopSimulatorVideoCapture,
} from '../../../utils/video-capture/index.ts';
import {
  createSessionAwareTool,
  getSessionAwareToolSchemaShape,
  getHandlerContext,
  toInternalSchema,
} from '../../../utils/typed-tool-factory.ts';
import { createBasicDiagnostics } from '../../../utils/diagnostics.ts';

// Base schema object (used for MCP schema exposure)
const recordSimVideoSchemaObject = z.object({
  simulatorId: z
    .uuid({ message: 'Invalid Simulator UUID format' })
    .describe('UUID of the simulator to record'),
  start: z.boolean().optional(),
  stop: z.boolean().optional(),
  fps: z.number().int().min(1).max(120).optional().describe('default: 30'),
  outputFile: z.string().optional().describe('Path to write MP4 file'),
});

// Schema enforcing mutually exclusive start/stop and requiring outputFile on stop
const recordSimVideoSchema = recordSimVideoSchemaObject
  .refine(
    (v) => {
      const s = v.start === true ? 1 : 0;
      const t = v.stop === true ? 1 : 0;
      return s + t === 1;
    },
    {
      message:
        'Provide exactly one of start=true or stop=true; these options are mutually exclusive',
      path: ['start'],
    },
  )
  .refine((v) => (v.stop ? typeof v.outputFile === 'string' && v.outputFile.length > 0 : true), {
    message: 'outputFile is required when stop=true',
    path: ['outputFile'],
  });

type RecordSimVideoParams = z.infer<typeof recordSimVideoSchema>;
type RecordSimVideoResult = CaptureResultDomainResult;
type VideoRecordingCapture = {
  type: 'video-recording';
  state: 'started' | 'stopped';
  fps?: number;
  outputFile?: string;
  sessionId?: string;
};

function createRecordSimVideoResult(params: {
  simulatorId: string;
  didError: boolean;
  error?: string;
  diagnosticsMessage?: string;
  capture?: VideoRecordingCapture;
}): RecordSimVideoResult {
  return {
    kind: 'capture-result',
    didError: params.didError,
    error: params.error ?? null,
    summary: {
      status: params.didError ? 'FAILED' : 'SUCCEEDED',
    },
    artifacts: {
      simulatorId: params.simulatorId,
    },
    ...(params.capture ? { capture: params.capture } : {}),
    ...(params.diagnosticsMessage
      ? { diagnostics: createBasicDiagnostics({ errors: [params.diagnosticsMessage] }) }
      : {}),
  } as RecordSimVideoResult;
}

function setStructuredOutput(ctx: ToolHandlerContext, result: RecordSimVideoResult): void {
  ctx.structuredOutput = {
    result,
    schema: 'mobilebuildmcp.output.capture-result',
    schemaVersion: '2',
  };
}

export function createRecordSimVideoExecutor(
  executor: CommandExecutor,
  axe: {
    areAxeToolsAvailable(): boolean;
    isAxeAtLeastVersion(v: string, e: CommandExecutor): Promise<boolean>;
  },
  video: {
    startSimulatorVideoCapture: typeof startSimulatorVideoCapture;
    stopSimulatorVideoCapture: typeof stopSimulatorVideoCapture;
  },
  fs: FileSystemExecutor,
): NonStreamingExecutor<RecordSimVideoParams, RecordSimVideoResult> {
  return async (params) => {
    if (!axe.areAxeToolsAvailable()) {
      return createRecordSimVideoResult({
        simulatorId: params.simulatorId,
        didError: true,
        error: AXE_NOT_AVAILABLE_MESSAGE,
        diagnosticsMessage: AXE_NOT_AVAILABLE_MESSAGE,
      });
    }

    const hasVersion = await axe.isAxeAtLeastVersion('1.1.0', executor);
    if (!hasVersion) {
      const message =
        'AXe v1.1.0 or newer is required for simulator video capture. Please update bundled AXe artifacts.';
      return createRecordSimVideoResult({
        simulatorId: params.simulatorId,
        didError: true,
        error: message,
        diagnosticsMessage: message,
      });
    }

    if (params.start) {
      const fpsUsed = params.fps ?? 30;
      const startRes = await video.startSimulatorVideoCapture(
        { simulatorUuid: params.simulatorId, fps: fpsUsed },
        executor,
      );

      if (!startRes.started) {
        return createRecordSimVideoResult({
          simulatorId: params.simulatorId,
          didError: true,
          error: 'Failed to start video recording.',
          diagnosticsMessage: startRes.error ?? 'Unknown error',
        });
      }

      return createRecordSimVideoResult({
        simulatorId: params.simulatorId,
        didError: false,
        capture: {
          type: 'video-recording',
          state: 'started',
          fps: fpsUsed,
          sessionId: startRes.sessionId,
        },
      });
    }

    const stopRes = await video.stopSimulatorVideoCapture(
      { simulatorUuid: params.simulatorId },
      executor,
    );

    if (!stopRes.stopped) {
      return createRecordSimVideoResult({
        simulatorId: params.simulatorId,
        didError: true,
        error: 'Failed to stop video recording.',
        diagnosticsMessage: stopRes.error ?? 'Unknown error',
      });
    }

    try {
      if (params.outputFile) {
        if (!stopRes.parsedPath) {
          const diagnosticMessage = `Recording stopped but could not determine the recorded file path from AXe output. Raw output: ${stopRes.stdout ?? '(no output captured)'}`;
          return createRecordSimVideoResult({
            simulatorId: params.simulatorId,
            didError: true,
            error: 'Recording stopped but could not determine the recorded file path.',
            diagnosticsMessage: diagnosticMessage,
          });
        }

        await fs.mkdir(dirname(params.outputFile), { recursive: true });
        await fs.cp(stopRes.parsedPath, params.outputFile);
        try {
          await fs.rm(stopRes.parsedPath, { recursive: false });
        } catch {
          // Ignore cleanup failure
        }
      }
    } catch (error) {
      const diagnosticMessage = error instanceof Error ? error.message : String(error);
      return createRecordSimVideoResult({
        simulatorId: params.simulatorId,
        didError: true,
        error: 'Recording stopped but failed to save the video file.',
        diagnosticsMessage: diagnosticMessage,
      });
    }

    return createRecordSimVideoResult({
      simulatorId: params.simulatorId,
      didError: false,
      capture: {
        type: 'video-recording',
        state: 'stopped',
        outputFile: params.outputFile ?? stopRes.parsedPath,
      },
    });
  };
}

export async function record_sim_videoLogic(
  params: RecordSimVideoParams,
  executor: CommandExecutor,
  axe: {
    areAxeToolsAvailable(): boolean;
    isAxeAtLeastVersion(v: string, e: CommandExecutor): Promise<boolean>;
  } = {
    areAxeToolsAvailable,
    isAxeAtLeastVersion,
  },
  video: {
    startSimulatorVideoCapture: typeof startSimulatorVideoCapture;
    stopSimulatorVideoCapture: typeof stopSimulatorVideoCapture;
  } = {
    startSimulatorVideoCapture,
    stopSimulatorVideoCapture,
  },
  fs: FileSystemExecutor = getDefaultFileSystemExecutor(),
): Promise<void> {
  const ctx = getHandlerContext();
  const executeRecordSimVideo = createRecordSimVideoExecutor(executor, axe, video, fs);
  const result = await executeRecordSimVideo(params);

  setStructuredOutput(ctx, result);
  if (result.didError) {
    return;
  }

  if (params.start) {
    ctx.nextStepParams = {
      record_sim_video: {
        simulatorId: params.simulatorId,
        stop: true,
        outputFile: '/path/to/output.mp4',
      },
    };
    return;
  }
}

const publicSchemaObject = z.strictObject(
  recordSimVideoSchemaObject.omit({ simulatorId: true } as const).shape,
);

export const schema = getSessionAwareToolSchemaShape({
  sessionAware: publicSchemaObject,
  legacy: recordSimVideoSchemaObject,
});

export const handler = createSessionAwareTool<RecordSimVideoParams>({
  internalSchema: toInternalSchema<RecordSimVideoParams>(recordSimVideoSchema),
  logicFunction: record_sim_videoLogic,
  getExecutor: getDefaultCommandExecutor,
  requirements: [{ allOf: ['simulatorId'], message: 'simulatorId is required' }],
});
