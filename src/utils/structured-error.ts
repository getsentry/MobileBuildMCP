import type { StructuredToolOutput, ToolHandlerContext } from '../rendering/types.ts';
import type { StructuredErrorCategory } from '../types/domain-results.ts';

export const STRUCTURED_ERROR_SCHEMA = 'mobilebuildmcp.output.error';
export const STRUCTURED_ERROR_SCHEMA_VERSION = '1';

export interface StructuredErrorParams {
  category: StructuredErrorCategory;
  code: string;
  message: string;
}

export function createStructuredErrorOutput(params: StructuredErrorParams): StructuredToolOutput {
  return {
    schema: STRUCTURED_ERROR_SCHEMA,
    schemaVersion: STRUCTURED_ERROR_SCHEMA_VERSION,
    result: {
      kind: 'error',
      didError: true,
      error: params.message,
      category: params.category,
      code: params.code,
    },
  };
}

export function setStructuredErrorOutput(
  ctx: Pick<ToolHandlerContext, 'structuredOutput'>,
  params: StructuredErrorParams,
): StructuredToolOutput {
  const output = createStructuredErrorOutput(params);
  ctx.structuredOutput = output;
  return output;
}
