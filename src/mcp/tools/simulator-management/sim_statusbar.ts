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

const simStatusbarSchema = z.object({
  simulatorId: z.uuid().describe('UUID of the simulator to use (obtained from list_simulators)'),
  dataNetwork: z
    .enum([
      'clear',
      'hide',
      'wifi',
      '3g',
      '4g',
      'lte',
      'lte-a',
      'lte+',
      '5g',
      '5g+',
      '5g-uwb',
      '5g-uc',
    ])
    .describe('clear|hide|wifi|3g|4g|lte|lte-a|lte+|5g|5g+|5g-uwb|5g-uc'),
});

type SimStatusbarParams = z.infer<typeof simStatusbarSchema>;
type SimStatusbarResult = SimulatorActionResultDomainResult;

function createSimStatusbarResult(params: {
  simulatorId: string;
  dataNetwork: SimStatusbarParams['dataNetwork'];
  didError: boolean;
  error?: string;
  diagnosticMessage?: string;
}): SimStatusbarResult {
  return {
    kind: 'simulator-action-result',
    didError: params.didError,
    error: params.error ?? null,
    summary: {
      status: params.didError ? 'FAILED' : 'SUCCEEDED',
    },
    action: {
      type: 'statusbar',
      dataNetwork: params.dataNetwork,
    },
    ...(params.diagnosticMessage
      ? { diagnostics: createBasicDiagnostics({ errors: [params.diagnosticMessage] }) }
      : {}),
    artifacts: {
      simulatorId: params.simulatorId,
    },
  };
}

function setStructuredOutput(ctx: ToolHandlerContext, result: SimStatusbarResult): void {
  ctx.structuredOutput = {
    result,
    schema: 'mobilebuildmcp.output.simulator-action-result',
    schemaVersion: '2',
  };
}

export function createSimStatusbarExecutor(
  executor: CommandExecutor,
): NonStreamingExecutor<SimStatusbarParams, SimStatusbarResult> {
  return async (params) => {
    try {
      const command =
        params.dataNetwork === 'clear'
          ? ['xcrun', 'simctl', 'status_bar', params.simulatorId, 'clear']
          : [
              'xcrun',
              'simctl',
              'status_bar',
              params.simulatorId,
              'override',
              '--dataNetwork',
              params.dataNetwork,
            ];

      const result = await executor(command, 'Set Status Bar', false);

      if (!result.success) {
        const diagnosticMessage = result.error ?? 'Unknown error';
        return createSimStatusbarResult({
          simulatorId: params.simulatorId,
          dataNetwork: params.dataNetwork,
          didError: true,
          error: 'Failed to set status bar.',
          diagnosticMessage,
        });
      }

      return createSimStatusbarResult({
        simulatorId: params.simulatorId,
        dataNetwork: params.dataNetwork,
        didError: false,
      });
    } catch (error) {
      const diagnosticMessage = toErrorMessage(error);
      return createSimStatusbarResult({
        simulatorId: params.simulatorId,
        dataNetwork: params.dataNetwork,
        didError: true,
        error: 'Failed to set status bar.',
        diagnosticMessage,
      });
    }
  };
}

export async function sim_statusbarLogic(
  params: SimStatusbarParams,
  executor: CommandExecutor,
): Promise<void> {
  log(
    'info',
    `Setting simulator ${params.simulatorId} status bar data network to ${params.dataNetwork}`,
  );

  const ctx = getHandlerContext();
  const executeSimStatusbar = createSimStatusbarExecutor(executor);

  const result = await executeSimStatusbar(params);
  setStructuredOutput(ctx, result);

  if (result.didError) {
    log(
      'error',
      `Error setting status bar for simulator ${params.simulatorId}: ${result.error ?? 'Unknown error'}`,
    );
    return;
  }

  const successMsg =
    params.dataNetwork === 'clear'
      ? 'Status bar overrides cleared'
      : 'Status bar data network set successfully';

  log('info', `${successMsg} (simulator: ${params.simulatorId})`);
}

const publicSchemaObject = z.strictObject(
  simStatusbarSchema.omit({ simulatorId: true } as const).shape,
);

export const schema = getSessionAwareToolSchemaShape({
  sessionAware: publicSchemaObject,
  legacy: simStatusbarSchema,
});

export const handler = createSessionAwareTool<SimStatusbarParams>({
  internalSchema: toInternalSchema<SimStatusbarParams>(simStatusbarSchema),
  logicFunction: sim_statusbarLogic,
  getExecutor: getDefaultCommandExecutor,
  requirements: [{ allOf: ['simulatorId'], message: 'simulatorId is required' }],
});
