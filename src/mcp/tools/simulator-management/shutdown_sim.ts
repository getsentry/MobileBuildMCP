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
import { determineSimulatorUuid } from '../../../utils/simulator-utils.ts';
import { toErrorMessage } from '../../../utils/errors.ts';
import { createBasicDiagnostics } from '../../../utils/diagnostics.ts';

const baseSchemaObject = z.object({
  simulatorId: z
    .string()
    .optional()
    .describe(
      'UUID of the simulator to use (obtained from list_sims). Provide EITHER this OR simulatorName, not both',
    ),
  simulatorName: z
    .string()
    .optional()
    .describe(
      "Name of the simulator (e.g., 'iPhone 17'). Provide EITHER this OR simulatorId, not both",
    ),
});

const internalSchemaObject = z.object({
  simulatorId: z.string().optional(),
  simulatorName: z.string().optional(),
});

type ShutdownSimParams = z.infer<typeof internalSchemaObject>;
type ResolvedShutdownSimParams = ShutdownSimParams & { simulatorId: string };
type ShutdownSimResult = SimulatorActionResultDomainResult;

const publicSchemaObject = z.strictObject(
  baseSchemaObject.omit({
    simulatorId: true,
    simulatorName: true,
  } as const).shape,
);

function createShutdownSimResult(params: {
  simulatorId?: string;
  didError: boolean;
  error?: string;
  diagnosticMessage?: string;
}): ShutdownSimResult {
  return {
    kind: 'simulator-action-result',
    didError: params.didError,
    error: params.error ?? null,
    summary: {
      status: params.didError ? 'FAILED' : 'SUCCEEDED',
    },
    action: {
      type: 'shutdown',
    },
    ...(params.diagnosticMessage
      ? { diagnostics: createBasicDiagnostics({ errors: [params.diagnosticMessage] }) }
      : {}),
    ...(params.simulatorId
      ? {
          artifacts: {
            simulatorId: params.simulatorId,
          },
        }
      : {}),
  };
}

function setStructuredOutput(ctx: ToolHandlerContext, result: ShutdownSimResult): void {
  ctx.structuredOutput = {
    result,
    schema: 'mobilebuildmcp.output.simulator-action-result',
    schemaVersion: '3',
  };
}

export function createShutdownSimExecutor(
  executor: CommandExecutor,
): NonStreamingExecutor<ResolvedShutdownSimParams, ShutdownSimResult> {
  return async (params) => {
    try {
      const result = await executor(
        ['xcrun', 'simctl', 'shutdown', params.simulatorId],
        'Shut Down Simulator',
        false,
      );

      if (!result.success) {
        const diagnosticMessage = result.error ?? 'Unknown error';
        return createShutdownSimResult({
          simulatorId: params.simulatorId,
          didError: true,
          error: 'Shut down simulator operation failed.',
          diagnosticMessage,
        });
      }

      return createShutdownSimResult({
        simulatorId: params.simulatorId,
        didError: false,
      });
    } catch (error) {
      const diagnosticMessage = toErrorMessage(error);
      return createShutdownSimResult({
        simulatorId: params.simulatorId,
        didError: true,
        error: 'Shut down simulator operation failed.',
        diagnosticMessage,
      });
    }
  };
}

export async function shutdown_simLogic(
  params: ShutdownSimParams,
  executor: CommandExecutor,
): Promise<void> {
  const ctx = getHandlerContext();
  const simulatorResult = await determineSimulatorUuid(params, executor);
  if (simulatorResult.error || !simulatorResult.uuid) {
    const result = createShutdownSimResult({
      didError: true,
      error: 'Shut down simulator operation failed.',
      diagnosticMessage: `Failed to resolve simulator: ${simulatorResult.error ?? 'No simulator UUID returned'}`,
    });
    setStructuredOutput(ctx, result);
    log('error', `Error during shut down simulator operation: ${result.error ?? 'Unknown error'}`);
    return;
  }

  if (simulatorResult.warning) {
    log('warn', simulatorResult.warning);
  }

  const resolvedParams: ResolvedShutdownSimParams = {
    ...params,
    simulatorId: simulatorResult.uuid,
  };
  log('info', `Starting xcrun simctl shutdown request for simulator ${resolvedParams.simulatorId}`);

  const executeShutdownSim = createShutdownSimExecutor(executor);
  const result = await executeShutdownSim(resolvedParams);
  setStructuredOutput(ctx, result);

  if (result.didError) {
    log('error', `Error during shut down simulator operation: ${result.error ?? 'Unknown error'}`);
  }
}

export const schema = getSessionAwareToolSchemaShape({
  sessionAware: publicSchemaObject,
  legacy: baseSchemaObject,
});

export const handler = createSessionAwareTool<ShutdownSimParams>({
  internalSchema: toInternalSchema<ShutdownSimParams>(internalSchemaObject),
  logicFunction: shutdown_simLogic,
  getExecutor: getDefaultCommandExecutor,
  requirements: [
    { oneOf: ['simulatorId', 'simulatorName'], message: 'Provide simulatorId or simulatorName' },
  ],
  exclusivePairs: [['simulatorId', 'simulatorName']],
});
