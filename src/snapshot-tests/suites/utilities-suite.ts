import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'vitest';
import type { SnapshotRuntime, WorkflowSnapshotHarness } from '../contracts.ts';
import { createHarnessForRuntime, createWorkflowResultFixtureMatcher } from './helpers.ts';

const WORKSPACE = 'example_projects/iOS_Calculator/CalculatorApp.xcworkspace';

export function registerUtilitiesSnapshotSuite(runtime: SnapshotRuntime): void {
  const expectFixture = createWorkflowResultFixtureMatcher(runtime, 'utilities');

  describe(`${runtime} utilities workflow`, () => {
    let derivedDataPath: string;
    let harness: WorkflowSnapshotHarness;

    beforeEach(async () => {
      harness = await createHarnessForRuntime(runtime);
      derivedDataPath = mkdtempSync(join(tmpdir(), 'mobilebuildmcp-clean-snapshot-'));
    });

    afterEach(async () => {
      try {
        await harness.cleanup();
      } finally {
        rmSync(derivedDataPath, { recursive: true, force: true });
      }
    });

    describe('clean', () => {
      it('success', async () => {
        const result = await harness.invoke('utilities', 'clean', {
          derivedDataPath,
          workspacePath: WORKSPACE,
          scheme: 'CalculatorApp',
          configuration: 'Debug',
        });
        expectFixture(result, 'clean--success', 'success');
      }, 120000);

      it('error - wrong scheme', async () => {
        const result = await harness.invoke('utilities', 'clean', {
          derivedDataPath,
          workspacePath: WORKSPACE,
          scheme: 'NONEXISTENT',
          configuration: 'Debug',
        });
        expectFixture(result, 'clean--error-wrong-scheme', 'error');
      }, 120000);
    });
  });
}
