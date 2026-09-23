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

export function createXcodeToolsBridgeStatusExecutor() {
  return createBridgeToolExecutor<Params, XcodeBridgeStatusDomainResult>({
    callback: (bridge) => bridge.statusTool(),
    toDomainResult: (bridgeResult) => toBridgeStatusDomainResult(bridgeResult, 'status'),
  });
}

export async function xcodeToolsBridgeStatusLogic(params: Params): Promise<void> {
  log('info', 'Starting bridge status request');

  const ctx = getHandlerContext();
  const executionContext = new BridgeToolExecutionContext();
  const executeBridgeStatus = createXcodeToolsBridgeStatusExecutor();
  const result = await executeBridgeStatus(params, executionContext);

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
  (params: Params) => xcodeToolsBridgeStatusLogic(params),
  () => undefined,
);
