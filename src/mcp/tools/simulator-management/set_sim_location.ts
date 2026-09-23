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

const setSimulatorLocationSchema = z.object({
  simulatorId: z.uuid().describe('UUID of the simulator to use (obtained from list_simulators)'),
  latitude: z.number(),
  longitude: z.number(),
});

type SetSimulatorLocationParams = z.infer<typeof setSimulatorLocationSchema>;
type SetSimulatorLocationResult = SimulatorActionResultDomainResult;

function createSetSimulatorLocationResult(params: {
  simulatorId: string;
  latitude: number;
  longitude: number;
  didError: boolean;
  error?: string;
  diagnosticMessage?: string;
}): SetSimulatorLocationResult {
  return {
    kind: 'simulator-action-result',
    didError: params.didError,
    error: params.error ?? null,
    summary: {
      status: params.didError ? 'FAILED' : 'SUCCEEDED',
    },
    action: {
      type: 'set-location',
      coordinates: {
        latitude: params.latitude,
        longitude: params.longitude,
      },
    },
    ...(params.diagnosticMessage
      ? { diagnostics: createBasicDiagnostics({ errors: [params.diagnosticMessage] }) }
      : {}),
    artifacts: {
      simulatorId: params.simulatorId,
    },
  };
}

function setStructuredOutput(ctx: ToolHandlerContext, result: SetSimulatorLocationResult): void {
  ctx.structuredOutput = {
    result,
    schema: 'mobilebuildmcp.output.simulator-action-result',
    schemaVersion: '2',
  };
}

export function createSetSimulatorLocationExecutor(
  executor: CommandExecutor,
): NonStreamingExecutor<SetSimulatorLocationParams, SetSimulatorLocationResult> {
  return async (params) => {
    const coords = `${params.latitude},${params.longitude}`;

    if (params.latitude < -90 || params.latitude > 90) {
      return createSetSimulatorLocationResult({
        simulatorId: params.simulatorId,
        latitude: params.latitude,
        longitude: params.longitude,
        didError: true,
        error: 'Latitude must be between -90 and 90 degrees',
        diagnosticMessage: 'Latitude must be between -90 and 90 degrees',
      });
    }

    if (params.longitude < -180 || params.longitude > 180) {
      return createSetSimulatorLocationResult({
        simulatorId: params.simulatorId,
        latitude: params.latitude,
        longitude: params.longitude,
        didError: true,
        error: 'Longitude must be between -180 and 180 degrees',
        diagnosticMessage: 'Longitude must be between -180 and 180 degrees',
      });
    }

    try {
      const result = await executor(
        ['xcrun', 'simctl', 'location', params.simulatorId, 'set', coords],
        'Set Simulator Location',
        false,
      );

      if (!result.success) {
        const diagnosticMessage = result.error ?? 'Unknown error';
        return createSetSimulatorLocationResult({
          simulatorId: params.simulatorId,
          latitude: params.latitude,
          longitude: params.longitude,
          didError: true,
          error: 'Failed to set simulator location.',
          diagnosticMessage,
        });
      }

      return createSetSimulatorLocationResult({
        simulatorId: params.simulatorId,
        latitude: params.latitude,
        longitude: params.longitude,
        didError: false,
      });
    } catch (error) {
      const diagnosticMessage = toErrorMessage(error);
      return createSetSimulatorLocationResult({
        simulatorId: params.simulatorId,
        latitude: params.latitude,
        longitude: params.longitude,
        didError: true,
        error: 'Failed to set simulator location.',
        diagnosticMessage,
      });
    }
  };
}

export async function set_sim_locationLogic(
  params: SetSimulatorLocationParams,
  executor: CommandExecutor,
): Promise<void> {
  const coords = `${params.latitude},${params.longitude}`;

  const ctx = getHandlerContext();
  const executeSetSimulatorLocation = createSetSimulatorLocationExecutor(executor);

  const result = await executeSetSimulatorLocation(params);
  setStructuredOutput(ctx, result);

  if (result.didError) {
    if (result.error === 'Failed to set simulator location.') {
      log(
        'error',
        `Error during set simulator location for simulator ${params.simulatorId}: ${result.error}`,
      );
    }
    return;
  }

  log('info', `Set simulator ${params.simulatorId} location to ${coords}`);
}

const publicSchemaObject = z.strictObject(
  setSimulatorLocationSchema.omit({ simulatorId: true } as const).shape,
);

export const schema = getSessionAwareToolSchemaShape({
  sessionAware: publicSchemaObject,
  legacy: setSimulatorLocationSchema,
});

export const handler = createSessionAwareTool<SetSimulatorLocationParams>({
  internalSchema: toInternalSchema<SetSimulatorLocationParams>(setSimulatorLocationSchema),
  logicFunction: set_sim_locationLogic,
  getExecutor: getDefaultCommandExecutor,
  requirements: [{ allOf: ['simulatorId'], message: 'simulatorId is required' }],
});
