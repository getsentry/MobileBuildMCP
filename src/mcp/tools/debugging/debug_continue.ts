import * as z from 'zod';
import type { ToolHandlerContext } from '../../../rendering/types.ts';
import type { DebugSessionActionDomainResult } from '../../../types/domain-results.ts';
import type { NonStreamingExecutor } from '../../../types/tool-execution.ts';
import { createBasicDiagnostics } from '../../../utils/diagnostics.ts';
import { toErrorMessage } from '../../../utils/errors.ts';
import {
  createTypedToolWithContext,
  getHandlerContext,
} from '../../../utils/typed-tool-factory.ts';
import {
  getDefaultDebuggerToolContext,
  type DebuggerToolContext,
} from '../../../utils/debugger/index.ts';

const debugContinueSchema = z.object({
  debugSessionId: z.string().optional().describe('default: current session'),
});

export type DebugContinueParams = z.infer<typeof debugContinueSchema>;
type DebugContinueResult = DebugSessionActionDomainResult;

function createDebugContinueResult(params: {
  didError: boolean;
  error?: string;
  diagnosticMessage?: string;
  debugSessionId?: string;
}): DebugContinueResult {
  return {
    kind: 'debug-session-action',
    didError: params.didError,
    error: params.error ?? null,
    ...(params.didError
      ? {
          diagnostics: createBasicDiagnostics({
            errors: [params.diagnosticMessage ?? params.error ?? 'Unknown error'],
          }),
        }
      : {}),
    action: 'continue',
    ...(params.debugSessionId
      ? {
          session: {
            debugSessionId: params.debugSessionId,
            connectionState: 'attached',
            executionState: 'running',
          },
        }
      : {}),
  };
}

function setStructuredOutput(ctx: ToolHandlerContext, result: DebugContinueResult): void {
  ctx.structuredOutput = {
    result,
    schema: 'mobilebuildmcp.output.debug-session-action',
    schemaVersion: '2',
  };
}

export function createDebugContinueExecutor(
  debuggerManager: DebuggerToolContext['debugger'],
): NonStreamingExecutor<DebugContinueParams, DebugContinueResult> {
  return async (params) => {
    const targetId = params.debugSessionId ?? debuggerManager.getCurrentSessionId() ?? undefined;

    try {
      await debuggerManager.resumeSession(targetId);
      return createDebugContinueResult({
        didError: false,
        debugSessionId: targetId ?? debuggerManager.getCurrentSessionId() ?? undefined,
      });
    } catch (error) {
      const diagnosticMessage = toErrorMessage(error);
      return createDebugContinueResult({
        didError: true,
        error: 'Failed to resume debugger.',
        diagnosticMessage,
      });
    }
  };
}

export async function debug_continueLogic(
  params: DebugContinueParams,
  ctx: DebuggerToolContext,
): Promise<void> {
  const handlerCtx = getHandlerContext();
  const executeDebugContinue = createDebugContinueExecutor(ctx.debugger);
  const result = await executeDebugContinue(params);

  setStructuredOutput(handlerCtx, result);
}

export const schema = debugContinueSchema.shape;

export const handler = createTypedToolWithContext<DebugContinueParams, DebuggerToolContext>(
  debugContinueSchema,
  debug_continueLogic,
  getDefaultDebuggerToolContext,
);
