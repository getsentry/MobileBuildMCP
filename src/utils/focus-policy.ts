import type { CommandExecutor } from './execution/index.ts';

/**
 * Headless launch policy.
 *
 * When `MOBILEBUILDMCP_HEADLESS_LAUNCH=1` is set, GUI launches that would
 * otherwise steal window focus on macOS are suppressed:
 *
 * - macOS app launches use `open -g` (run in background, no foreground steal).
 * - Simulator frontend launches are skipped entirely; `simctl boot` alone
 *   keeps the simulator runtime available for `simctl` UI automation without
 *   surfacing a window.
 *
 * This is intended for snapshot/smoke tests and other CI-style runs. It is
 * deliberately off by default so MCP/CLI behaviour in production is unchanged.
 */

const HEADLESS_LAUNCH_ENV_VAR = 'MOBILEBUILDMCP_HEADLESS_LAUNCH';

export function isHeadlessLaunchMode(): boolean {
  const value = process.env[HEADLESS_LAUNCH_ENV_VAR];
  if (!value) {
    return false;
  }
  return value === '1' || value.toLowerCase() === 'true';
}

/**
 * Build the argv to launch a macOS application bundle via `open`.
 * In headless launch mode, `-g` is added so the app does not become foreground.
 */
export function buildOpenAppCommand(appPath: string, opts?: { args?: string[] }): string[] {
  const command: string[] = ['open'];
  if (isHeadlessLaunchMode()) {
    command.push('-g');
  }
  command.push(appPath);
  if (opts?.args?.length) {
    command.push('--args', ...opts.args);
  }
  return command;
}

/**
 * Build the argv to surface Simulator.app, or `null` to indicate the launch
 * should be skipped (headless mode — `simctl boot` is sufficient).
 */
export function buildOpenSimulatorAppCommand(opts?: { simulatorId?: string }): string[] | null {
  if (isHeadlessLaunchMode()) {
    return null;
  }
  const command = ['open', '-a', 'Simulator'];
  if (opts?.simulatorId) {
    command.push('--args', '-CurrentDeviceUDID', opts.simulatorId);
  }
  return command;
}

export type SimulatorFrontend = 'device-hub' | 'simulator';

export interface SimulatorFrontendCommand {
  frontend: SimulatorFrontend;
  command: string[];
}

/**
 * Build launch candidates in preference order. Device Hub is the primary
 * frontend on Xcode 27 and can display simulators from legacy runtimes.
 */
export function buildOpenSimulatorFrontendCommands(opts?: {
  simulatorId?: string;
}): SimulatorFrontendCommand[] | null {
  if (isHeadlessLaunchMode()) {
    return null;
  }

  const encodedSimulatorId = opts?.simulatorId
    ? encodeURIComponent(opts.simulatorId).replace(/'/g, '%27')
    : undefined;
  const deviceHubCommand = encodedSimulatorId
    ? ['open', `devices:///manage/select?id=${encodedSimulatorId}`]
    : ['open', '-a', 'DeviceHub'];
  const simulatorCommand = buildOpenSimulatorAppCommand(opts);

  return [
    { frontend: 'device-hub', command: deviceHubCommand },
    { frontend: 'simulator', command: simulatorCommand ?? ['open', '-a', 'Simulator'] },
  ];
}

export type OpenSimulatorFrontendResult =
  | { success: true; frontend: SimulatorFrontend | null }
  | { success: false; error: string };

/**
 * Open Device Hub when available, falling back to Simulator.app for hosts that
 * do not have Device Hub installed.
 */
export async function openSimulatorFrontend(
  executor: CommandExecutor,
  opts?: { simulatorId?: string },
): Promise<OpenSimulatorFrontendResult> {
  const candidates = buildOpenSimulatorFrontendCommands(opts);
  if (candidates === null) {
    return { success: true, frontend: null };
  }

  const errors: string[] = [];
  for (const candidate of candidates) {
    const label = candidate.frontend === 'device-hub' ? 'Device Hub' : 'Simulator.app';
    const result = await executor(candidate.command, `Open ${label}`, false);
    if (result.success) {
      return { success: true, frontend: candidate.frontend };
    }
    errors.push(`${label}: ${result.error ?? 'unknown error'}`);
  }

  return {
    success: false,
    error: `Failed to open a simulator frontend. ${errors.join('; ')}`,
  };
}
