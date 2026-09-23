import * as z from 'zod';
import type { ToolHandlerContext } from '../../../rendering/types.ts';
import type { SimulatorActionResultDomainResult } from '../../../types/domain-results.ts';
import type { NonStreamingExecutor } from '../../../types/tool-execution.ts';
import { log } from '../../../utils/logging/index.ts';
import type { CommandExecutor } from '../../../utils/execution/index.ts';
import { getDefaultCommandExecutor } from '../../../utils/execution/index.ts';
import { createTypedTool, getHandlerContext } from '../../../utils/typed-tool-factory.ts';
import { toErrorMessage } from '../../../utils/errors.ts';
import { createBasicDiagnostics } from '../../../utils/diagnostics.ts';
import { openSimulatorFrontend } from '../../../utils/focus-policy.ts';

const openSimSchema = z.object({});

type OpenSimParams = z.infer<typeof openSimSchema>;
type OpenSimResult = SimulatorActionResultDomainResult;

function createOpenSimResult(params: {
  didError: boolean;
  error?: string;
  diagnosticMessage?: string;
}): OpenSimResult {
  return {
    kind: 'simulator-action-result',
    didError: params.didError,
    error: params.error ?? null,
    summary: {
      status: params.didError ? 'FAILED' : 'SUCCEEDED',
    },
    action: {
      type: 'open',
    },
    ...(params.diagnosticMessage
      ? { diagnostics: createBasicDiagnostics({ errors: [params.diagnosticMessage] }) }
      : {}),
  };
}

function setStructuredOutput(ctx: ToolHandlerContext, result: OpenSimResult): void {
  ctx.structuredOutput = {
    result,
    schema: 'mobilebuildmcp.output.simulator-action-result',
    schemaVersion: '2',
  };
}

export function createOpenSimExecutor(
  executor: CommandExecutor,
): NonStreamingExecutor<OpenSimParams, OpenSimResult> {
  return async (_params) => {
    try {
      const result = await openSimulatorFrontend(executor);

      if (!result.success) {
        return createOpenSimResult({
          didError: true,
          error: 'Open simulator operation failed.',
          diagnosticMessage: result.error,
        });
      }

      return createOpenSimResult({ didError: false });
    } catch (error) {
      const diagnosticMessage = toErrorMessage(error);
      return createOpenSimResult({
        didError: true,
        error: 'Open simulator operation failed.',
        diagnosticMessage,
      });
    }
  };
}

export async function open_simLogic(
  _params: OpenSimParams,
  executor: CommandExecutor,
): Promise<void> {
  log('info', 'Starting open simulator request');

  const ctx = getHandlerContext();
  const executeOpenSim = createOpenSimExecutor(executor);
  const result = await executeOpenSim(_params);
  setStructuredOutput(ctx, result);

  if (result.didError) {
    log('error', `Error during open simulator operation: ${result.error ?? 'Unknown error'}`);
    return;
  }

  ctx.nextStepParams = {
    boot_sim: { simulatorId: 'UUID_FROM_LIST_SIMS' },
  };
}

export const schema = openSimSchema.shape;

export const handler = createTypedTool(openSimSchema, open_simLogic, getDefaultCommandExecutor);
