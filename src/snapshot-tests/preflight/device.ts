import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  runExternalCommand,
  runExternalCommandChecked,
  type ExternalCommandRunner,
} from './command-runner.ts';

export async function installDeviceApp(
  deviceId: string,
  appPath: string,
  runner: ExternalCommandRunner = runExternalCommand,
): Promise<void> {
  await runExternalCommandChecked(
    'xcrun',
    ['devicectl', 'device', 'install', 'app', '--device', deviceId, appPath],
    { timeoutMs: 120_000 },
    runner,
  );
}

function containsString(value: unknown, expected: string): boolean {
  if (typeof value === 'string') {
    return value === expected;
  }
  if (Array.isArray(value)) {
    return value.some((entry) => containsString(entry, expected));
  }
  if (value && typeof value === 'object') {
    return Object.values(value).some((entry) => containsString(entry, expected));
  }
  return false;
}

export async function isDeviceAppInstalled(
  deviceId: string,
  bundleId: string,
  runner: ExternalCommandRunner = runExternalCommand,
): Promise<boolean> {
  const tempDirectory = mkdtempSync(path.join(tmpdir(), 'mobilebuildmcp-device-app-list-'));
  const outputPath = path.join(tempDirectory, 'result.json');
  try {
    await runExternalCommandChecked(
      'xcrun',
      ['devicectl', 'device', 'info', 'apps', '--device', deviceId, '--json-output', outputPath],
      { timeoutMs: 120_000 },
      runner,
    );
    const installedApps: unknown = JSON.parse(readFileSync(outputPath, 'utf8'));
    return containsString(installedApps, bundleId);
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }
}

export async function waitForDeviceAppInstallationState(
  deviceId: string,
  bundleId: string,
  expectedInstalled: boolean,
  runner: ExternalCommandRunner = runExternalCommand,
): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  do {
    const installed = await isDeviceAppInstalled(deviceId, bundleId, runner);
    if (installed === expectedInstalled) {
      return installed;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);

  return isDeviceAppInstalled(deviceId, bundleId, runner);
}

export async function ensureDeviceAppNotInstalled(
  deviceId: string,
  bundleId: string,
  runner: ExternalCommandRunner = runExternalCommand,
): Promise<void> {
  if (!(await isDeviceAppInstalled(deviceId, bundleId, runner))) {
    return;
  }
  await uninstallDeviceApp(deviceId, bundleId, runner);
  if (await waitForDeviceAppInstallationState(deviceId, bundleId, false, runner)) {
    throw new Error(`App ${bundleId} remained installed on device ${deviceId} after preflight`);
  }
}

export async function launchDeviceApp(
  deviceId: string,
  bundleId: string,
  args: string[] = [],
  runner: ExternalCommandRunner = runExternalCommand,
): Promise<number> {
  const tempDirectory = mkdtempSync(path.join(tmpdir(), 'mobilebuildmcp-device-launch-'));
  const outputPath = path.join(tempDirectory, 'result.json');
  try {
    await runExternalCommandChecked(
      'xcrun',
      [
        'devicectl',
        'device',
        'process',
        'launch',
        '--device',
        deviceId,
        '--json-output',
        outputPath,
        '--terminate-existing',
        bundleId,
        ...args,
      ],
      { timeoutMs: 120_000 },
      runner,
    );
    const output = JSON.parse(readFileSync(outputPath, 'utf8')) as {
      result?: { process?: { processIdentifier?: unknown } };
    };
    const processId = output.result?.process?.processIdentifier;
    if (typeof processId !== 'number' || !Number.isInteger(processId) || processId <= 0) {
      throw new Error(`devicectl did not return a process identifier for ${bundleId}`);
    }
    return processId;
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }
}

export async function stopDeviceProcess(
  deviceId: string,
  processId: number,
  runner: ExternalCommandRunner = runExternalCommand,
): Promise<void> {
  await runExternalCommandChecked(
    'xcrun',
    [
      'devicectl',
      'device',
      'process',
      'terminate',
      '--device',
      deviceId,
      '--pid',
      String(processId),
    ],
    { timeoutMs: 60_000 },
    runner,
  );
}

export async function uninstallDeviceApp(
  deviceId: string,
  bundleId: string,
  runner: ExternalCommandRunner = runExternalCommand,
): Promise<void> {
  await runExternalCommandChecked(
    'xcrun',
    ['devicectl', 'device', 'uninstall', 'app', '--device', deviceId, bundleId],
    { timeoutMs: 120_000 },
    runner,
  );
}
