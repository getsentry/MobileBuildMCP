import * as z from 'zod';
import type { XcodeBridgeCallResultDomainResult } from '../../../types/domain-results.ts';
import { log } from '../../../utils/logging/index.ts';
import {
  createTypedToolWithContext,
  getHandlerContext,
} from '../../../utils/typed-tool-factory.ts';
import {
  BridgeToolExecutionContext,
  createBridgeToolExecutor,
  finalizeBridgeToolExecution,
  toBridgeCallResultDomainResult,
} from './shared.ts';

const baseSchemaObject = z.object({
  remoteTool: z.string().min(1).describe('Exact remote Xcode MCP tool name.'),
  timeoutMs: z
    .number()
    .int()
    .min(100)
    .max(120000)
    .optional()
    .describe('Optional timeout override in milliseconds for this single tool call.'),
});

const argumentsRecordSchema = z.record(z.string(), z.unknown());

const argumentsJsonSchema = z.string().transform((argumentsJson, ctx) => {
  let parsedArguments: unknown;
  try {
    parsedArguments = JSON.parse(argumentsJson);
  } catch {
    ctx.addIssue({
      code: 'custom',
      message: 'Must be valid JSON encoding an object.',
    });
    return z.NEVER;
  }

  if (
    typeof parsedArguments !== 'object' ||
    parsedArguments === null ||
    Array.isArray(parsedArguments)
  ) {
    ctx.addIssue({
      code: 'custom',
      message: 'Must be a JSON object.',
    });
    return z.NEVER;
  }

  return parsedArguments as Record<string, unknown>;
});

const schemaObject = baseSchemaObject.extend({
  arguments: argumentsRecordSchema
    .optional()
    .default({})
    .describe('Arguments for the remote Xcode MCP tool.'),
});

const mcpSchemaObject = baseSchemaObject.extend({
  arguments: z
    .string()
    .optional()
    .default('{}')
    .describe('JSON object string containing arguments for the remote Xcode MCP tool.'),
});

const internalSchema = baseSchemaObject.extend({
  arguments: z.union([argumentsRecordSchema, argumentsJsonSchema]).optional().default({}),
});

type Params = z.output<typeof internalSchema>;

export function createXcodeIdeCallToolExecutor() {
  return createBridgeToolExecutor<Params, XcodeBridgeCallResultDomainResult>({
    callback: (bridge, params) =>
      bridge.callToolTool({
        remoteTool: params.remoteTool,
        arguments: params.arguments ?? {},
        timeoutMs: params.timeoutMs,
      }),
    toDomainResult: (bridgeResult, params) =>
      toBridgeCallResultDomainResult(bridgeResult, params.remoteTool),
  });
}

export async function xcodeIdeCallToolLogic(params: Params): Promise<void> {
  log('info', `Starting Xcode IDE remote tool call for ${params.remoteTool}`);

  const ctx = getHandlerContext();
  const executionContext = new BridgeToolExecutionContext();
  const executeCallTool = createXcodeIdeCallToolExecutor();
  const result = await executeCallTool(params, executionContext);

  finalizeBridgeToolExecution(
    ctx,
    executionContext,
    result,
    'mobilebuildmcp.output.xcode-bridge-call-result',
    '3',
  );
}

export const schema = schemaObject.shape;
export const mcpSchema = mcpSchemaObject.shape;

export const handler = createTypedToolWithContext(
  internalSchema,
  (params: Params) => xcodeIdeCallToolLogic(params),
  () => undefined,
);
