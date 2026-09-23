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

const toggleConnectHardwareKeyboardSchema = z.object({
  simulatorId: z.uuid().describe('UUID of the simulator to use (obtained from list_simulators)'),
});

type ToggleConnectHardwareKeyboardParams = z.infer<typeof toggleConnectHardwareKeyboardSchema>;
type ToggleConnectHardwareKeyboardResult = SimulatorActionResultDomainResult;

function createToggleConnectHardwareKeyboardResult(params: {
  simulatorId: string;
  didError: boolean;
  error?: string;
  diagnosticMessage?: string;
}): ToggleConnectHardwareKeyboardResult {
  return {
    kind: 'simulator-action-result',
    didError: params.didError,
    error: params.error ?? null,
    summary: {
      status: params.didError ? 'FAILED' : 'SUCCEEDED',
    },
    action: {
      type: 'toggle-connect-hardware-keyboard',
    },
    ...(params.diagnosticMessage
      ? { diagnostics: createBasicDiagnostics({ errors: [params.diagnosticMessage] }) }
      : {}),
    artifacts: {
      simulatorId: params.simulatorId,
    },
  };
}

function setStructuredOutput(
  ctx: ToolHandlerContext,
  result: ToggleConnectHardwareKeyboardResult,
): void {
  ctx.structuredOutput = {
    result,
    schema: 'mobilebuildmcp.output.simulator-action-result',
    schemaVersion: '2',
  };
}

export function createToggleConnectHardwareKeyboardExecutor(
  executor: CommandExecutor,
): NonStreamingExecutor<ToggleConnectHardwareKeyboardParams, ToggleConnectHardwareKeyboardResult> {
  return async (params) => {
    try {
      const result = await sendKeyboardShortcut(
        params.simulatorId,
        'connect-hardware-keyboard',
        executor,
      );

      if (!result.success) {
        return createToggleConnectHardwareKeyboardResult({
          simulatorId: params.simulatorId,
          didError: true,
          error: 'Failed to toggle hardware keyboard.',
          diagnosticMessage: result.error,
        });
      }

      return createToggleConnectHardwareKeyboardResult({
        simulatorId: params.simulatorId,
        didError: false,
      });
    } catch (error) {
      const diagnosticMessage = toErrorMessage(error);
      return createToggleConnectHardwareKeyboardResult({
        simulatorId: params.simulatorId,
        didError: true,
        error: 'Failed to toggle hardware keyboard.',
        diagnosticMessage,
      });
    }
  };
}

export async function toggle_connect_hardware_keyboardLogic(
  params: ToggleConnectHardwareKeyboardParams,
  executor: CommandExecutor,
): Promise<void> {
  log('info', `Toggling hardware keyboard connection on simulator ${params.simulatorId}`);

  const ctx = getHandlerContext();
  const executeToggleConnectHardwareKeyboard =
    createToggleConnectHardwareKeyboardExecutor(executor);

  const result = await executeToggleConnectHardwareKeyboard(params);
  setStructuredOutput(ctx, result);

  if (result.didError) {
    log(
      'error',
      `Error toggling hardware keyboard for simulator ${params.simulatorId}: ${result.error ?? 'Unknown error'}`,
    );
  }
}

const publicSchemaObject = z.strictObject(
  toggleConnectHardwareKeyboardSchema.omit({ simulatorId: true } as const).shape,
);

export const schema = getSessionAwareToolSchemaShape({
  sessionAware: publicSchemaObject,
  legacy: toggleConnectHardwareKeyboardSchema,
});

export const handler = createSessionAwareTool<ToggleConnectHardwareKeyboardParams>({
  internalSchema: toInternalSchema<ToggleConnectHardwareKeyboardParams>(
    toggleConnectHardwareKeyboardSchema,
  ),
  logicFunction: toggle_connect_hardware_keyboardLogic,
  getExecutor: getDefaultCommandExecutor,
  requirements: [{ allOf: ['simulatorId'], message: 'simulatorId is required' }],
});
