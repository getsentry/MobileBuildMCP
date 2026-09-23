import * as z from 'zod';
import type { ToolHandlerContext } from '../../../rendering/types.ts';
import type { StopResultDomainResult } from '../../../types/domain-results.ts';
import type { NonStreamingExecutor } from '../../../types/tool-execution.ts';
import { getProcess, terminateTrackedProcess, type ProcessInfo } from './active-processes.ts';
import {
  createTypedToolWithContext,
  getHandlerContext,
} from '../../../utils/typed-tool-factory.ts';
import { createBasicDiagnostics } from '../../../utils/diagnostics.ts';

const swiftPackageStopSchema = z.object({
  pid: z.number(),
});

type SwiftPackageStopParams = z.infer<typeof swiftPackageStopSchema>;
type SwiftPackageStopResult = StopResultDomainResult;

export interface ProcessManager {
  getProcess: (pid: number) => ProcessInfo | undefined;
  terminateTrackedProcess: (
    pid: number,
    timeoutMs: number,
  ) => Promise<{ status: 'not-found' | 'terminated'; startedAt?: Date; error?: string }>;
}

const defaultProcessManager: ProcessManager = {
  getProcess,
  terminateTrackedProcess,
};

export function getDefaultProcessManager(): ProcessManager {
  return defaultProcessManager;
}

export function createMockProcessManager(overrides?: Partial<ProcessManager>): ProcessManager {
  return {
    getProcess: () => undefined,
    terminateTrackedProcess: async () => ({ status: 'not-found' }),
    ...overrides,
  };
}

export async function swift_package_stopLogic(
  params: SwiftPackageStopParams,
  processManager: ProcessManager = getDefaultProcessManager(),
  timeout: number = 5000,
): Promise<void> {
  const ctx = getHandlerContext();
  const executeSwiftPackageStop = createSwiftPackageStopExecutor(processManager, timeout);
  const result = await executeSwiftPackageStop(params);

  setStructuredOutput(ctx, result);
}

const STRUCTURED_OUTPUT_SCHEMA = 'mobilebuildmcp.output.stop-result';

function createSwiftPackageStopResult(params: SwiftPackageStopParams): SwiftPackageStopResult {
  return {
    kind: 'stop-result',
    didError: false,
    error: null,
    summary: { status: 'SUCCEEDED' },
    artifacts: { processId: params.pid },
    diagnostics: {
      warnings: [],
      errors: [],
    },
  };
}

function createSwiftPackageStopErrorResult(
  params: SwiftPackageStopParams,
  message: string,
  diagnosticMessage = message,
): SwiftPackageStopResult {
  return {
    kind: 'stop-result',
    didError: true,
    error: message,
    summary: { status: 'FAILED' },
    artifacts: { processId: params.pid },
    diagnostics: createBasicDiagnostics({ errors: [diagnosticMessage] }),
  };
}

function setStructuredOutput(ctx: ToolHandlerContext, result: SwiftPackageStopResult): void {
  ctx.structuredOutput = {
    result,
    schema: STRUCTURED_OUTPUT_SCHEMA,
    schemaVersion: '2',
  };
}

export function createSwiftPackageStopExecutor(
  processManager: ProcessManager = getDefaultProcessManager(),
  timeout = 5000,
): NonStreamingExecutor<SwiftPackageStopParams, SwiftPackageStopResult> {
  return async (params) => {
    const processInfo = processManager.getProcess(params.pid);
    if (!processInfo) {
      const message = `No running process found with PID ${params.pid}. Use swift_package_list to check active processes.`;
      return createSwiftPackageStopErrorResult(params, 'Swift package stop failed.', message);
    }

    const result = await processManager.terminateTrackedProcess(params.pid, timeout);
    if (result.status === 'not-found') {
      const message = `No running process found with PID ${params.pid}. Use swift_package_list to check active processes.`;
      return createSwiftPackageStopErrorResult(params, 'Swift package stop failed.', message);
    }

    if (result.error) {
      return createSwiftPackageStopErrorResult(params, 'Failed to stop process.', result.error);
    }

    return createSwiftPackageStopResult(params);
  };
}

export const schema = swiftPackageStopSchema.shape;

interface SwiftPackageStopContext {
  processManager: ProcessManager;
}

export const handler = createTypedToolWithContext(
  swiftPackageStopSchema,
  (params: SwiftPackageStopParams, ctx: SwiftPackageStopContext) =>
    swift_package_stopLogic(params, ctx.processManager),
  () => ({ processManager: getDefaultProcessManager() }),
);
