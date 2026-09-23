import * as z from 'zod';
import type { ToolHandlerContext } from '../../../rendering/types.ts';
import type { SimulatorListDomainResult } from '../../../types/domain-results.ts';
import type { NonStreamingExecutor } from '../../../types/tool-execution.ts';
import { log } from '../../../utils/logging/index.ts';
import type { CommandExecutor } from '../../../utils/execution/index.ts';
import { getDefaultCommandExecutor } from '../../../utils/execution/index.ts';
import { createTypedTool, getHandlerContext } from '../../../utils/typed-tool-factory.ts';
import { toErrorMessage } from '../../../utils/errors.ts';

const listSimsSchema = z.object({
  enabled: z.boolean().optional(),
});

type ListSimsParams = z.infer<typeof listSimsSchema>;

interface SimulatorDevice {
  name: string;
  udid: string;
  state: string;
  isAvailable: boolean;
}

export interface ListedSimulator {
  runtime: string;
  name: string;
  udid: string;
  state: string;
  isAvailable: boolean;
}

interface SimulatorData {
  devices: Record<string, SimulatorDevice[]>;
}

export type SimulatorListResult = SimulatorListDomainResult;

function isSimulatorData(value: unknown): value is SimulatorData {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const obj = value as Record<string, unknown>;
  if (!obj.devices || typeof obj.devices !== 'object') {
    return false;
  }

  const devices = obj.devices as Record<string, unknown>;
  for (const runtime in devices) {
    const deviceList = devices[runtime];
    if (!Array.isArray(deviceList)) {
      return false;
    }

    for (const device of deviceList) {
      if (!device || typeof device !== 'object') {
        return false;
      }

      const deviceObj = device as Record<string, unknown>;
      if (
        typeof deviceObj.name !== 'string' ||
        typeof deviceObj.udid !== 'string' ||
        typeof deviceObj.state !== 'string' ||
        typeof deviceObj.isAvailable !== 'boolean'
      ) {
        return false;
      }
    }
  }

  return true;
}

export async function listSimulators(
  executor: CommandExecutor,
  options: { enabled?: boolean } = {},
): Promise<ListedSimulator[]> {
  const result = await executor(
    ['xcrun', 'simctl', 'list', 'devices', '--json'],
    'List Simulators',
    false,
  );

  if (!result.success) {
    throw new Error(`Failed to list simulators: ${result.error}`);
  }

  const parsedData: unknown = JSON.parse(result.output);
  if (!isSimulatorData(parsedData)) {
    throw new Error('Unexpected simctl output format');
  }

  const listed: ListedSimulator[] = [];
  for (const runtime in parsedData.devices) {
    for (const device of parsedData.devices[runtime]) {
      if (options.enabled === true && !device.isAvailable) {
        continue;
      }

      listed.push({
        runtime,
        name: device.name,
        udid: device.udid,
        state: device.state,
        isAvailable: device.isAvailable,
      });
    }
  }

  return listed;
}

function formatRuntimeName(runtime: string): string {
  const match = runtime.match(/SimRuntime\.(.+)$/);
  if (match) {
    return match[1].replace(/-/g, '.').replace(/\.(\d)/, ' $1');
  }
  return runtime;
}

const NEXT_STEP_PARAMS = {
  boot_sim: { simulatorId: 'UUID_FROM_ABOVE' },
  open_sim: {},
  build_sim: { scheme: 'YOUR_SCHEME', simulatorId: 'UUID_FROM_ABOVE' },
  get_sim_app_path: {
    scheme: 'YOUR_SCHEME',
    platform: 'iOS Simulator',
    simulatorId: 'UUID_FROM_ABOVE',
  },
} as const;

function createSimulatorListResult(simulators: ListedSimulator[]): SimulatorListResult {
  return {
    kind: 'simulator-list',
    didError: false,
    error: null,
    simulators: simulators.map((simulator) => ({
      name: simulator.name,
      simulatorId: simulator.udid,
      state: simulator.state,
      isAvailable: simulator.isAvailable,
      runtime: formatRuntimeName(simulator.runtime),
    })),
  };
}

function createSimulatorListErrorResult(message: string): SimulatorListResult {
  const normalizedMessage = message.startsWith('Failed to list simulators:')
    ? message
    : `Failed to list simulators: ${message}`;

  return {
    kind: 'simulator-list',
    didError: true,
    error: normalizedMessage,
    simulators: [],
  };
}

export function createListSimsExecutor(
  executor: CommandExecutor,
): NonStreamingExecutor<ListSimsParams, SimulatorListResult> {
  return async (params) => {
    try {
      const simulators = await listSimulators(executor, params);

      return createSimulatorListResult(simulators);
    } catch (error) {
      return createSimulatorListErrorResult(toErrorMessage(error));
    }
  };
}

function setStructuredOutput(ctx: ToolHandlerContext, result: SimulatorListResult): void {
  ctx.structuredOutput = {
    result,
    schema: 'mobilebuildmcp.output.simulator-list',
    schemaVersion: '2',
  };
}

export async function list_simsLogic(
  params: ListSimsParams,
  executor: CommandExecutor,
): Promise<void> {
  log('info', 'Starting xcrun simctl list devices request');

  const ctx = getHandlerContext();
  const executeListSims = createListSimsExecutor(executor);
  const result = await executeListSims(params);

  setStructuredOutput(ctx, result);

  if (result.didError) {
    log('error', `Error listing simulators: ${result.error ?? 'Unknown error'}`);
  }

  if (!result.didError) {
    ctx.nextStepParams = { ...NEXT_STEP_PARAMS };
  }
}

export const schema = listSimsSchema.shape;

export const handler = createTypedTool(listSimsSchema, list_simsLogic, getDefaultCommandExecutor);
