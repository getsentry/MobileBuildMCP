import * as z from 'zod';
import type { ToolHandlerContext } from '../../../rendering/types.ts';
import type { DebugBreakpointResultDomainResult } from '../../../types/domain-results.ts';
import type { NonStreamingExecutor } from '../../../types/tool-execution.ts';
import { createBasicDiagnostics } from '../../../utils/diagnostics.ts';
import { toErrorMessage } from '../../../utils/errors.ts';
import { nullifyEmptyStrings } from '../../../utils/schema-helpers.ts';
import {
  createTypedToolWithContext,
  getHandlerContext,
  toInternalSchema,
} from '../../../utils/typed-tool-factory.ts';
import {
  getDefaultDebuggerToolContext,
  type DebuggerToolContext,
  type BreakpointSpec,
} from '../../../utils/debugger/index.ts';

const baseSchemaObject = z.object({
  debugSessionId: z.string().optional().describe('default: current session'),
  file: z.string().optional(),
  line: z.number().int().positive().optional(),
  function: z.string().optional(),
  condition: z.string().optional().describe('Expression for breakpoint condition'),
});

const debugBreakpointAddSchema = z.preprocess(
  nullifyEmptyStrings,
  baseSchemaObject
    .refine((val) => !(val.file && val.function), {
      message: 'Provide either file/line or function, not both.',
    })
    .refine((val) => Boolean(val.function ?? (val.file && val.line !== undefined)), {
      message: 'Provide file + line or function.',
    })
    .refine((val) => !(val.line && !val.file), {
      message: 'file is required when line is provided.',
    }),
);

export type DebugBreakpointAddParams = z.infer<typeof debugBreakpointAddSchema>;
type DebugBreakpointAddResult = DebugBreakpointResultDomainResult;

function createBreakpointSpec(params: DebugBreakpointAddParams): BreakpointSpec {
  return params.function
    ? { kind: 'function', name: params.function }
    : { kind: 'file-line', file: params.file!, line: params.line! };
}

function createDebugBreakpointAddResult(params: {
  didError: boolean;
  error?: string;
  diagnosticMessage?: string;
  breakpoint: BreakpointSpec;
  breakpointId?: number;
}): DebugBreakpointAddResult {
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
    action: 'add',
    breakpoint:
      params.breakpoint.kind === 'function'
        ? {
            ...(typeof params.breakpointId === 'number'
              ? { breakpointId: params.breakpointId }
              : {}),
            kind: 'function',
            name: params.breakpoint.name,
          }
        : {
            ...(typeof params.breakpointId === 'number'
              ? { breakpointId: params.breakpointId }
              : {}),
            kind: 'file-line',
            file: params.breakpoint.file,
            line: params.breakpoint.line,
          },
  };
}

function setStructuredOutput(ctx: ToolHandlerContext, result: DebugBreakpointAddResult): void {
  ctx.structuredOutput = {
    result,
    schema: 'mobilebuildmcp.output.debug-breakpoint-result',
    schemaVersion: '2',
  };
}

export function createDebugBreakpointAddExecutor(
  debuggerManager: DebuggerToolContext['debugger'],
): NonStreamingExecutor<DebugBreakpointAddParams, DebugBreakpointAddResult> {
  return async (params) => {
    const spec = createBreakpointSpec(params);

    try {
      const result = await debuggerManager.addBreakpoint(params.debugSessionId, spec, {
        condition: params.condition,
      });

      return createDebugBreakpointAddResult({
        didError: false,
        breakpoint: spec,
        breakpointId: result.id,
      });
    } catch (error) {
      const diagnosticMessage = toErrorMessage(error);
      return createDebugBreakpointAddResult({
        didError: true,
        error: 'Failed to add breakpoint.',
        diagnosticMessage,
        breakpoint: spec,
      });
    }
  };
}

export async function debug_breakpoint_addLogic(
  params: DebugBreakpointAddParams,
  ctx: DebuggerToolContext,
): Promise<void> {
  const handlerCtx = getHandlerContext();
  const executeDebugBreakpointAdd = createDebugBreakpointAddExecutor(ctx.debugger);
  const result = await executeDebugBreakpointAdd(params);

  setStructuredOutput(handlerCtx, result);
}

export const schema = baseSchemaObject.shape;

export const handler = createTypedToolWithContext<DebugBreakpointAddParams, DebuggerToolContext>(
  toInternalSchema<DebugBreakpointAddParams>(debugBreakpointAddSchema),
  debug_breakpoint_addLogic,
  getDefaultDebuggerToolContext,
);
