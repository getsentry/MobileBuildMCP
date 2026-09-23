import type { CommandExecutor } from '../../../utils/execution/index.ts';
import { log } from '../../../utils/logging/index.ts';
import { toErrorMessage } from '../../../utils/errors.ts';
import { isHeadlessLaunchMode, openSimulatorFrontend } from '../../../utils/focus-policy.ts';

export type KeyboardShortcut = 'software-keyboard' | 'connect-hardware-keyboard';

export type KeyboardShortcutResult = { success: true } | { success: false; error: string };

type SimctlDevice = { udid: string; name: string; state: string };
type SimctlList = { devices: Record<string, SimctlDevice[]> };

function escapeAppleScriptStringLiteral(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

function resolveDevice(list: SimctlList, simulatorId: string): SimctlDevice | undefined {
  for (const runtime in list.devices) {
    const found = list.devices[runtime]?.find((d) => d.udid === simulatorId);
    if (found) return found;
  }
  return undefined;
}

function buildFocusScript(deviceName: string): string {
  const safeName = escapeAppleScriptStringLiteral(deviceName);
  const titlePredicate = `title is "${safeName}" or title starts with "${safeName} –" or title starts with "${safeName} -"`;
  return [
    'tell application "System Events"',
    '  tell process "Simulator"',
    '    set frontmost to true',
    `    set matchingWindows to (every window whose (${titlePredicate}))`,
    '    if (count of matchingWindows) is 0 then',
    '      return "NO_WINDOW"',
    '    end if',
    '    perform action "AXRaise" of (item 1 of matchingWindows)',
    '    return "OK"',
    '  end tell',
    'end tell',
  ].join('\n');
}

function buildKeystrokeScript(shortcut: KeyboardShortcut): string {
  const modifiers =
    shortcut === 'connect-hardware-keyboard' ? '{command down, shift down}' : '{command down}';
  return [
    'tell application "System Events"',
    '  tell process "Simulator"',
    `    keystroke "k" using ${modifiers}`,
    '  end tell',
    'end tell',
  ].join('\n');
}

function buildDeviceHubKeystrokeScript(shortcut: KeyboardShortcut): string {
  const modifiers =
    shortcut === 'connect-hardware-keyboard' ? '{command down, shift down}' : '{command down}';
  return [
    'tell application "System Events"',
    '  set deviceHubProcess to first application process whose bundle identifier is "com.apple.dt.Devices"',
    '  set frontmost of deviceHubProcess to true',
    '  delay 0.5',
    '  tell deviceHubProcess',
    `    keystroke "k" using ${modifiers}`,
    '  end tell',
    'end tell',
  ].join('\n');
}

export async function sendKeyboardShortcut(
  simulatorId: string,
  shortcut: KeyboardShortcut,
  executor: CommandExecutor,
): Promise<KeyboardShortcutResult> {
  log('info', `Sending keyboard shortcut "${shortcut}" to simulator ${simulatorId}`);

  const listResult = await executor(
    ['xcrun', 'simctl', 'list', 'devices', '--json'],
    'List Simulators',
    false,
  );
  if (!listResult.success) {
    return {
      success: false,
      error: `Failed to list simulators: ${listResult.error ?? 'unknown error'}`,
    };
  }

  let parsed: SimctlList;
  try {
    parsed = JSON.parse(listResult.output) as SimctlList;
  } catch (e) {
    return {
      success: false,
      error: `Failed to parse simulator list: ${toErrorMessage(e)}`,
    };
  }

  const device = resolveDevice(parsed, simulatorId);
  if (!device) {
    return {
      success: false,
      error: `Simulator ${simulatorId} not found. Use list_sims to see available simulators.`,
    };
  }

  if (device.state !== 'Booted') {
    return {
      success: false,
      error: `Simulator ${simulatorId} is not booted. Boot it first with boot_sim.`,
    };
  }

  if (isHeadlessLaunchMode()) {
    return {
      success: false,
      error:
        'Keyboard controls require a simulator frontend in the foreground, which is incompatible with MOBILEBUILDMCP_HEADLESS_LAUNCH mode.',
    };
  }

  const openResult = await openSimulatorFrontend(executor, { simulatorId });
  if (!openResult.success) {
    return {
      success: false,
      error: openResult.error,
    };
  }

  if (openResult.frontend === 'device-hub') {
    const keystrokeResult = await executor(
      ['osascript', '-e', buildDeviceHubKeystrokeScript(shortcut)],
      'Send Device Hub Keyboard Shortcut',
      false,
    );
    if (!keystrokeResult.success) {
      return {
        success: false,
        error: `Failed to send Device Hub keyboard shortcut: ${keystrokeResult.error ?? 'unknown error'}`,
      };
    }
    return { success: true };
  }

  if (openResult.frontend === null) {
    return {
      success: false,
      error:
        'Keyboard controls require a simulator frontend in the foreground, which is incompatible with MOBILEBUILDMCP_HEADLESS_LAUNCH mode.',
    };
  }

  const focusResult = await executor(
    ['osascript', '-e', buildFocusScript(device.name)],
    'Focus Simulator Window',
    false,
  );
  if (!focusResult.success) {
    return {
      success: false,
      error: `Failed to focus Simulator window: ${focusResult.error ?? 'unknown error'}`,
    };
  }

  if (focusResult.output.trim() === 'NO_WINDOW') {
    return {
      success: false,
      error: `No visible Simulator window found for "${device.name}". Simulator.app may be running without a device window; open the simulator device window manually, then retry the keyboard shortcut.`,
    };
  }

  const keystrokeResult = await executor(
    ['osascript', '-e', buildKeystrokeScript(shortcut)],
    'Send Keyboard Shortcut',
    false,
  );
  if (!keystrokeResult.success) {
    return {
      success: false,
      error: `Failed to send keyboard shortcut: ${keystrokeResult.error ?? 'unknown error'}`,
    };
  }

  return { success: true };
}
