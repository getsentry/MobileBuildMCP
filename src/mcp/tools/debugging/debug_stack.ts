import * as z from 'zod';
import type { ToolHandlerContext } from '../../../rendering/types.ts';
import type {
  DebugStackFrame,
  DebugStackResultDomainResult,
  DebugThread,
} from '../../../types/domain-results.ts';
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

const debugStackSchema = z.object({
  debugSessionId: z.string().optional().describe('default: current session'),
  threadIndex: z.number().int().nonnegative().optional(),
  maxFrames: z.number().int().positive().optional(),
});

export type DebugStackParams = z.infer<typeof debugStackSchema>;
type DebugStackResult = DebugStackResultDomainResult;

function createDebugStackResult(params: {
  didError: boolean;
  error?: string;
  diagnosticMessage?: string;
  threads?: DebugThread[];
}): DebugStackResult {
  return {
    kind: 'debug-stack-result',
    didError: params.didError,
    error: params.error ?? null,
    ...(params.didError
      ? {
          diagnostics: createBasicDiagnostics({
            errors: [params.diagnosticMessage ?? params.error ?? 'Unknown error'],
          }),
        }
      : {}),
    ...(params.threads ? { threads: params.threads } : {}),
  };
}

function setStructuredOutput(ctx: ToolHandlerContext, result: DebugStackResult): void {
  ctx.structuredOutput = {
    result,
    schema: 'mobilebuildmcp.output.debug-stack-result',
    schemaVersion: '2',
  };
}

function parseThreadLine(line: string): { threadId: number; name: string } | null {
  const trimmed = line.trim();

  const simpleMatch = trimmed.match(/^Thread\s+(\d+)(?:\s+\((.+)\))?$/);
  if (simpleMatch) {
    const threadId = Number(simpleMatch[1]);
    const name = simpleMatch[2]?.trim() || `Thread ${threadId}`;
    return { threadId, name };
  }

  const lldbMatch = trimmed.match(/^\*?\s*thread #(\d+).*?(?:name = ['"]([^'"]+)['"])?/i);
  if (lldbMatch) {
    const threadId = Number(lldbMatch[1]);
    const name = lldbMatch[2]?.trim() || `Thread ${threadId}`;
    return { threadId, name };
  }

  return null;
}

function parseFrameLine(line: string): DebugStackFrame | null {
  const trimmed = line.trim();
  const frameAtMatch = trimmed.match(/^frame #(\d+):\s*(.+?)\s+at\s+(.+)$/);
  if (frameAtMatch) {
    return {
      index: Number(frameAtMatch[1]),
      symbol: frameAtMatch[2].trim(),
      displayLocation: frameAtMatch[3].trim(),
    };
  }

  const frameMatch = trimmed.match(/^frame #(\d+):\s*(.+)$/);
  if (frameMatch) {
    return {
      index: Number(frameMatch[1]),
      symbol: frameMatch[2].trim(),
      displayLocation: 'unknown',
    };
  }

  return null;
}

function parseStackOutput(output: string, params: DebugStackParams): DebugThread[] {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  const threads: DebugThread[] = [];
  let currentThread: DebugThread | null = null;

  for (const line of lines) {
    const parsedThread = parseThreadLine(line);
    if (parsedThread) {
      currentThread = {
        threadId: parsedThread.threadId,
        name: parsedThread.name,
        truncated: false,
        frames: [],
      };
      threads.push(currentThread);
      continue;
    }

    const frame = parseFrameLine(line);
    if (!frame) {
      continue;
    }

    if (!currentThread) {
      const threadId = typeof params.threadIndex === 'number' ? params.threadIndex + 1 : 1;
      currentThread = {
        threadId,
        name: `Thread ${threadId}`,
        truncated: false,
        frames: [],
      };
      threads.push(currentThread);
    }

    currentThread.frames.push(frame);
  }

  if (typeof params.maxFrames === 'number') {
    for (const thread of threads) {
      thread.truncated = thread.frames.length >= params.maxFrames;
    }
  }

  return threads;
}

export function createDebugStackExecutor(
  debuggerManager: DebuggerToolContext['debugger'],
): NonStreamingExecutor<DebugStackParams, DebugStackResult> {
  return async (params) => {
    try {
      const output = await debuggerManager.getStack(params.debugSessionId, {
        threadIndex: params.threadIndex,
        maxFrames: params.maxFrames,
      });

      return createDebugStackResult({
        didError: false,
        threads: parseStackOutput(output, params),
      });
    } catch (error) {
      const diagnosticMessage = toErrorMessage(error);
      return createDebugStackResult({
        didError: true,
        error: 'Failed to get stack.',
        diagnosticMessage,
      });
    }
  };
}

export async function debug_stackLogic(
  params: DebugStackParams,
  ctx: DebuggerToolContext,
): Promise<void> {
  const handlerCtx = getHandlerContext();
  const executeDebugStack = createDebugStackExecutor(ctx.debugger);
  const result = await executeDebugStack(params);

  setStructuredOutput(handlerCtx, result);
}

export const schema = debugStackSchema.shape;

export const handler = createTypedToolWithContext<DebugStackParams, DebuggerToolContext>(
  debugStackSchema,
  debug_stackLogic,
  getDefaultDebuggerToolContext,
);
