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

const setSimAppearanceSchema = z.object({
  simulatorId: z.uuid().describe('UUID of the simulator to use (obtained from list_simulators)'),
  mode: z.enum(['dark', 'light']).describe('dark|light'),
});

type SetSimAppearanceParams = z.infer<typeof setSimAppearanceSchema>;
type SetSimAppearanceResult = SimulatorActionResultDomainResult;

function createSetSimAppearanceResult(params: {
  simulatorId: string;
  mode: SetSimAppearanceParams['mode'];
  didError: boolean;
  error?: string;
  diagnosticMessage?: string;
}): SetSimAppearanceResult {
  return {
    kind: 'simulator-action-result',
    didError: params.didError,
    error: params.error ?? null,
    summary: {
      status: params.didError ? 'FAILED' : 'SUCCEEDED',
    },
    action: {
      type: 'set-appearance',
      appearance: params.mode,
    },
    ...(params.diagnosticMessage
      ? { diagnostics: createBasicDiagnostics({ errors: [params.diagnosticMessage] }) }
      : {}),
    artifacts: {
      simulatorId: params.simulatorId,
    },
  };
}

function setStructuredOutput(ctx: ToolHandlerContext, result: SetSimAppearanceResult): void {
  ctx.structuredOutput = {
    result,
    schema: 'mobilebuildmcp.output.simulator-action-result',
    schemaVersion: '2',
  };
}

export function createSetSimAppearanceExecutor(
  executor: CommandExecutor,
): NonStreamingExecutor<SetSimAppearanceParams, SetSimAppearanceResult> {
  return async (params) => {
    try {
      const result = await executor(
        ['xcrun', 'simctl', 'ui', params.simulatorId, 'appearance', params.mode],
        'Set Simulator Appearance',
        false,
      );

      if (!result.success) {
        const diagnosticMessage = result.error ?? 'Unknown error';
        return createSetSimAppearanceResult({
          simulatorId: params.simulatorId,
          mode: params.mode,
          didError: true,
          error: 'Failed to set simulator appearance.',
          diagnosticMessage,
        });
      }

      return createSetSimAppearanceResult({
        simulatorId: params.simulatorId,
        mode: params.mode,
        didError: false,
      });
    } catch (error) {
      const diagnosticMessage = toErrorMessage(error);
      return createSetSimAppearanceResult({
        simulatorId: params.simulatorId,
        mode: params.mode,
        didError: true,
        error: 'Failed to set simulator appearance.',
        diagnosticMessage,
      });
    }
  };
}

export async function set_sim_appearanceLogic(
  params: SetSimAppearanceParams,
  executor: CommandExecutor,
): Promise<void> {
  log('info', `Setting simulator ${params.simulatorId} appearance to ${params.mode} mode`);

  const ctx = getHandlerContext();
  const executeSetSimAppearance = createSetSimAppearanceExecutor(executor);

  const result = await executeSetSimAppearance(params);
  setStructuredOutput(ctx, result);

  if (result.didError) {
    log(
      'error',
      `Error during set simulator appearance for simulator ${params.simulatorId}: ${result.error ?? 'Unknown error'}`,
    );
    return;
  }

  log('info', `Set simulator ${params.simulatorId} appearance to ${params.mode} mode`);
}

const publicSchemaObject = z.strictObject(
  setSimAppearanceSchema.omit({ simulatorId: true } as const).shape,
);

export const schema = getSessionAwareToolSchemaShape({
  sessionAware: publicSchemaObject,
  legacy: setSimAppearanceSchema,
});

export const handler = createSessionAwareTool<SetSimAppearanceParams>({
  internalSchema: toInternalSchema<SetSimAppearanceParams>(setSimAppearanceSchema),
  logicFunction: set_sim_appearanceLogic,
  getExecutor: getDefaultCommandExecutor,
  requirements: [{ allOf: ['simulatorId'], message: 'simulatorId is required' }],
});
