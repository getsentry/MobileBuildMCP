import * as z from 'zod';
import type { ToolHandlerContext } from '../../../rendering/types.ts';
import type { DebugBreakpointResultDomainResult } from '../../../types/domain-results.ts';
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

const debugBreakpointRemoveSchema = z.object({
  debugSessionId: z.string().optional().describe('default: current session'),
  breakpointId: z.number().int().positive(),
});

export type DebugBreakpointRemoveParams = z.infer<typeof debugBreakpointRemoveSchema>;
type DebugBreakpointRemoveResult = DebugBreakpointResultDomainResult;

function createDebugBreakpointRemoveResult(params: {
  didError: boolean;
  error?: string;
  diagnosticMessage?: string;
  breakpointId: number;
}): DebugBreakpointRemoveResult {
  return {
    kind: 'debug-breakpoint-result',
    didError: params.didError,
    error: params.error ?? null,
    ...(params.didError
      ? {
          diagnostics: createBasicDiagnostics({
            errors: [params.diagnosticMessage ?? params.error ?? 'Unknown error'],
          }),
        }
      : {}),
    action: 'remove',
    breakpoint: {
      breakpointId: params.breakpointId,
    },
  };
}

function setStructuredOutput(ctx: ToolHandlerContext, result: DebugBreakpointRemoveResult): void {
  ctx.structuredOutput = {
    result,
    schema: 'mobilebuildmcp.output.debug-breakpoint-result',
    schemaVersion: '2',
  };
}

export function createDebugBreakpointRemoveExecutor(
  debuggerManager: DebuggerToolContext['debugger'],
): NonStreamingExecutor<DebugBreakpointRemoveParams, DebugBreakpointRemoveResult> {
  return async (params) => {
    try {
      await debuggerManager.removeBreakpoint(params.debugSessionId, params.breakpointId);
      return createDebugBreakpointRemoveResult({
        didError: false,
        breakpointId: params.breakpointId,
      });
    } catch (error) {
      const diagnosticMessage = toErrorMessage(error);
      return createDebugBreakpointRemoveResult({
        didError: true,
        error: 'Failed to remove breakpoint.',
        diagnosticMessage,
        breakpointId: params.breakpointId,
      });
    }
  };
}

export async function debug_breakpoint_removeLogic(
  params: DebugBreakpointRemoveParams,
  ctx: DebuggerToolContext,
): Promise<void> {
  const handlerCtx = getHandlerContext();
  const executeDebugBreakpointRemove = createDebugBreakpointRemoveExecutor(ctx.debugger);
  const result = await executeDebugBreakpointRemove(params);

  setStructuredOutput(handlerCtx, result);
}

export const schema = debugBreakpointRemoveSchema.shape;

export const handler = createTypedToolWithContext<DebugBreakpointRemoveParams, DebuggerToolContext>(
  debugBreakpointRemoveSchema,
  debug_breakpoint_removeLogic,
  getDefaultDebuggerToolContext,
);
