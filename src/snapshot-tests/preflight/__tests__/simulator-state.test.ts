import { describe, expect, it, vi } from 'vitest';
import { CleanupStack } from '../cleanup.ts';
import type { ExternalCommandResult, ExternalCommandRunner } from '../command-runner.ts';
import {
  ensureSimulatorShutdown,
  prepareSimulatorBooted,
  prepareSimulatorShutdown,
  readSimulatorAppearance,
} from '../simulator-state.ts';

function result(stdout = ''): ExternalCommandResult {
  return {
    command: 'xcrun',
    args: [],
    exitCode: 0,
    signal: null,
    stdout,
    stderr: '',
    timedOut: false,
  };
}

function simulatorList(state: 'Booted' | 'Shutdown'): ExternalCommandResult {
  return result(JSON.stringify({ devices: { runtime: [{ udid: 'SIM-1', state }] } }));
}

describe('simulator state preflight', () => {
  it('restores a simulator that was originally booted', async () => {
    const runner = vi
      .fn<ExternalCommandRunner>()
      .mockResolvedValueOnce(simulatorList('Booted'))
      .mockResolvedValueOnce(simulatorList('Booted'))
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(simulatorList('Shutdown'))
      .mockResolvedValueOnce(simulatorList('Shutdown'))
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result());
    const cleanup = new CleanupStack();

    await prepareSimulatorShutdown('SIM-1', cleanup, runner);
    await cleanup.cleanup();

    expect(runner.mock.calls.map(([, args]) => args)).toEqual([
      ['simctl', 'list', 'devices', 'SIM-1', '--json'],
      ['simctl', 'list', 'devices', 'SIM-1', '--json'],
      ['simctl', 'shutdown', 'SIM-1'],
      ['simctl', 'list', 'devices', 'available', '--json'],
      ['simctl', 'list', 'devices', 'SIM-1', '--json'],
      ['simctl', 'boot', 'SIM-1'],
      ['simctl', 'bootstatus', 'SIM-1', '-b'],
    ]);
  });

  it('leaves an originally shut down simulator shut down', async () => {
    const runner = vi
      .fn<ExternalCommandRunner>()
      .mockResolvedValueOnce(simulatorList('Shutdown'))
      .mockResolvedValueOnce(simulatorList('Shutdown'))
      .mockResolvedValueOnce(simulatorList('Shutdown'));
    const cleanup = new CleanupStack();

    await prepareSimulatorShutdown('SIM-1', cleanup, runner);
    await cleanup.cleanup();

    expect(runner).toHaveBeenCalledTimes(3);
  });

  it('restores a simulator that was originally shut down', async () => {
    const runner = vi
      .fn<ExternalCommandRunner>()
      .mockResolvedValueOnce(simulatorList('Shutdown'))
      .mockResolvedValueOnce(simulatorList('Shutdown'))
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(simulatorList('Booted'))
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(simulatorList('Shutdown'));
    const cleanup = new CleanupStack();

    await prepareSimulatorBooted('SIM-1', cleanup, runner);
    await cleanup.cleanup();

    expect(runner.mock.calls.map(([, args]) => args)).toEqual([
      ['simctl', 'list', 'devices', 'SIM-1', '--json'],
      ['simctl', 'list', 'devices', 'SIM-1', '--json'],
      ['simctl', 'boot', 'SIM-1'],
      ['simctl', 'bootstatus', 'SIM-1', '-b'],
      ['simctl', 'list', 'devices', 'SIM-1', '--json'],
      ['simctl', 'shutdown', 'SIM-1'],
      ['simctl', 'list', 'devices', 'available', '--json'],
    ]);
  });

  it('leaves an originally booted simulator booted', async () => {
    const runner = vi.fn<ExternalCommandRunner>().mockResolvedValue(simulatorList('Booted'));
    const cleanup = new CleanupStack();

    await prepareSimulatorBooted('SIM-1', cleanup, runner);
    await cleanup.cleanup();

    expect(runner).toHaveBeenCalledTimes(3);
  });

  it('does not issue a redundant shutdown command', async () => {
    const runner = vi.fn<ExternalCommandRunner>().mockResolvedValue(simulatorList('Shutdown'));

    await ensureSimulatorShutdown('SIM-1', runner);

    expect(runner).toHaveBeenCalledOnce();
  });

  it('reads either plain or labelled appearance output', async () => {
    const lightRunner = vi.fn<ExternalCommandRunner>().mockResolvedValue(result('light\n'));
    const darkRunner = vi
      .fn<ExternalCommandRunner>()
      .mockResolvedValue(result('Current appearance: Dark\n'));

    await expect(readSimulatorAppearance('SIM-1', lightRunner)).resolves.toBe('light');
    await expect(readSimulatorAppearance('SIM-1', darkRunner)).resolves.toBe('dark');
  });
});
