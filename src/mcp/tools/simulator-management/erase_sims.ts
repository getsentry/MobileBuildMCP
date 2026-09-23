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

const eraseSimsSchema = z
  .object({
    simulatorId: z.uuid().describe('UDID of the simulator to erase.'),
    shutdownFirst: z.boolean().optional(),
  })
  .passthrough();

type EraseSimsParams = z.infer<typeof eraseSimsSchema>;
type EraseSimsResult = SimulatorActionResultDomainResult;

function createEraseSimsResult(params: {
  simulatorId: string;
  didError: boolean;
  error?: string;
  diagnosticMessage?: string;
}): EraseSimsResult {
  return {
    kind: 'simulator-action-result',
    didError: params.didError,
    error: params.error ?? null,
    summary: {
      status: params.didError ? 'FAILED' : 'SUCCEEDED',
    },
    action: {
      type: 'erase',
    },
    ...(params.diagnosticMessage
      ? { diagnostics: createBasicDiagnostics({ errors: [params.diagnosticMessage] }) }
      : {}),
    artifacts: {
      simulatorId: params.simulatorId,
    },
  };
}

function setStructuredOutput(ctx: ToolHandlerContext, result: EraseSimsResult): void {
  ctx.structuredOutput = {
    result,
    schema: 'mobilebuildmcp.output.simulator-action-result',
    schemaVersion: '2',
  };
}

export function createEraseSimsExecutor(
  executor: CommandExecutor,
): NonStreamingExecutor<EraseSimsParams, EraseSimsResult> {
  return async (params) => {
    const simulatorId = params.simulatorId;

    try {
      if (params.shutdownFirst) {
        try {
          await executor(
            ['xcrun', 'simctl', 'shutdown', simulatorId],
            'Shutdown Simulator',
            true,
            undefined,
          );
        } catch {
          // ignore shutdown errors; proceed to erase attempt
        }
      }

      const result = await executor(
        ['xcrun', 'simctl', 'erase', simulatorId],
        'Erase Simulator',
        true,
        undefined,
      );

      if (!result.success) {
        const diagnosticMessage = result.error ?? 'Unknown error';
        return createEraseSimsResult({
          simulatorId,
          didError: true,
          error: 'Failed to erase simulator.',
          diagnosticMessage,
        });
      }

      return createEraseSimsResult({
        simulatorId,
        didError: false,
      });
    } catch (error) {
      const diagnosticMessage = toErrorMessage(error);
      return createEraseSimsResult({
        simulatorId,
        didError: true,
        error: 'Failed to erase simulator.',
        diagnosticMessage,
      });
    }
  };
}

export async function erase_simsLogic(
  params: EraseSimsParams,
  executor: CommandExecutor,
): Promise<void> {
  const simulatorId = params.simulatorId;

  const ctx = getHandlerContext();
  const executeEraseSims = createEraseSimsExecutor(executor);

  log(
    'info',
    `Erasing simulator ${simulatorId}${params.shutdownFirst ? ' (shutdownFirst=true)' : ''}`,
  );

  const result = await executeEraseSims(params);
  setStructuredOutput(ctx, result);

  if (result.didError) {
    log('error', `Error erasing simulators: ${result.error ?? 'Unknown error'}`);
  }
}

const publicSchemaObject = eraseSimsSchema.omit({ simulatorId: true } as const).passthrough();

export const schema = getSessionAwareToolSchemaShape({
  sessionAware: publicSchemaObject,
  legacy: eraseSimsSchema,
});

export const handler = createSessionAwareTool<EraseSimsParams>({
  internalSchema: toInternalSchema<EraseSimsParams>(eraseSimsSchema),
  logicFunction: erase_simsLogic,
  getExecutor: getDefaultCommandExecutor,
  requirements: [{ allOf: ['simulatorId'], message: 'simulatorId is required' }],
});
