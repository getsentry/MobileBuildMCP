import * as z from 'zod';
import type { ToolHandlerContext } from '../../../rendering/types.ts';
import type { DeviceListDomainResult } from '../../../types/domain-results.ts';
import type { NonStreamingExecutor } from '../../../types/tool-execution.ts';
import { log } from '../../../utils/logging/index.ts';
import type { CommandExecutor } from '../../../utils/execution/index.ts';
import { getDefaultCommandExecutor } from '../../../utils/execution/index.ts';
import { createTypedTool, getHandlerContext } from '../../../utils/typed-tool-factory.ts';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toErrorMessage } from '../../../utils/errors.ts';
import { createBasicDiagnostics } from '../../../utils/diagnostics.ts';

const listDevicesSchema = z.object({});

type ListDevicesParams = z.infer<typeof listDevicesSchema>;
type ListDevicesResult = DeviceListDomainResult;

const NEXT_STEP_PARAMS = {
  build_device: { scheme: 'YOUR_SCHEME' },
  install_app_device: { deviceId: 'UUID_FROM_ABOVE', appPath: 'PATH_TO_APP' },
} as const;

function isAvailableState(state: string): boolean {
  return state === 'connected';
}

const PLATFORM_KEYWORDS: Array<{ keywords: string[]; label: string }> = [
  { keywords: ['iphone', 'ios'], label: 'iOS' },
  { keywords: ['ipad'], label: 'iPadOS' },
  { keywords: ['watch'], label: 'watchOS' },
  { keywords: ['appletv', 'tvos', 'apple tv'], label: 'tvOS' },
  { keywords: ['xros', 'vision'], label: 'visionOS' },
  { keywords: ['mac'], label: 'macOS' },
];

function getPlatformLabel(platformIdentifier?: string): string {
  const platformId = platformIdentifier?.toLowerCase() ?? '';
  const match = PLATFORM_KEYWORDS.find((entry) =>
    entry.keywords.some((keyword) => platformId.includes(keyword)),
  );
  return match?.label ?? 'Unknown';
}

function getPlatformOrder(platform: string): number {
  switch (platform) {
    case 'iOS':
      return 0;
    case 'iPadOS':
      return 1;
    case 'watchOS':
      return 2;
    case 'tvOS':
      return 3;
    case 'visionOS':
      return 4;
    case 'macOS':
      return 5;
    default:
      return 6;
  }
}

function getDeviceEmoji(platform: string): string {
  switch (platform) {
    case 'watchOS':
      return '⌚️';
    case 'tvOS':
      return '📺';
    case 'visionOS':
      return '🥽';
    case 'macOS':
      return '💻';
    default:
      return '📱';
  }
}

interface ListedDevice {
  name: string;
  deviceId: string;
  platform: string;
  state: string;
  isAvailable: boolean;
  osVersion: string;
}

interface DeviceDiscoveryOutcome {
  devices: ListedDevice[];
  xctraceOutput?: string;
}

function createDeviceListResult(devices: ListedDevice[]): ListDevicesResult {
  return {
    kind: 'device-list',
    didError: false,
    error: null,
    devices,
  };
}

function createDeviceListErrorResult(message: string): ListDevicesResult {
  return {
    kind: 'device-list',
    didError: true,
    error: 'Failed to list devices.',
    diagnostics: createBasicDiagnostics({ errors: [message] }),
    devices: [],
  };
}

function setStructuredOutput(ctx: ToolHandlerContext, result: ListDevicesResult): void {
  ctx.structuredOutput = {
    result,
    schema: 'mobilebuildmcp.output.device-list',
    schemaVersion: '2',
  };
}

