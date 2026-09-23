import * as path from 'node:path';
import { tmpdir } from 'node:os';
import * as z from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { log } from '../../../utils/logging/index.ts';
import { SystemError } from '../../../utils/errors.ts';
import type { CommandExecutor, FileSystemExecutor } from '../../../utils/execution/index.ts';
import {
  getDefaultFileSystemExecutor,
  getDefaultCommandExecutor,
} from '../../../utils/execution/index.ts';
import {
  createSessionAwareTool,
  getSessionAwareToolSchemaShape,
  getHandlerContext,
  toInternalSchema,
} from '../../../utils/typed-tool-factory.ts';
import type { CaptureResultDomainResult } from '../../../types/domain-results.ts';
import type { NonStreamingExecutor } from '../../../types/tool-execution.ts';
import {
  createCaptureFailureResult,
  createCaptureSuccessResult,
  setCaptureStructuredOutput,
} from './shared/domain-result.ts';

const LOG_PREFIX = '[Screenshot]';

async function getImageDimensions(
  imagePath: string,
  executor: CommandExecutor,
): Promise<{ width: number; height: number } | null> {
  try {
    const result = await executor(
      ['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', imagePath],
      `${LOG_PREFIX}: get dimensions`,
      false,
    );
    if (!result.success || !result.output) return null;
    const widthMatch = result.output.match(/pixelWidth:\s*(\d+)/);
    const heightMatch = result.output.match(/pixelHeight:\s*(\d+)/);
    if (widthMatch && heightMatch) {
      return {
        width: Number(widthMatch[1]),
        height: Number(heightMatch[1]),
      };
    }
    return null;
  } catch {
    return null;
  }
}

interface SimctlDevice {
  udid: string;
  name: string;
  state?: string;
}

interface SimctlDeviceList {
  devices: Record<string, SimctlDevice[]>;
}

async function getSimulatorDeviceForSimulatorId(
  simulatorId: string,
  executor: CommandExecutor,
): Promise<SimctlDevice | null> {
  const listCommand = ['xcrun', 'simctl', 'list', 'devices', '-j'];
  const result = await executor(listCommand, `${LOG_PREFIX}: list devices`, false);

  if (!result.success || !result.output) {
    return null;
  }

  const data = JSON.parse(result.output) as SimctlDeviceList;
  for (const devices of Object.values(data.devices)) {
    const match = devices.find((device) => device.udid === simulatorId);
    if (match) {
      return match;
    }
  }

  return null;
}

async function assertSimulatorBooted(
  simulatorId: string,
  executor: CommandExecutor,
): Promise<SimctlDevice> {
  const device = await getSimulatorDeviceForSimulatorId(simulatorId, executor);
  if (!device) {
    throw new SystemError(`Simulator ${simulatorId} was not found.`);
  }
  if (device.state !== 'Booted') {
    throw new SystemError(
      `Simulator ${simulatorId} is ${device.state ?? 'not booted'}. Boot the simulator and try again.`,
    );
  }
  return device;
}

