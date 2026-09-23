import * as z from 'zod';
import type { XcodeBridgeToolListDomainResult } from '../../../types/domain-results.ts';
import { log } from '../../../utils/logging/index.ts';
import {
  createTypedToolWithContext,
  getHandlerContext,
} from '../../../utils/typed-tool-factory.ts';
import {
  BridgeToolExecutionContext,
  createBridgeToolExecutor,
  finalizeBridgeToolExecution,
  toBridgeToolListDomainResult,
} from './shared.ts';

const schemaObject = z.object({
  refresh: z
    .boolean()
    .optional()
    .describe(
      'When true, forces a refresh from Xcode bridge. When omitted, uses cached tools if available and refreshes only when the cache is empty.',
    ),
});

type Params = z.infer<typeof schemaObject>;

export function createXcodeIdeListToolsExecutor() {
  return createBridgeToolExecutor<Params, XcodeBridgeToolListDomainResult>({
    callback: (bridge, params) => bridge.listToolsTool({ refresh: params.refresh }),
    toDomainResult: (bridgeResult) => toBridgeToolListDomainResult(bridgeResult),
  });
}

export async function xcodeIdeListToolsLogic(params: Params): Promise<void> {
  log('info', 'Starting Xcode IDE bridge tool listing request');

  const ctx = getHandlerContext();
  const executionContext = new BridgeToolExecutionContext();
  const executeListTools = createXcodeIdeListToolsExecutor();
  const result = await executeListTools(params, executionContext);

  finalizeBridgeToolExecution(
    ctx,
    executionContext,
    result,
    'mobilebuildmcp.output.xcode-bridge-tool-list',
    '3',
  );
}

export const schema = schemaObject.shape;

export const handler = createTypedToolWithContext(
  schemaObject,
  (params: Params) => xcodeIdeListToolsLogic(params),
  () => undefined,
);
