import * as z from 'zod';
import type { ToolHandlerContext } from '../../../rendering/types.ts';
import type { SimulatorActionResultDomainResult } from '../../../types/domain-results.ts';
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
import { toErrorMessage } from '../../../utils/errors.ts';
import { createBasicDiagnostics } from '../../../utils/diagnostics.ts';

const resetSimulatorLocationSchema = z.object({
  simulatorId: z.uuid().describe('UUID of the simulator to use (obtained from list_simulators)'),
});

type ResetSimulatorLocationParams = z.infer<typeof resetSimulatorLocationSchema>;
type ResetSimulatorLocationResult = SimulatorActionResultDomainResult;

function createResetSimulatorLocationResult(params: {
  simulatorId: string;
  didError: boolean;
  error?: string;
  diagnosticMessage?: string;
}): ResetSimulatorLocationResult {
  return {
    kind: 'simulator-action-result',
    didError: params.didError,
    error: params.error ?? null,
    summary: {
      status: params.didError ? 'FAILED' : 'SUCCEEDED',
    },
    action: {
      type: 'reset-location',
    },
    ...(params.diagnosticMessage
      ? { diagnostics: createBasicDiagnostics({ errors: [params.diagnosticMessage] }) }
      : {}),
    artifacts: {
      simulatorId: params.simulatorId,
    },
  };
}

function setStructuredOutput(ctx: ToolHandlerContext, result: ResetSimulatorLocationResult): void {
  ctx.structuredOutput = {
    result,
    schema: 'mobilebuildmcp.output.simulator-action-result',
    schemaVersion: '2',
  };
}

export function createResetSimulatorLocationExecutor(
  executor: CommandExecutor,
): NonStreamingExecutor<ResetSimulatorLocationParams, ResetSimulatorLocationResult> {
  return async (params) => {
    try {
      const result = await executor(
        ['xcrun', 'simctl', 'location', params.simulatorId, 'clear'],
        'Reset Simulator Location',
        false,
      );

      if (!result.success) {
        const diagnosticMessage = result.error ?? 'Unknown error';
        return createResetSimulatorLocationResult({
          simulatorId: params.simulatorId,
          didError: true,
          error: 'Failed to reset simulator location.',
          diagnosticMessage,
        });
      }

      return createResetSimulatorLocationResult({
        simulatorId: params.simulatorId,
        didError: false,
      });
    } catch (error) {
      const diagnosticMessage = toErrorMessage(error);
      return createResetSimulatorLocationResult({
        simulatorId: params.simulatorId,
        didError: true,
        error: 'Failed to reset simulator location.',
        diagnosticMessage,
      });
    }
  };
}

export async function reset_sim_locationLogic(
  params: ResetSimulatorLocationParams,
  executor: CommandExecutor,
): Promise<void> {
  log('info', `Resetting simulator ${params.simulatorId} location`);

  const ctx = getHandlerContext();
  const executeResetSimulatorLocation = createResetSimulatorLocationExecutor(executor);

  const result = await executeResetSimulatorLocation(params);
  setStructuredOutput(ctx, result);

  if (result.didError) {
    log(
      'error',
      `Error during reset simulator location for simulator ${params.simulatorId}: ${result.error ?? 'Unknown error'}`,
    );
    return;
  }

  log('info', `Reset simulator ${params.simulatorId} location`);
}

const publicSchemaObject = z.strictObject(
  resetSimulatorLocationSchema.omit({ simulatorId: true } as const).shape,
);

export const schema = getSessionAwareToolSchemaShape({
  sessionAware: publicSchemaObject,
  legacy: resetSimulatorLocationSchema,
});

export const handler = createSessionAwareTool<ResetSimulatorLocationParams>({
  internalSchema: toInternalSchema<ResetSimulatorLocationParams>(resetSimulatorLocationSchema),
  logicFunction: reset_sim_locationLogic,
  getExecutor: getDefaultCommandExecutor,
  requirements: [{ allOf: ['simulatorId'], message: 'simulatorId is required' }],
});
