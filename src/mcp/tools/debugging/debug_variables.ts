import * as z from 'zod';
import type { ToolHandlerContext } from '../../../rendering/types.ts';
import type {
  DebugRegisterGroup,
  DebugVariable,
  DebugVariablesResultDomainResult,
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

const debugVariablesSchema = z.object({
  debugSessionId: z.string().optional().describe('default: current session'),
  frameIndex: z.number().int().nonnegative().optional(),
});

export type DebugVariablesParams = z.infer<typeof debugVariablesSchema>;
type DebugVariablesResult = DebugVariablesResultDomainResult;

function createDebugVariablesResult(params: {
  didError: boolean;
  error?: string;
  diagnosticMessage?: string;
  scopes?: NonNullable<Extract<DebugVariablesResult, { scopes: unknown }>['scopes']>;
}): DebugVariablesResult {
  return {
    kind: 'debug-variables-result',
    didError: params.didError,
    error: params.error ?? null,
    ...(params.didError
      ? {
          diagnostics: createBasicDiagnostics({
            errors: [params.diagnosticMessage ?? params.error ?? 'Unknown error'],
          }),
        }
      : {}),
    ...(params.scopes ? { scopes: params.scopes } : {}),
  };
}

function setStructuredOutput(ctx: ToolHandlerContext, result: DebugVariablesResult): void {
  ctx.structuredOutput = {
    result,
    schema: 'mobilebuildmcp.output.debug-variables-result',
    schemaVersion: '2',
  };
}

function parseVariableLine(line: string): DebugVariable {
  const trimmed = line.trim();
  const typedMatch = trimmed.match(/^\(?([^)]*?)\)?\s*([A-Za-z0-9_.$-]+)\s*=\s*(.*)$/);
  if (typedMatch) {
    const [, type, name, value] = typedMatch;
    return {
      name: name.trim(),
      type: type.trim() || '<no-type>',
      value: value.trim(),
    };
  }

  const simpleMatch = trimmed.match(/^([A-Za-z0-9_.$-]+)\s*=\s*(.*)$/);
  if (simpleMatch) {
    const [, name, value] = simpleMatch;
    return {
      name: name.trim(),
      type: '<no-type>',
      value: value.trim(),
    };
  }

  return {
    name: trimmed,
    type: '<no-type>',
    value: '',
  };
}

function parseRegisterLine(line: string): { groupName?: string; variable?: DebugVariable } | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed === '(no variables)') {
    return null;
  }

  if (trimmed.endsWith(':')) {
    return {
      groupName: trimmed.slice(0, -1).trim(),
    };
  }

  const groupMatch = trimmed.match(/^(.+?)\s+\((.*?)\)\s*=\s*$/);
  if (groupMatch) {
    return {
      groupName: groupMatch[1].trim(),
    };
  }

  return {
    variable: parseVariableLine(trimmed),
  };
}

function normalizeScopeName(line: string): 'locals' | 'globals' | 'registers' | null {
  switch (line.trim().toLowerCase()) {
    case 'locals:':
      return 'locals';
    case 'globals:':
      return 'globals';
    case 'registers:':
      return 'registers';
    default:
      return null;
  }
}

function parseVariablesOutput(output: string) {
  const scopes = {
    locals: { variables: [] as DebugVariable[] },
    globals: { variables: [] as DebugVariable[] },
    registers: { groups: [] as DebugRegisterGroup[] },
  };

  const lines = output.split(/\r?\n/);
  let currentScope: 'locals' | 'globals' | 'registers' | null = null;
  let currentRegisterGroup: DebugRegisterGroup | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    const scopeName = normalizeScopeName(trimmed);
    if (scopeName) {
      currentScope = scopeName;
      currentRegisterGroup = null;
      continue;
    }

    if (trimmed === '(no variables)') {
      continue;
    }

    if (!currentScope) {
      scopes.locals.variables.push(parseVariableLine(trimmed));
      continue;
    }

    if (currentScope === 'registers') {
      const parsed = parseRegisterLine(trimmed);
      if (!parsed) {
        continue;
      }

      if (parsed.groupName) {
        currentRegisterGroup = {
          name: parsed.groupName,
          variables: [],
        };
        scopes.registers.groups.push(currentRegisterGroup);
        continue;
      }

      if (parsed.variable) {
        if (!currentRegisterGroup) {
          currentRegisterGroup = {
            name: 'Registers',
            variables: [],
          };
          scopes.registers.groups.push(currentRegisterGroup);
        }
        currentRegisterGroup.variables.push(parsed.variable);
      }
      continue;
    }

    scopes[currentScope].variables.push(parseVariableLine(trimmed));
  }

  return scopes;
}

export function createDebugVariablesExecutor(
  debuggerManager: DebuggerToolContext['debugger'],
): NonStreamingExecutor<DebugVariablesParams, DebugVariablesResult> {
  return async (params) => {
    try {
      const output = await debuggerManager.getVariables(params.debugSessionId, {
        frameIndex: params.frameIndex,
      });

      return createDebugVariablesResult({
        didError: false,
        scopes: parseVariablesOutput(output),
      });
    } catch (error) {
      const diagnosticMessage = toErrorMessage(error);
      return createDebugVariablesResult({
        didError: true,
        error: 'Failed to get variables.',
        diagnosticMessage,
      });
    }
  };
}

export async function debug_variablesLogic(
  params: DebugVariablesParams,
  ctx: DebuggerToolContext,
): Promise<void> {
  const handlerCtx = getHandlerContext();
  const executeDebugVariables = createDebugVariablesExecutor(ctx.debugger);
  const result = await executeDebugVariables(params);

  setStructuredOutput(handlerCtx, result);
}

export const schema = debugVariablesSchema.shape;

export const handler = createTypedToolWithContext<DebugVariablesParams, DebuggerToolContext>(
  debugVariablesSchema,
  debug_variablesLogic,
  getDefaultDebuggerToolContext,
);
