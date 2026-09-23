import { afterEach, beforeEach, describe, it } from 'vitest';
import type { SnapshotResult, SnapshotRuntime, WorkflowSnapshotHarness } from '../contracts.ts';
import { CleanupStack } from '../preflight/cleanup.ts';
import { runExternalCommandChecked } from '../preflight/command-runner.ts';
import { ensureSimulatorBooted } from '../preflight/simulator.ts';
import {
  ensureSimulatorShutdown,
  prepareSimulatorShutdown,
  readSimulatorAppearance,
  setSimulatorAppearance,
} from '../preflight/simulator-state.ts';
import { createHarnessForRuntime, createWorkflowResultFixtureMatcher } from './helpers.ts';

const INVALID_SIMULATOR_ID = '00000000-0000-0000-0000-000000000000';
// The caller owns all state on this dedicated simulator. Some Simulator controls cannot be queried,
// so their tests establish a known baseline and leave the simulator in that baseline after the test.
const DISPOSABLE_SIMULATOR_ID = process.env.MOBILEBUILDMCP_SNAPSHOT_DISPOSABLE_SIMULATOR_ID;
const ERASABLE_SIMULATOR_ID = process.env.MOBILEBUILDMCP_SNAPSHOT_ERASABLE_SIMULATOR_ID;
const RUN_FOREGROUND_SIMULATOR_SNAPSHOTS = process.env.MOBILEBUILDMCP_SNAPSHOT_FOREGROUND === '1';

async function invokeReversibleToggle(
  harness: WorkflowSnapshotHarness,
  cleanup: CleanupStack,
  tool: 'toggle-software-keyboard' | 'toggle-connect-hardware-keyboard',
  simulatorId: string,
): Promise<SnapshotResult> {
  let shouldRestore = false;
  cleanup.defer(`restore ${tool} state on simulator ${simulatorId}`, async () => {
    if (!shouldRestore) {
      return;
    }
    const restoreResult = await harness.invoke('simulator-management', tool, { simulatorId });
    if (restoreResult.isError) {
      throw new Error(`Failed to restore ${tool} state:\n${restoreResult.rawText}`);
    }
  });
  const result = await harness.invoke('simulator-management', tool, { simulatorId });
  shouldRestore = !result.isError;
  return result;
}

