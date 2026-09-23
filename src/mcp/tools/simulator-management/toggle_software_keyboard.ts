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
import { sendKeyboardShortcut } from './_keyboard_shortcut.ts';

const toggleSoftwareKeyboardSchema = z.object({
  simulatorId: z.uuid().describe('UUID of the simulator to use (obtained from list_simulators)'),
});

type ToggleSoftwareKeyboardParams = z.infer<typeof toggleSoftwareKeyboardSchema>;
type ToggleSoftwareKeyboardResult = SimulatorActionResultDomainResult;

function createToggleSoftwareKeyboardResult(params: {
  simulatorId: string;
  didError: boolean;
  error?: string;
  diagnosticMessage?: string;
}): ToggleSoftwareKeyboardResult {
  return {
    kind: 'simulator-action-result',
    didError: params.didError,
    error: params.error ?? null,
    summary: {
      status: params.didError ? 'FAILED' : 'SUCCEEDED',
    },
    action: {
      type: 'toggle-software-keyboard',
    },
    ...(params.diagnosticMessage
      ? { diagnostics: createBasicDiagnostics({ errors: [params.diagnosticMessage] }) }
      : {}),
    artifacts: {
      simulatorId: params.simulatorId,
    },
  };
}

function setStructuredOutput(ctx: ToolHandlerContext, result: ToggleSoftwareKeyboardResult): void {
  ctx.structuredOutput = {
    result,
    schema: 'mobilebuildmcp.output.simulator-action-result',
    schemaVersion: '2',
  };
}

export function createToggleSoftwareKeyboardExecutor(
  executor: CommandExecutor,
): NonStreamingExecutor<ToggleSoftwareKeyboardParams, ToggleSoftwareKeyboardResult> {
  return async (params) => {
    try {
      const result = await sendKeyboardShortcut(params.simulatorId, 'software-keyboard', executor);

      if (!result.success) {
        return createToggleSoftwareKeyboardResult({
          simulatorId: params.simulatorId,
          didError: true,
          error: 'Failed to toggle software keyboard.',
          diagnosticMessage: result.error,
        });
      }

      return createToggleSoftwareKeyboardResult({
        simulatorId: params.simulatorId,
        didError: false,
      });
    } catch (error) {
      const diagnosticMessage = toErrorMessage(error);
      return createToggleSoftwareKeyboardResult({
        simulatorId: params.simulatorId,
        didError: true,
        error: 'Failed to toggle software keyboard.',
        diagnosticMessage,
      });
    }
  };
}

export async function toggle_software_keyboardLogic(
  params: ToggleSoftwareKeyboardParams,
  executor: CommandExecutor,
): Promise<void> {
  log('info', `Toggling software keyboard on simulator ${params.simulatorId}`);

  const ctx = getHandlerContext();
  const executeToggleSoftwareKeyboard = createToggleSoftwareKeyboardExecutor(executor);

  const result = await executeToggleSoftwareKeyboard(params);
  setStructuredOutput(ctx, result);

  if (result.didError) {
    log(
      'error',
      `Error toggling software keyboard for simulator ${params.simulatorId}: ${result.error ?? 'Unknown error'}`,
    );
  }
}

const publicSchemaObject = z.strictObject(
  toggleSoftwareKeyboardSchema.omit({ simulatorId: true } as const).shape,
);

export const schema = getSessionAwareToolSchemaShape({
  sessionAware: publicSchemaObject,
  legacy: toggleSoftwareKeyboardSchema,
});

export const handler = createSessionAwareTool<ToggleSoftwareKeyboardParams>({
  internalSchema: toInternalSchema<ToggleSoftwareKeyboardParams>(toggleSoftwareKeyboardSchema),
  logicFunction: toggle_software_keyboardLogic,
  getExecutor: getDefaultCommandExecutor,
  requirements: [{ allOf: ['simulatorId'], message: 'simulatorId is required' }],
});
