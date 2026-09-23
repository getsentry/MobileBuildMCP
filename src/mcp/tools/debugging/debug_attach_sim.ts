import * as z from 'zod';
import type { ToolHandlerContext } from '../../../rendering/types.ts';
import type { DebugSessionActionDomainResult } from '../../../types/domain-results.ts';
import type { NonStreamingExecutor } from '../../../types/tool-execution.ts';
import { createBasicDiagnostics } from '../../../utils/diagnostics.ts';
import { log } from '../../../utils/logging/index.ts';
import { toErrorMessage } from '../../../utils/errors.ts';
import { nullifyEmptyStrings, withSimulatorIdOrName } from '../../../utils/schema-helpers.ts';
import { determineSimulatorUuid } from '../../../utils/simulator-utils.ts';
import {
  createSessionAwareToolWithContext,
  getSessionAwareToolSchemaShape,
  getHandlerContext,
  toInternalSchema,
} from '../../../utils/typed-tool-factory.ts';
import {
  getDefaultDebuggerToolContext,
  resolveSimulatorAppPid,
  type DebuggerToolContext,
} from '../../../utils/debugger/index.ts';

const DEBUG_ATTACH_MODE_HELP =
  'Valid attach modes: provide bundleId without pid, or provide pid without bundleId and omit waitFor or set waitFor to false.';

const baseSchemaObject = z.object({
  simulatorId: z
    .string()
    .optional()
    .describe(
      'UUID of the simulator to use (obtained from list_sims). Provide EITHER this OR simulatorName, not both',
    ),
  simulatorName: z
    .string()
    .optional()
    .describe(
      "Name of the simulator (e.g., 'iPhone 17'). Provide EITHER this OR simulatorId, not both",
    ),
  bundleId: z
    .string()
    .optional()
    .describe(
      'Attach by bundle identifier. Provide bundleId without pid; waitFor may be used with this mode.',
    ),
  pid: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Attach to an already-running process by PID. Provide pid without bundleId and without waitFor.',
    ),
  waitFor: z
    .boolean()
    .optional()
    .describe(
      'Only valid when attaching by bundleId. For PID attach, omit waitFor or set it to false.',
    ),
  continueOnAttach: z.boolean().optional().default(true).describe('default: true'),
  makeCurrent: z
    .boolean()
    .optional()
    .default(true)
    .describe('Set debug session as current (default: true)'),
});

const debugAttachSchema = z.preprocess(
  nullifyEmptyStrings,
  withSimulatorIdOrName(baseSchemaObject)
    .refine((val) => val.bundleId !== undefined || val.pid !== undefined, {
      message: `Provide either bundleId or pid to attach. ${DEBUG_ATTACH_MODE_HELP}`,
    })
    .refine((val) => !(val.bundleId && val.pid), {
      message: 'Provide either bundleId or pid, not both.',
    })
    .refine((val) => !(val.pid !== undefined && val.waitFor === true), {
      message:
        'waitFor is only valid when attaching by bundleId. For PID attach, omit waitFor or set it to false.',
    }),
);

export type DebugAttachSimParams = z.infer<typeof debugAttachSchema>;
type DebugAttachSimResult = DebugSessionActionDomainResult;

function createDebugAttachResult(params: {
  didError: boolean;
  error?: string;
  diagnosticMessage?: string;
  debugSessionId?: string;
  executionState?: 'paused' | 'running';
  simulatorId?: string;
  processId?: number;
}): DebugAttachSimResult {
  const artifacts =
    params.simulatorId && typeof params.processId === 'number'
      ? { simulatorId: params.simulatorId, processId: params.processId }
      : params.simulatorId
        ? { simulatorId: params.simulatorId }
        : typeof params.processId === 'number'
          ? { processId: params.processId }
          : undefined;

  return {
    kind: 'debug-session-action',
    didError: params.didError,
    error: params.error ?? null,
    ...(params.didError
      ? {
          diagnostics: createBasicDiagnostics({
            errors: [params.diagnosticMessage ?? params.error ?? 'Unknown error'],
          }),
        }
      : {}),
    action: 'attach',
    ...(params.debugSessionId
      ? {
          session: {
            debugSessionId: params.debugSessionId,
            connectionState: 'attached',
            ...(params.executionState ? { executionState: params.executionState } : {}),
          },
        }
      : {}),
    ...(artifacts ? { artifacts } : {}),
  };
}

function setStructuredOutput(ctx: ToolHandlerContext, result: DebugAttachSimResult): void {
  ctx.structuredOutput = {
    result,
    schema: 'mobilebuildmcp.output.debug-session-action',
    schemaVersion: '2',
  };
}