function escapeSwiftStringLiteral(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

function getWindowDetectionSwiftCode(deviceName: string): string {
  const escapedDeviceName = escapeSwiftStringLiteral(deviceName);
  return `
import Cocoa
import CoreGraphics
let deviceName = "${escapedDeviceName}"
let opts = CGWindowListOption(arrayLiteral: .optionOnScreenOnly, .excludeDesktopElements)
if let wins = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] {
  for w in wins {
    if let o = w[kCGWindowOwnerName as String] as? String, o == "Simulator",
       let b = w[kCGWindowBounds as String] as? [String: Any],
       let n = w[kCGWindowName as String] as? String {
      let isMatch = n == deviceName || n.hasPrefix(deviceName + " \\u{2013}") || n.hasPrefix(deviceName + " -")
      if isMatch {
        print("\\(b["Width"] as? Int ?? 0),\\(b["Height"] as? Int ?? 0)")
        break
      }
    }
  }
}`.trim();
}

export async function getDeviceNameForSimulatorId(
  simulatorId: string,
  executor: CommandExecutor,
): Promise<string | null> {
  try {
    const device = await getSimulatorDeviceForSimulatorId(simulatorId, executor);
    if (device) {
      log('info', `${LOG_PREFIX}: Found device name "${device.name}" for ${simulatorId}`);
      return device.name;
    }
    log('warn', `${LOG_PREFIX}: Could not find device name for ${simulatorId}`);
    return null;
  } catch (error) {
    log('warn', `${LOG_PREFIX}: Failed to get device name: ${error}`);
    return null;
  }
}

export async function detectLandscapeMode(
  executor: CommandExecutor,
  deviceName?: string,
): Promise<boolean> {
  try {
    if (!deviceName) {
      log('warn', `${LOG_PREFIX}: No device name available, skipping orientation detection`);
      return false;
    }
    const swiftCode = getWindowDetectionSwiftCode(deviceName);
    const swiftCommand = ['swift', '-e', swiftCode];
    const result = await executor(swiftCommand, `${LOG_PREFIX}: detect orientation`, false);

    if (result.success && result.output) {
      const match = result.output.trim().match(/(\d+),(\d+)/);
      if (match) {
        const width = parseInt(match[1], 10);
        const height = parseInt(match[2], 10);
        const isLandscape = width > height;
        log(
          'info',
          `${LOG_PREFIX}: Window dimensions ${width}x${height}, landscape=${isLandscape}`,
        );
        return isLandscape;
      }
    }
    log('warn', `${LOG_PREFIX}: Could not detect window orientation, assuming portrait`);
    return false;
  } catch (error) {
    log('warn', `${LOG_PREFIX}: Orientation detection failed: ${error}`);
    return false;
  }
}

export async function rotateImage(
  imagePath: string,
  degrees: number,
  executor: CommandExecutor,
): Promise<boolean> {
  try {
    const rotateArgs = ['sips', '--rotate', degrees.toString(), imagePath];
    const result = await executor(rotateArgs, `${LOG_PREFIX}: rotate image`, false);
    return result.success;
  } catch (error) {
    log('warn', `${LOG_PREFIX}: Image rotation failed: ${error}`);
    return false;
  }
}

const screenshotSchema = z.object({
  simulatorId: z.uuid({ message: 'Invalid Simulator UUID format' }),
  returnFormat: z
    .enum(['path', 'base64'])
    .optional()
    .describe('Return image path or base64 data (path|base64)'),
});

type ScreenshotParams = z.infer<typeof screenshotSchema>;
type ScreenshotResult = CaptureResultDomainResult;
type ScreenshotAttachment = { data: string; mimeType: string };

const publicSchemaObject = z.strictObject(
  screenshotSchema.omit({ simulatorId: true } as const).shape,
);

interface ScreenshotExecutorDependencies {
  executor: CommandExecutor;
  fileSystemExecutor?: FileSystemExecutor;
  pathUtils?: { tmpdir: () => string; join: (...paths: string[]) => string };
  uuidUtils?: { v4: () => string };
  onAttachment?: (attachment: ScreenshotAttachment) => void;
}

export function createScreenshotExecutor(
  dependencies: ScreenshotExecutorDependencies,
): NonStreamingExecutor<ScreenshotParams, ScreenshotResult> {
  return async (params) => {
    const executor = dependencies.executor;
    const fileSystemExecutor = dependencies.fileSystemExecutor ?? getDefaultFileSystemExecutor();
    const pathUtils = dependencies.pathUtils ?? { ...path, tmpdir };
    const uuidUtils = dependencies.uuidUtils ?? { v4: uuidv4 };
    const { simulatorId } = params;

    const runtime = process.env.MOBILEBUILDMCP_RUNTIME;
    const defaultFormat = runtime === 'cli' || runtime === 'daemon' ? 'path' : 'base64';
    const returnFormat = params.returnFormat ?? defaultFormat;
    const tempDir = pathUtils.tmpdir();
    const screenshotFilename = `screenshot_${uuidUtils.v4()}.png`;
    const screenshotPath = pathUtils.join(tempDir, screenshotFilename);
    const optimizedFilename = `screenshot_optimized_${uuidUtils.v4()}.jpg`;
    const optimizedPath = pathUtils.join(tempDir, optimizedFilename);
    const commandArgs = ['xcrun', 'simctl', 'io', simulatorId, 'screenshot', screenshotPath];

    log(
      'info',
      `${LOG_PREFIX}/screenshot: Starting capture to ${screenshotPath} on ${simulatorId}`,
    );

    try {
      const simulatorDevice = await assertSimulatorBooted(simulatorId, executor);
      const result = await executor(commandArgs, `${LOG_PREFIX}: screenshot`, false);

      if (!result.success) {
        throw new SystemError(`Failed to capture screenshot: ${result.error ?? result.output}`);
      }

      log('info', `${LOG_PREFIX}/screenshot: Success for ${simulatorId}`);

      try {
        const isLandscape = await detectLandscapeMode(executor, simulatorDevice.name);
        if (isLandscape) {
          log('info', `${LOG_PREFIX}/screenshot: Landscape mode detected, rotating +90`);
          const rotated = await rotateImage(screenshotPath, 90, executor);
          if (!rotated) {
            log('warn', `${LOG_PREFIX}/screenshot: Rotation failed, continuing with original`);
          }
        }

        const optimizeArgs = [
          'sips',
          '-Z',
          '800',
          '-s',
          'format',
          'jpeg',
          '-s',
          'formatOptions',
          '75',
          screenshotPath,
          '--out',
          optimizedPath,
        ];

        const optimizeResult = await executor(optimizeArgs, `${LOG_PREFIX}: optimize image`, false);

        if (!optimizeResult.success) {
          log('warn', `${LOG_PREFIX}/screenshot: Image optimization failed, using original PNG`);
          if (returnFormat === 'base64') {
            const base64Image = await fileSystemExecutor.readFile(screenshotPath, 'base64');
            dependencies.onAttachment?.({ data: base64Image, mimeType: 'image/png' });
            const dimensions = await getImageDimensions(screenshotPath, executor);

            try {
              await fileSystemExecutor.rm(screenshotPath);
            } catch (err) {
              log('warn', `${LOG_PREFIX}/screenshot: Failed to delete temp file: ${err}`);
            }

            return createCaptureSuccessResult(simulatorId, {
              capture: {
                format: 'image/png',
                width: dimensions?.width ?? 0,
                height: dimensions?.height ?? 0,
              },
            });
          }

          const dimensions = await getImageDimensions(screenshotPath, executor);
          return createCaptureSuccessResult(simulatorId, {
            screenshotPath,
            capture: {
              format: 'image/png',
              width: dimensions?.width ?? 0,
              height: dimensions?.height ?? 0,
            },
          });
        }

        log('info', `${LOG_PREFIX}/screenshot: Image optimized successfully`);

        const dimensions = await getImageDimensions(optimizedPath, executor);
        const capture = {
          format: 'image/jpeg',
          width: dimensions?.width ?? 0,
          height: dimensions?.height ?? 0,
        };

        if (returnFormat === 'base64') {
          const base64Image = await fileSystemExecutor.readFile(optimizedPath, 'base64');
          dependencies.onAttachment?.({ data: base64Image, mimeType: 'image/jpeg' });

          log('info', `${LOG_PREFIX}/screenshot: Successfully encoded image as Base64`);

          try {
            await fileSystemExecutor.rm(screenshotPath);
            await fileSystemExecutor.rm(optimizedPath);
          } catch (err) {
            log('warn', `${LOG_PREFIX}/screenshot: Failed to delete temporary files: ${err}`);
          }

          return createCaptureSuccessResult(simulatorId, { capture });
        }

        try {
          await fileSystemExecutor.rm(screenshotPath);
        } catch (err) {
          log('warn', `${LOG_PREFIX}/screenshot: Failed to delete temp file: ${err}`);
        }

        return createCaptureSuccessResult(simulatorId, {
          screenshotPath: optimizedPath,
          capture,
        });
      } catch (fileError) {
        log('error', `${LOG_PREFIX}/screenshot: Failed to process image file: ${fileError}`);
        const diagnosticMessage =
          fileError instanceof Error ? fileError.message : String(fileError);
        return createCaptureFailureResult(
          simulatorId,
          'Screenshot captured but failed to process image file.',
          {
            details: [diagnosticMessage],
          },
        );
      }
    } catch (error) {
      log('error', `${LOG_PREFIX}/screenshot: Failed - ${error}`);
      if (error instanceof SystemError) {
        return createCaptureFailureResult(simulatorId, 'Failed to capture screenshot.', {
          details: [error.message],
        });
      }
      return createCaptureFailureResult(simulatorId, 'Unexpected screenshot failure.', {
        details: [error instanceof Error ? error.message : String(error)],
      });
    }
  };
}

export async function screenshotLogic(
  params: ScreenshotParams,
  executor: CommandExecutor,
  fileSystemExecutor: FileSystemExecutor = getDefaultFileSystemExecutor(),
  pathUtils: { tmpdir: () => string; join: (...paths: string[]) => string } = { ...path, tmpdir },
  uuidUtils: { v4: () => string } = { v4: uuidv4 },
): Promise<void> {
  const ctx = getHandlerContext();
  const executeScreenshot = createScreenshotExecutor({
    executor,
    fileSystemExecutor,
    pathUtils,
    uuidUtils,
    onAttachment: (attachment) => ctx.attach(attachment),
  });
  const result = await executeScreenshot(params);

  setCaptureStructuredOutput(ctx, result);
}

export const schema = getSessionAwareToolSchemaShape({
  sessionAware: publicSchemaObject,
  legacy: screenshotSchema,
});

export const handler = createSessionAwareTool<ScreenshotParams>({
  internalSchema: toInternalSchema<ScreenshotParams>(screenshotSchema),
  logicFunction: (params: ScreenshotParams, executor: CommandExecutor) =>
    screenshotLogic(params, executor),
  getExecutor: getDefaultCommandExecutor,
  requirements: [{ allOf: ['simulatorId'], message: 'simulatorId is required' }],
});
