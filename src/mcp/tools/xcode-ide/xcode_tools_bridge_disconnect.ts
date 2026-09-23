import * as z from 'zod';
import type { XcodeBridgeStatusDomainResult } from '../../../types/domain-results.ts';
import { log } from '../../../utils/logging/index.ts';
import {
  createTypedToolWithContext,
  getHandlerContext,
} from '../../../utils/typed-tool-factory.ts';
import {
  BridgeToolExecutionContext,
  createBridgeToolExecutor,
  finalizeBridgeToolExecution,
  toBridgeStatusDomainResult,
} from './shared.ts';

const schemaObject = z.object({});

type Params = z.infer<typeof schemaObject>;

export function createXcodeToolsBridgeDisconnectExecutor() {
  return createBridgeToolExecutor<Params, XcodeBridgeStatusDomainResult>({
    callback: (bridge) => bridge.disconnectTool(),
    toDomainResult: (bridgeResult) => toBridgeStatusDomainResult(bridgeResult, 'disconnect'),
  });
}

export async function xcodeToolsBridgeDisconnectLogic(params: Params): Promise<void> {
  log('info', 'Starting bridge disconnect request');

  const ctx = getHandlerContext();
  const executionContext = new BridgeToolExecutionContext();
  const executeBridgeDisconnect = createXcodeToolsBridgeDisconnectExecutor();
  const result = await executeBridgeDisconnect(params, executionContext);

  finalizeBridgeToolExecution(
    ctx,
    executionContext,
    result,
    'mobilebuildmcp.output.xcode-bridge-status',
    '2',
  );
}

export const schema = schemaObject.shape;

export const handler = createTypedToolWithContext(
  schemaObject,
  (params: Params) => xcodeToolsBridgeDisconnectLogic(params),
  () => undefined,
);
