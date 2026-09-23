import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'vitest';
import type { SnapshotRuntime, WorkflowSnapshotHarness } from '../contracts.ts';
import { CleanupStack } from '../preflight/cleanup.ts';
import { runExternalCommandChecked } from '../preflight/command-runner.ts';
import { ensureSimulatorBooted, resolveSimulatorId } from '../preflight/simulator.ts';
import { createHarnessForRuntime, createWorkflowResultFixtureMatcher } from './helpers.ts';

const WORKSPACE = 'example_projects/iOS_Calculator/CalculatorApp.xcworkspace';
const SCHEME = 'CalculatorApp';
const DEFAULT_SIMULATOR = 'iPhone 17';

export function registerCoverageSnapshotSuite(runtime: SnapshotRuntime): void {
  const expectFixture = createWorkflowResultFixtureMatcher(runtime, 'coverage');

  describe(`${runtime} coverage workflow`, () => {
    let harness: WorkflowSnapshotHarness;
    let cleanup: CleanupStack;
    let tmpDir: string;

    beforeEach(async () => {
      cleanup = new CleanupStack();
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-snapshot-'));
      cleanup.defer('remove coverage snapshot directory', () =>
        fs.rmSync(tmpDir, { recursive: true, force: true }),
      );
      harness = await createHarnessForRuntime(runtime);
      cleanup.defer('cleanup snapshot harness', () => harness.cleanup());
    });

    afterEach(async () => {
      await cleanup.cleanup();
    });

    async function createCoverageResultBundle(): Promise<string> {
      const configuredSimulator =
        process.env.MOBILEBUILDMCP_SNAPSHOT_SIMULATOR_ID ?? DEFAULT_SIMULATOR;
      const simulatorId = await resolveSimulatorId(configuredSimulator);
      await ensureSimulatorBooted(simulatorId, cleanup);

      const xcresultPath = path.join(tmpDir, 'TestResults.xcresult');
      await runExternalCommandChecked(
        'xcodebuild',
        [
          '-workspace',
          WORKSPACE,
          '-scheme',
          SCHEME,
          '-destination',
          `platform=iOS Simulator,id=${simulatorId}`,
          '-derivedDataPath',
          path.join(tmpDir, 'DerivedData'),
          '-enableCodeCoverage',
          'YES',
          '-resultBundlePath',
          xcresultPath,
          '-only-testing:CalculatorAppTests/CalculatorAppTests/testAddition',
          'test',
        ],
        { timeoutMs: 300_000 },
        undefined,
        'Generate coverage result bundle',
      );
      if (!fs.existsSync(xcresultPath)) {
        throw new Error(`Coverage preflight did not generate ${xcresultPath}`);
      }
      await runExternalCommandChecked(
        'xcrun',
        ['xccov', 'view', '--report', xcresultPath],
        { timeoutMs: 60_000 },
        undefined,
        'Validate coverage result bundle',
      );
      return xcresultPath;
    }

    function createInvalidResultBundle(): string {
      const invalidXcresultPath = path.join(tmpDir, 'invalid.xcresult');
      fs.mkdirSync(invalidXcresultPath);
      return invalidXcresultPath;
    }

    describe('get-coverage-report', () => {
      it('success', { timeout: 360000 }, async () => {
        const xcresultPath = await createCoverageResultBundle();
        const result = await harness.invoke('coverage', 'get-coverage-report', {
          xcresultPath,
          target: 'CalculatorAppTests',
        });
        expectFixture(result, 'get-coverage-report--success', 'success');
      });

      it('error - invalid bundle', async () => {
        const result = await harness.invoke('coverage', 'get-coverage-report', {
          xcresultPath: createInvalidResultBundle(),
        });
        expectFixture(result, 'get-coverage-report--error-invalid-bundle', 'error');
      });
    });

    describe('get-file-coverage', () => {
      it('success', { timeout: 360000 }, async () => {
        const xcresultPath = await createCoverageResultBundle();
        const result = await harness.invoke('coverage', 'get-file-coverage', {
          xcresultPath,
          file: 'CalculatorService.swift',
        });
        expectFixture(result, 'get-file-coverage--success', 'success');
      });

      it('error - invalid bundle', async () => {
        const result = await harness.invoke('coverage', 'get-file-coverage', {
          xcresultPath: createInvalidResultBundle(),
          file: 'SomeFile.swift',
        });
        expectFixture(result, 'get-file-coverage--error-invalid-bundle', 'error');
      });
    });
  });
}
