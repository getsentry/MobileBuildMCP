import type { CleanupStack } from './cleanup.ts';
import {
  runExternalCommand,
  runExternalCommandChecked,
  type ExternalCommandRunner,
} from './command-runner.ts';
import { waitForSimulatorState } from './simulator.ts';

type SimulatorBootState = 'Booted' | 'Shutdown';
export type SimulatorAppearance = 'light' | 'dark';

interface SimctlDevice {
  udid: string;
  state: string;
}

interface SimctlDeviceList {
  devices: Record<string, SimctlDevice[]>;
}

async function readSimulatorBootState(
  simulatorId: string,
  runner: ExternalCommandRunner,
): Promise<SimulatorBootState> {
  const result = await runExternalCommandChecked(
    'xcrun',
    ['simctl', 'list', 'devices', simulatorId, '--json'],
    {},
    runner,
    `Read simulator ${simulatorId} state`,
  );
  const parsed = JSON.parse(result.stdout) as SimctlDeviceList;
  const simulator = Object.values(parsed.devices)
    .flat()
    .find((device) => device.udid === simulatorId);
  if (!simulator || (simulator.state !== 'Booted' && simulator.state !== 'Shutdown')) {
    throw new Error(`Simulator ${simulatorId} does not have a restorable boot state`);
  }
  return simulator.state;
}

async function setSimulatorBootState(
  simulatorId: string,
  state: SimulatorBootState,
  runner: ExternalCommandRunner,
): Promise<void> {
  if ((await readSimulatorBootState(simulatorId, runner)) === state) {
    return;
  }
  const action = state === 'Booted' ? 'boot' : 'shutdown';
  await runExternalCommandChecked('xcrun', ['simctl', action, simulatorId], {}, runner);
  if (state === 'Booted') {
    await runExternalCommandChecked(
      'xcrun',
      ['simctl', 'bootstatus', simulatorId, '-b'],
      { timeoutMs: 60_000 },
      runner,
    );
  } else {
    await waitForSimulatorState(simulatorId, 'Shutdown', runner);
  }
}

export async function prepareSimulatorShutdown(
  simulatorId: string,
  cleanup: CleanupStack,
  runner: ExternalCommandRunner = runExternalCommand,
): Promise<void> {
  const originalState = await readSimulatorBootState(simulatorId, runner);
  cleanup.defer(`restore simulator ${simulatorId} boot state`, async () => {
    await setSimulatorBootState(simulatorId, originalState, runner);
  });
  await setSimulatorBootState(simulatorId, 'Shutdown', runner);
}

export async function prepareSimulatorBooted(
  simulatorId: string,
  cleanup: CleanupStack,
  runner: ExternalCommandRunner = runExternalCommand,
): Promise<void> {
  const originalState = await readSimulatorBootState(simulatorId, runner);
  cleanup.defer(`restore simulator ${simulatorId} boot state`, async () => {
    await setSimulatorBootState(simulatorId, originalState, runner);
  });
  await setSimulatorBootState(simulatorId, 'Booted', runner);
}

export async function ensureSimulatorShutdown(
  simulatorId: string,
  runner: ExternalCommandRunner = runExternalCommand,
): Promise<void> {
  await setSimulatorBootState(simulatorId, 'Shutdown', runner);
}

export async function readSimulatorAppearance(
  simulatorId: string,
  runner: ExternalCommandRunner = runExternalCommand,
): Promise<SimulatorAppearance> {
  const result = await runExternalCommandChecked(
    'xcrun',
    ['simctl', 'ui', simulatorId, 'appearance'],
    {},
    runner,
    `Read simulator ${simulatorId} appearance`,
  );
  const appearance = result.stdout.toLowerCase().match(/\b(light|dark)\b/)?.[1];
  if (appearance !== 'light' && appearance !== 'dark') {
    throw new Error(`Could not determine simulator ${simulatorId} appearance`);
  }
  return appearance;
}

export async function setSimulatorAppearance(
  simulatorId: string,
  appearance: SimulatorAppearance,
  runner: ExternalCommandRunner = runExternalCommand,
): Promise<void> {
  await runExternalCommandChecked(
    'xcrun',
    ['simctl', 'ui', simulatorId, 'appearance', appearance],
    {},
    runner,
  );
}
