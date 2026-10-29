import * as z from 'zod';
import type { ToolHandlerContext } from '../../../rendering/types.ts';
import type {
  SimulatorActionResultDomainResult,
  SimulatorActionStatusbar,
} from '../../../types/domain-results.ts';
import type { NonStreamingExecutor } from '../../../types/tool-execution.ts';
import { log } from '../../../utils/logging/index.ts';
import type { CommandExecutor } from '../../../utils/execution/index.ts';
import { getDefaultCommandExecutor } from '../../../utils/execution/index.ts';
import {
  createSessionAwareTool,
  getSessionAwareToolSchemaShape,
  getHandlerContext,
  toInternalSchema,
} from '../../../utils/typed-tool-factory.ts';
import { toErrorMessage } from '../../../utils/errors.ts';
import { createBasicDiagnostics } from '../../../utils/diagnostics.ts';

const simStatusbarSchemaObject = z.object({
  simulatorId: z.uuid().describe('UUID of the simulator to use (obtained from list_simulators)'),
  dataNetwork: z
    .enum([
      'clear',
      'hide',
      'wifi',
      '3g',
      '4g',
      'lte',
      'lte-a',
      'lte+',
      '5g',
      '5g+',
      '5g-uwb',
      '5g-uc',
    ])
    .optional()
    .describe(
      'clear|hide|wifi|3g|4g|lte|lte-a|lte+|5g|5g+|5g-uwb|5g-uc; clear removes all overrides and must be used alone',
    ),
  time: z.string().optional().describe('Fixed time or ISO date string, e.g. "9:41"'),
  wifiMode: z.enum(['searching', 'failed', 'active']).optional(),
  wifiBars: z.number().int().min(0).max(3).optional(),
  cellularMode: z.enum(['notSupported', 'searching', 'failed', 'active']).optional(),
  cellularBars: z.number().int().min(0).max(4).optional(),
  batteryState: z.enum(['charging', 'charged', 'discharging']).optional(),
  batteryLevel: z.number().int().min(0).max(100).optional(),
});

// Ordered as `simctl status_bar override` documents its flags.
const OVERRIDE_FIELDS = [
  'time',
  'dataNetwork',
  'wifiMode',
  'wifiBars',
  'cellularMode',
  'cellularBars',
  'batteryState',
  'batteryLevel',
] as const;

const simStatusbarSchema = simStatusbarSchemaObject
  .refine((params) => OVERRIDE_FIELDS.some((field) => params[field] !== undefined), {
    message: `Provide at least one status bar field: ${OVERRIDE_FIELDS.join(', ')}.`,
  })
  .refine(
    (params) =>
      params.dataNetwork !== 'clear' ||
      OVERRIDE_FIELDS.every((field) => field === 'dataNetwork' || params[field] === undefined),
    {
      message:
        'dataNetwork "clear" removes all status bar overrides and cannot be combined with other status bar fields.',
      path: ['dataNetwork'],
    },
  );

type SimStatusbarParams = z.infer<typeof simStatusbarSchema>;
type SimStatusbarResult = SimulatorActionResultDomainResult;

function createStatusbarAction(params: SimStatusbarParams): SimulatorActionStatusbar {
  return {
    type: 'statusbar',
    ...(params.time !== undefined ? { time: params.time } : {}),
    ...(params.dataNetwork !== undefined ? { dataNetwork: params.dataNetwork } : {}),
    ...(params.wifiMode !== undefined ? { wifiMode: params.wifiMode } : {}),
    ...(params.wifiBars !== undefined ? { wifiBars: params.wifiBars } : {}),
    ...(params.cellularMode !== undefined ? { cellularMode: params.cellularMode } : {}),
    ...(params.cellularBars !== undefined ? { cellularBars: params.cellularBars } : {}),
    ...(params.batteryState !== undefined ? { batteryState: params.batteryState } : {}),
    ...(params.batteryLevel !== undefined ? { batteryLevel: params.batteryLevel } : {}),
  };
}

