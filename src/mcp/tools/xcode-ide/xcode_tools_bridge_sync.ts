import * as z from 'zod';
import type { XcodeBridgeSyncDomainResult } from '../../../types/domain-results.ts';
import { log } from '../../../utils/logging/index.ts';
import {
  createTypedToolWithContext,
  getHandlerContext,
} from '../../../utils/typed-tool-factory.ts';
import {
  BridgeToolExecutionContext,
  createBridgeToolExecutor,
  finalizeBridgeToolExecution,
  toBridgeSyncDomainResult,
} from './shared.ts';

const schemaObject = z.object({});

type Params = z.infer<typeof schemaObject>;

export function createXcodeToolsBridgeSyncExecutor() {
  return createBridgeToolExecutor<Params, XcodeBridgeSyncDomainResult>({
    callback: (bridge) => bridge.syncTool(),
    toDomainResult: (bridgeResult) => toBridgeSyncDomainResult(bridgeResult),
  });
}

export async function xcodeToolsBridgeSyncLogic(params: Params): Promise<void> {
  log('info', 'Starting bridge sync request');

  const ctx = getHandlerContext();
  const executionContext = new BridgeToolExecutionContext();
  const executeBridgeSync = createXcodeToolsBridgeSyncExecutor();
  const result = await executeBridgeSync(params, executionContext);

  finalizeBridgeToolExecution(
    ctx,
    executionContext,
    result,
    'mobilebuildmcp.output.xcode-bridge-sync',
    '2',
  );
}

export const schema = schemaObject.shape;

export const handler = createTypedToolWithContext(
  schemaObject,
  (params: Params) => xcodeToolsBridgeSyncLogic(params),
  () => undefined,
);
