import * as z from 'zod';
import type { ToolHandlerContext } from '../../../rendering/types.ts';
import type { DebugCommandResultDomainResult } from '../../../types/domain-results.ts';
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
} from '../../../utils/debugger/index.ts';

const baseSchemaObject = z.object({
  debugSessionId: z.string().optional().describe('default: current session'),
  command: z.string(),
  timeoutMs: z.number().int().positive().optional(),
});

const debugLldbCommandSchema = z.preprocess(nullifyEmptyStrings, baseSchemaObject);

export type DebugLldbCommandParams = z.infer<typeof debugLldbCommandSchema>;
type DebugLldbCommandResult = DebugCommandResultDomainResult;

function createDebugCommandResult(params: {
  command: string;
  didError: boolean;
  error?: string;
  diagnosticMessage?: string;
  outputLines?: string[];
}): DebugLldbCommandResult {
  return {
    kind: 'debug-command-result',
    didError: params.didError,
    error: params.error ?? null,
    ...(params.didError
      ? {
          diagnostics: createBasicDiagnostics({
            errors: [params.diagnosticMessage ?? params.error ?? 'Unknown error'],
          }),
        }
      : {}),
    command: params.command,
    outputLines: params.outputLines ?? [],
  };
}

function setStructuredOutput(ctx: ToolHandlerContext, result: DebugLldbCommandResult): void {
  ctx.structuredOutput = {
    result,
    schema: 'mobilebuildmcp.output.debug-command-result',
    schemaVersion: '2',
  };
}

function splitOutputLines(output: string): string[] {
  const trimmed = output.trim();
  return trimmed.length > 0 ? trimmed.split('\n') : [];
}

export function createDebugLldbCommandExecutor(
  debuggerManager: DebuggerToolContext['debugger'],
): NonStreamingExecutor<DebugLldbCommandParams, DebugLldbCommandResult> {
  return async (params) => {
    try {
      const output = await debuggerManager.runCommand(params.debugSessionId, params.command, {
        timeoutMs: params.timeoutMs,
      });

      return createDebugCommandResult({
        command: params.command,
        didError: false,
        outputLines: splitOutputLines(output),
      });
    } catch (error) {
      const diagnosticMessage = toErrorMessage(error);
      return createDebugCommandResult({
        command: params.command,
        didError: true,
        error: 'Failed to run LLDB command.',
        diagnosticMessage,
      });
    }
  };
}

export async function debug_lldb_commandLogic(
  params: DebugLldbCommandParams,
  ctx: DebuggerToolContext,
): Promise<void> {
  const handlerCtx = getHandlerContext();
  const executeDebugLldbCommand = createDebugLldbCommandExecutor(ctx.debugger);
  const result = await executeDebugLldbCommand(params);

  setStructuredOutput(handlerCtx, result);
}

export const schema = baseSchemaObject.shape;

export const handler = createTypedToolWithContext<DebugLldbCommandParams, DebuggerToolContext>(
  toInternalSchema<DebugLldbCommandParams>(debugLldbCommandSchema),
  debug_lldb_commandLogic,
  getDefaultDebuggerToolContext,
);