export function registerSimulatorManagementSnapshotSuite(runtime: SnapshotRuntime): void {
  const expectFixture = createWorkflowResultFixtureMatcher(runtime, 'simulator-management');

  describe(`${runtime} simulator-management workflow`, () => {
    let harness: WorkflowSnapshotHarness;
    let cleanup: CleanupStack;

    beforeEach(async () => {
      cleanup = new CleanupStack();
      harness = await createHarnessForRuntime(runtime);
      cleanup.defer('clean up snapshot harness', () => harness.cleanup());
    });

    afterEach(async () => {
      await cleanup.cleanup();
    });

    describe('list', () => {
      it('success', async () => {
        const result = await harness.invoke('simulator-management', 'list', {});
        expectFixture(result, 'list--success', 'success');
      });
    });

    describe('boot', () => {
      it.runIf(DISPOSABLE_SIMULATOR_ID !== undefined)(
        'success',
        async () => {
          const simulatorId = DISPOSABLE_SIMULATOR_ID!;
          await prepareSimulatorShutdown(simulatorId, cleanup);

          const result = await harness.invoke('simulator-management', 'boot', { simulatorId });
          expectFixture(result, 'boot--success', 'success');
        },
        60_000,
      );

      it('error - invalid id', async () => {
        const result = await harness.invoke('simulator-management', 'boot', {
          simulatorId: INVALID_SIMULATOR_ID,
        });
        expectFixture(result, 'boot--error-invalid-id', 'error');
      });
    });

    describe('open', () => {
      it.runIf(RUN_FOREGROUND_SIMULATOR_SNAPSHOTS)('success', async () => {
        const foregroundHarness = await createHarnessForRuntime(runtime, {
          env: { MOBILEBUILDMCP_HEADLESS_LAUNCH: '0' },
        });
        cleanup.defer('clean up foreground harness', () => foregroundHarness.cleanup());

        const result = await foregroundHarness.invoke('simulator-management', 'open', {});
        expectFixture(result, 'open--success', 'success');
      });
    });

    describe('set-appearance', () => {
      it.runIf(DISPOSABLE_SIMULATOR_ID !== undefined)('success', async () => {
        const simulatorId = DISPOSABLE_SIMULATOR_ID!;
        await ensureSimulatorBooted(simulatorId, cleanup);
        const originalAppearance = await readSimulatorAppearance(simulatorId);
        cleanup.defer(`restore appearance on simulator ${simulatorId}`, async () => {
          await setSimulatorAppearance(simulatorId, originalAppearance);
        });
        await setSimulatorAppearance(simulatorId, 'light');

        const result = await harness.invoke('simulator-management', 'set-appearance', {
          simulatorId,
          mode: 'dark',
        });
        expectFixture(result, 'set-appearance--success', 'success');
      });

      it('error - invalid simulator', async () => {
        const result = await harness.invoke('simulator-management', 'set-appearance', {
          simulatorId: INVALID_SIMULATOR_ID,
          mode: 'dark',
        });
        expectFixture(result, 'set-appearance--error-invalid-simulator', 'error');
      });
    });

    describe('set-location', () => {
      it.runIf(DISPOSABLE_SIMULATOR_ID !== undefined)('success', async () => {
        const simulatorId = DISPOSABLE_SIMULATOR_ID!;
        await ensureSimulatorBooted(simulatorId, cleanup);
        await runExternalCommandChecked('xcrun', ['simctl', 'location', simulatorId, 'clear']);
        cleanup.defer(`clear location on simulator ${simulatorId}`, async () => {
          await runExternalCommandChecked('xcrun', ['simctl', 'location', simulatorId, 'clear']);
        });

        const result = await harness.invoke('simulator-management', 'set-location', {
          simulatorId,
          latitude: 37.7749,
          longitude: -122.4194,
        });
        expectFixture(result, 'set-location--success', 'success');
      });

      it('error - invalid simulator', async () => {
        const result = await harness.invoke('simulator-management', 'set-location', {
          simulatorId: INVALID_SIMULATOR_ID,
          latitude: 37.7749,
          longitude: -122.4194,
        });
        expectFixture(result, 'set-location--error-invalid-simulator', 'error');
      });
    });

    describe('reset-location', () => {
      it.runIf(DISPOSABLE_SIMULATOR_ID !== undefined)('success', async () => {
        const simulatorId = DISPOSABLE_SIMULATOR_ID!;
        await ensureSimulatorBooted(simulatorId, cleanup);
        cleanup.defer(`clear location on simulator ${simulatorId}`, async () => {
          await runExternalCommandChecked('xcrun', ['simctl', 'location', simulatorId, 'clear']);
        });
        await runExternalCommandChecked('xcrun', [
          'simctl',
          'location',
          simulatorId,
          'set',
          '37.7749,-122.4194',
        ]);

        const result = await harness.invoke('simulator-management', 'reset-location', {
          simulatorId,
        });
        expectFixture(result, 'reset-location--success', 'success');
      });

      it('error - invalid simulator', async () => {
        const result = await harness.invoke('simulator-management', 'reset-location', {
          simulatorId: INVALID_SIMULATOR_ID,
        });
        expectFixture(result, 'reset-location--error-invalid-simulator', 'error');
      });
    });

    describe('toggle-software-keyboard', () => {
      it.runIf(RUN_FOREGROUND_SIMULATOR_SNAPSHOTS && DISPOSABLE_SIMULATOR_ID !== undefined)(
        'success',
        async () => {
          const foregroundHarness = await createHarnessForRuntime(runtime, {
            env: { MOBILEBUILDMCP_HEADLESS_LAUNCH: '0' },
          });
          cleanup.defer('clean up foreground harness', () => foregroundHarness.cleanup());
          await ensureSimulatorBooted(DISPOSABLE_SIMULATOR_ID!, cleanup);

          const result = await invokeReversibleToggle(
            foregroundHarness,
            cleanup,
            'toggle-software-keyboard',
            DISPOSABLE_SIMULATOR_ID!,
          );
          expectFixture(result, 'toggle-software-keyboard--success', 'success');
        },
      );

      it('error - invalid simulator', async () => {
        const result = await harness.invoke('simulator-management', 'toggle-software-keyboard', {
          simulatorId: INVALID_SIMULATOR_ID,
        });
        expectFixture(result, 'toggle-software-keyboard--error-invalid-simulator', 'error');
      });
    });

    describe('toggle-connect-hardware-keyboard', () => {
      it.runIf(RUN_FOREGROUND_SIMULATOR_SNAPSHOTS && DISPOSABLE_SIMULATOR_ID !== undefined)(
        'success',
        async () => {
          const foregroundHarness = await createHarnessForRuntime(runtime, {
            env: { MOBILEBUILDMCP_HEADLESS_LAUNCH: '0' },
          });
          cleanup.defer('clean up foreground harness', () => foregroundHarness.cleanup());
          await ensureSimulatorBooted(DISPOSABLE_SIMULATOR_ID!, cleanup);

          const result = await invokeReversibleToggle(
            foregroundHarness,
            cleanup,
            'toggle-connect-hardware-keyboard',
            DISPOSABLE_SIMULATOR_ID!,
          );
          expectFixture(result, 'toggle-connect-hardware-keyboard--success', 'success');
        },
      );

      it('error - invalid simulator', async () => {
        const result = await harness.invoke(
          'simulator-management',
          'toggle-connect-hardware-keyboard',
          { simulatorId: INVALID_SIMULATOR_ID },
        );
        expectFixture(result, 'toggle-connect-hardware-keyboard--error-invalid-simulator', 'error');
      });
    });

    describe('statusbar', () => {
      it.runIf(DISPOSABLE_SIMULATOR_ID !== undefined)('success', async () => {
        const simulatorId = DISPOSABLE_SIMULATOR_ID!;
        await ensureSimulatorBooted(simulatorId, cleanup);
        await runExternalCommandChecked('xcrun', ['simctl', 'status_bar', simulatorId, 'clear']);
        cleanup.defer(`clear status bar on simulator ${simulatorId}`, async () => {
          await runExternalCommandChecked('xcrun', ['simctl', 'status_bar', simulatorId, 'clear']);
        });

        const result = await harness.invoke('simulator-management', 'statusbar', {
          simulatorId,
          dataNetwork: 'wifi',
        });
        expectFixture(result, 'statusbar--success', 'success');
      });

      it('error - invalid simulator', async () => {
        const result = await harness.invoke('simulator-management', 'statusbar', {
          simulatorId: INVALID_SIMULATOR_ID,
          dataNetwork: 'wifi',
        });
        expectFixture(result, 'statusbar--error-invalid-simulator', 'error');
      });
    });

    describe('erase', () => {
      it('error - invalid id', async () => {
        const result = await harness.invoke('simulator-management', 'erase', {
          simulatorId: INVALID_SIMULATOR_ID,
        });
        expectFixture(result, 'erase--error-invalid-id', 'error');
      });

      it.runIf(ERASABLE_SIMULATOR_ID !== undefined)(
        'success',
        async () => {
          const simulatorId = ERASABLE_SIMULATOR_ID!;
          await ensureSimulatorShutdown(simulatorId);

          const result = await harness.invoke('simulator-management', 'erase', { simulatorId });
          expectFixture(result, 'erase--success', 'success');
        },
        60_000,
      );
    });
  });
}