export function createDebugAttachSimExecutor(
  toolContext: DebuggerToolContext,
): NonStreamingExecutor<DebugAttachSimParams, DebugAttachSimResult> {
  return async (params) => {
    const { executor, debugger: debuggerManager } = toolContext;

    const simResult = await determineSimulatorUuid(
      { simulatorId: params.simulatorId, simulatorName: params.simulatorName },
      executor,
    );

    if (simResult.error) {
      return createDebugAttachResult({
        didError: true,
        error: 'Failed to attach debugger.',
        diagnosticMessage: simResult.error,
      });
    }

    const simulatorId = simResult.uuid;
    if (!simulatorId) {
      return createDebugAttachResult({
        didError: true,
        error: 'Failed to attach debugger.',
        diagnosticMessage: 'Simulator resolution failed: Unable to determine simulator UUID',
      });
    }

    let pid = params.pid;
    if (!pid && params.bundleId) {
      try {
        pid = await resolveSimulatorAppPid({
          executor,
          simulatorId,
          bundleId: params.bundleId,
        });
      } catch (error) {
        const diagnosticMessage = toErrorMessage(error);
        return createDebugAttachResult({
          didError: true,
          error: 'Failed to attach debugger.',
          diagnosticMessage,
          simulatorId,
        });
      }
    }

    if (!pid) {
      return createDebugAttachResult({
        didError: true,
        error: 'Failed to attach debugger.',
        diagnosticMessage: 'Missing PID: Unable to resolve process ID to attach',
        simulatorId,
      });
    }

    try {
      const session = await debuggerManager.createSession({
        simulatorId,
        pid,
        waitFor: params.waitFor,
      });

      const isCurrent = params.makeCurrent ?? true;
      if (isCurrent) {
        debuggerManager.setCurrentSession(session.id);
      }

      const shouldContinue = params.continueOnAttach ?? true;
      if (shouldContinue) {
        try {
          await debuggerManager.resumeSession(session.id);
        } catch (error) {
          const message = toErrorMessage(error);
          if (!/not\s*stopped/i.test(message)) {
            try {
              await debuggerManager.detachSession(session.id);
            } catch (detachError) {
              log(
                'warn',
                `Failed to detach debugger session after resume failure: ${toErrorMessage(detachError)}`,
              );
            }
            return createDebugAttachResult({
              didError: true,
              error: 'Failed to attach debugger.',
              diagnosticMessage: `Failed to resume debugger after attach: ${message}`,
              simulatorId,
              processId: pid,
            });
          }
        }
      } else {
        try {
          await debuggerManager.runCommand(session.id, 'process interrupt');
        } catch (error) {
          const message = toErrorMessage(error);
          if (!/already stopped|not running/i.test(message)) {
            try {
              await debuggerManager.detachSession(session.id);
            } catch (detachError) {
              log(
                'warn',
                `Failed to detach debugger session after pause failure: ${toErrorMessage(detachError)}`,
              );
            }
            return createDebugAttachResult({
              didError: true,
              error: 'Failed to attach debugger.',
              diagnosticMessage: `Failed to pause debugger after attach: ${message}`,
              simulatorId,
              processId: pid,
            });
          }
        }
      }

      const execState = await debuggerManager.getExecutionState(session.id);
      const executionState =
        execState.status === 'running' || execState.status === 'unknown' ? 'running' : 'paused';

      return createDebugAttachResult({
        didError: false,
        debugSessionId: session.id,
        executionState,
        simulatorId,
        processId: pid,
      });
    } catch (error) {
      const diagnosticMessage = toErrorMessage(error);
      return createDebugAttachResult({
        didError: true,
        error: 'Failed to attach debugger.',
        diagnosticMessage,
        simulatorId,
        processId: pid,
      });
    }
  };
}

export async function debug_attach_simLogic(
  params: DebugAttachSimParams,
  ctx: DebuggerToolContext,
): Promise<void> {
  const handlerCtx = getHandlerContext();
  const executeDebugAttachSim = createDebugAttachSimExecutor(ctx);
  const result = await executeDebugAttachSim(params);

  setStructuredOutput(handlerCtx, result);
  if (result.didError) {
    return;
  }

  handlerCtx.nextStepParams = {
    debug_breakpoint_add: {
      debugSessionId: result.session?.debugSessionId ?? '',
      file: '...',
      line: 123,
    },
    debug_continue: { debugSessionId: result.session?.debugSessionId ?? '' },
    debug_stack: { debugSessionId: result.session?.debugSessionId ?? '' },
  };
}

const publicSchemaObject = z.strictObject(
  baseSchemaObject.omit({
    simulatorId: true,
    simulatorName: true,
  }).shape,
);

export const schema = getSessionAwareToolSchemaShape({
  sessionAware: publicSchemaObject,
  legacy: baseSchemaObject,
});

export const handler = createSessionAwareToolWithContext<DebugAttachSimParams, DebuggerToolContext>(
  {
    internalSchema: toInternalSchema<DebugAttachSimParams>(debugAttachSchema),
    logicFunction: debug_attach_simLogic,
    getContext: getDefaultDebuggerToolContext,
    requirements: [
      { oneOf: ['simulatorId', 'simulatorName'], message: 'Provide simulatorId or simulatorName' },
    ],
    exclusivePairs: [
      ['simulatorId', 'simulatorName'],
      ['bundleId', 'pid'],
    ],
  },
);