async function discoverDevices(
  executor: CommandExecutor,
  pathDeps?: { tmpdir?: () => string; join?: (...paths: string[]) => string },
  fsDeps?: {
    readFile?: (path: string, encoding?: string) => Promise<string>;
    unlink?: (path: string) => Promise<void>;
  },
): Promise<DeviceDiscoveryOutcome> {
  const tempDir = pathDeps?.tmpdir ? pathDeps.tmpdir() : tmpdir();
  const timestamp = pathDeps?.join ? '123' : Date.now();
  const tempJsonPath = pathDeps?.join
    ? pathDeps.join(tempDir, `devicectl-${timestamp}.json`)
    : join(tempDir, `devicectl-${timestamp}.json`);
  const devices: Array<
    ListedDevice & {
      model?: string;
      connectionType?: string;
      trustState?: string;
      developerModeStatus?: string;
      productType?: string;
      cpuArchitecture?: string;
    }
  > = [];
  let useDevicectl = false;

  try {
    const result = await executor(
      ['xcrun', 'devicectl', 'list', 'devices', '--json-output', tempJsonPath],
      'List Devices (devicectl with JSON)',
      false,
    );

    if (result.success) {
      useDevicectl = true;
      const jsonContent = fsDeps?.readFile
        ? await fsDeps.readFile(tempJsonPath, 'utf8')
        : await fs.readFile(tempJsonPath, 'utf8');
      const deviceCtlData: unknown = JSON.parse(jsonContent);

      const deviceCtlResult = deviceCtlData as { result?: { devices?: unknown[] } };
      const deviceList = deviceCtlResult?.result?.devices;

      if (Array.isArray(deviceList)) {
        for (const deviceRaw of deviceList) {
          if (typeof deviceRaw !== 'object' || deviceRaw === null) continue;

          const device = deviceRaw as {
            visibilityClass?: string;
            connectionProperties?: {
              pairingState?: string;
              tunnelState?: string;
              transportType?: string;
            };
            deviceProperties?: {
              platformIdentifier?: string;
              name?: string;
              osVersionNumber?: string;
              developerModeStatus?: string;
              marketingName?: string;
            };
            hardwareProperties?: {
              productType?: string;
              cpuType?: { name?: string };
            };
            identifier?: string;
          };

          if (
            device.visibilityClass === 'Simulator' ||
            !device.connectionProperties?.pairingState
          ) {
            continue;
          }

          const platform = getPlatformLabel(
            [
              device.deviceProperties?.platformIdentifier,
              device.deviceProperties?.marketingName,
              device.hardwareProperties?.productType,
              device.deviceProperties?.name,
            ]
              .filter((value): value is string => typeof value === 'string' && value.length > 0)
              .join(' '),
          );

          const pairingState = device.connectionProperties?.pairingState ?? '';
          const tunnelState = device.connectionProperties?.tunnelState ?? '';
          const transportType = device.connectionProperties?.transportType ?? '';
          const hasDirectConnection =
            tunnelState === 'connected' ||
            transportType === 'wired' ||
            transportType === 'localNetwork';

          let state: string;
          if (pairingState !== 'paired') {
            state = 'unpaired';
          } else if (hasDirectConnection) {
            state = 'connected';
          } else {
            state = 'disconnected';
          }

          devices.push({
            name: device.deviceProperties?.name ?? 'Unknown Device',
            deviceId: device.identifier ?? 'Unknown',
            platform,
            osVersion: device.deviceProperties?.osVersionNumber ?? 'Unknown',
            state,
            isAvailable: isAvailableState(state),
            model: device.deviceProperties?.marketingName ?? device.hardwareProperties?.productType,
            connectionType: transportType,
            trustState: pairingState,
            developerModeStatus: device.deviceProperties?.developerModeStatus,
            productType: device.hardwareProperties?.productType,
            cpuArchitecture: device.hardwareProperties?.cpuType?.name,
          });
        }
      }
    }
  } catch {
    log('info', 'devicectl with JSON failed, trying xctrace fallback');
  } finally {
    try {
      if (fsDeps?.unlink) {
        await fsDeps.unlink(tempJsonPath);
      } else {
        await fs.unlink(tempJsonPath);
      }
    } catch {
      // Ignore cleanup errors
    }
  }

  if (!useDevicectl || devices.length === 0) {
    const result = await executor(
      ['xcrun', 'xctrace', 'list', 'devices'],
      'List Devices (xctrace)',
      false,
    );

    if (!result.success) {
      throw new Error(result.error ?? 'Unknown error');
    }

    return {
      devices: [],
      xctraceOutput: result.output,
    };
  }

  const uniqueDevices = [...new Map(devices.map((device) => [device.deviceId, device])).values()];
  uniqueDevices.sort((left, right) => {
    const platformOrder = getPlatformOrder(left.platform) - getPlatformOrder(right.platform);
    if (platformOrder !== 0) {
      return platformOrder;
    }

    return left.name.localeCompare(right.name);
  });

  return {
    devices: uniqueDevices.map((device) => ({
      name: device.name,
      deviceId: device.deviceId,
      platform: device.platform,
      state: device.state,
      isAvailable: device.isAvailable,
      osVersion: device.osVersion,
    })),
  };
}

export function createListDevicesExecutor(
  executor: CommandExecutor,
  pathDeps?: { tmpdir?: () => string; join?: (...paths: string[]) => string },
  fsDeps?: {
    readFile?: (path: string, encoding?: string) => Promise<string>;
    unlink?: (path: string) => Promise<void>;
  },
): NonStreamingExecutor<ListDevicesParams, ListDevicesResult> {
  return async (_params) => {
    try {
      const discovery = await discoverDevices(executor, pathDeps, fsDeps);

      return createDeviceListResult(discovery.devices);
    } catch (error) {
      return createDeviceListErrorResult(toErrorMessage(error));
    }
  };
}

export async function list_devicesLogic(
  _params: ListDevicesParams,
  executor: CommandExecutor,
  pathDeps?: { tmpdir?: () => string; join?: (...paths: string[]) => string },
  fsDeps?: {
    readFile?: (path: string, encoding?: string) => Promise<string>;
    unlink?: (path: string) => Promise<void>;
  },
): Promise<void> {
  log('info', 'Starting device discovery');

  const ctx = getHandlerContext();
  const executeListDevices = createListDevicesExecutor(executor, pathDeps, fsDeps);
  const result = await executeListDevices({});

  setStructuredOutput(ctx, result);

  if (result.didError) {
    log('error', `Error listing devices: ${result.error ?? 'Unknown error'}`);
  }

  if (!result.didError) {
    ctx.nextStepParams = { ...NEXT_STEP_PARAMS };
  }
}

export const schema = listDevicesSchema.shape;

export const handler = createTypedTool(
  listDevicesSchema,
  list_devicesLogic,
  getDefaultCommandExecutor,
);