function createStatusbarCommand(params: SimStatusbarParams): string[] {
  const command = ['xcrun', 'simctl', 'status_bar', params.simulatorId];
  if (params.dataNetwork === 'clear') {
    return [...command, 'clear'];
  }

  const flags = OVERRIDE_FIELDS.flatMap((field) => {
    const value = params[field];
    return value === undefined ? [] : [`--${field}`, String(value)];
  });
  return [...command, 'override', ...flags];
}

function createSimStatusbarResult(params: {
  request: SimStatusbarParams;
  didError: boolean;
  error?: string;
  diagnosticMessage?: string;
}): SimStatusbarResult {
  return {
    kind: 'simulator-action-result',
    didError: params.didError,
    error: params.error ?? null,
    summary: {
      status: params.didError ? 'FAILED' : 'SUCCEEDED',
    },
    action: createStatusbarAction(params.request),
    ...(params.diagnosticMessage
      ? { diagnostics: createBasicDiagnostics({ errors: [params.diagnosticMessage] }) }
      : {}),
    artifacts: {
      simulatorId: params.request.simulatorId,
    },
  };
}

function setStructuredOutput(ctx: ToolHandlerContext, result: SimStatusbarResult): void {
  ctx.structuredOutput = {
    result,
    schema: 'mobilebuildmcp.output.simulator-action-result',
    schemaVersion: '3',
  };
}

export function createSimStatusbarExecutor(
  executor: CommandExecutor,
): NonStreamingExecutor<SimStatusbarParams, SimStatusbarResult> {
  return async (params) => {
    try {
      const result = await executor(createStatusbarCommand(params), 'Set Status Bar', false);

      if (!result.success) {
        const diagnosticMessage = result.error ?? 'Unknown error';
        return createSimStatusbarResult({
          request: params,
          didError: true,
          error: 'Failed to set status bar.',
          diagnosticMessage,
        });
      }

      return createSimStatusbarResult({
        request: params,
        didError: false,
      });
    } catch (error) {
      const diagnosticMessage = toErrorMessage(error);
      return createSimStatusbarResult({
        request: params,
        didError: true,
        error: 'Failed to set status bar.',
        diagnosticMessage,
      });
    }
  };
}

export async function sim_statusbarLogic(
  params: SimStatusbarParams,
  executor: CommandExecutor,
): Promise<void> {
  const overrides = OVERRIDE_FIELDS.filter((field) => params[field] !== undefined)
    .map((field) => `${field}=${String(params[field])}`)
    .join(', ');
  log('info', `Setting simulator ${params.simulatorId} status bar: ${overrides}`);

  const ctx = getHandlerContext();
  const executeSimStatusbar = createSimStatusbarExecutor(executor);

  const result = await executeSimStatusbar(params);
  setStructuredOutput(ctx, result);

  if (result.didError) {
    log(
      'error',
      `Error setting status bar for simulator ${params.simulatorId}: ${result.error ?? 'Unknown error'}`,
    );
    return;
  }

  const successMsg =
    params.dataNetwork === 'clear' ? 'Status bar overrides cleared' : 'Status bar overrides set';

  log('info', `${successMsg} (simulator: ${params.simulatorId})`);
}

const publicSchemaObject = z.strictObject(
  simStatusbarSchemaObject.omit({ simulatorId: true } as const).shape,
);

export const schema = getSessionAwareToolSchemaShape({
  sessionAware: publicSchemaObject,
  legacy: simStatusbarSchemaObject,
});

export const handler = createSessionAwareTool<SimStatusbarParams>({
  internalSchema: toInternalSchema<SimStatusbarParams>(simStatusbarSchema),
  logicFunction: sim_statusbarLogic,
  getExecutor: getDefaultCommandExecutor,
  requirements: [{ allOf: ['simulatorId'], message: 'simulatorId is required' }],
});
