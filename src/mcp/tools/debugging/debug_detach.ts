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

const debugDetachSchema = z.object({
  debugSessionId: z.string().optional().describe('default: current session'),
});

export type DebugDetachParams = z.infer<typeof debugDetachSchema>;
type DebugDetachResult = DebugSessionActionDomainResult;

function createDebugDetachResult(params: {
  didError: boolean;
  error?: string;
  diagnosticMessage?: string;
  debugSessionId?: string;
}): DebugDetachResult {
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
    action: 'detach',
    ...(params.debugSessionId
      ? {
          session: {
            debugSessionId: params.debugSessionId,
            connectionState: 'detached',
          },
        }
      : {}),
  };
}

function setStructuredOutput(ctx: ToolHandlerContext, result: DebugDetachResult): void {
  ctx.structuredOutput = {
    result,
    schema: 'mobilebuildmcp.output.debug-session-action',
    schemaVersion: '2',
  };
}

export function createDebugDetachExecutor(
  debuggerManager: DebuggerToolContext['debugger'],
): NonStreamingExecutor<DebugDetachParams, DebugDetachResult> {
  return async (params) => {
    const targetId = params.debugSessionId ?? debuggerManager.getCurrentSessionId() ?? undefined;

    try {
      await debuggerManager.detachSession(targetId);
      return createDebugDetachResult({
        didError: false,
        debugSessionId: targetId,
      });
    } catch (error) {
      const diagnosticMessage = toErrorMessage(error);
      return createDebugDetachResult({
        didError: true,
        error: 'Failed to detach debugger.',
        diagnosticMessage,
      });
    }
  };
}

export async function debug_detachLogic(
  params: DebugDetachParams,
  ctx: DebuggerToolContext,
): Promise<void> {
  const handlerCtx = getHandlerContext();
  const executeDebugDetach = createDebugDetachExecutor(ctx.debugger);
  const result = await executeDebugDetach(params);

  setStructuredOutput(handlerCtx, result);
}

export const schema = debugDetachSchema.shape;

export const handler = createTypedToolWithContext<DebugDetachParams, DebuggerToolContext>(
  debugDetachSchema,
  debug_detachLogic,
  getDefaultDebuggerToolContext,
);
