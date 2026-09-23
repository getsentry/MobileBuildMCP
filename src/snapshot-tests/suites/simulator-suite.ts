import { describe, it, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isMcpSnapshotRuntime,
  type SnapshotRuntime,
  type WorkflowSnapshotHarness,
} from '../contracts.ts';
import { CleanupStack } from '../preflight/cleanup.ts';
import {
  ensureSimulatorAppNotInstalled,
  ensureSimulatorBooted,
  launchSimulatorApp,
  prepareSimulatorApp,
  resolveSimulatorId,
} from '../preflight/simulator.ts';
import { buildApp, builtAppPath } from '../preflight/xcodebuild.ts';
import {
  compilerErrorExtraArgs,
  createHarnessForRuntime,
  createWorkflowResultFixtureMatcher,
} from './helpers.ts';

const TEST_TIMEOUT_MS = 120_000;
const WORKSPACE = 'example_projects/iOS_Calculator/CalculatorApp.xcworkspace';
const SCHEME = 'CalculatorApp';
const INVALID_SCHEME = 'NONEXISTENT';
const CONFIGURED_SIMULATOR = process.env.MOBILEBUILDMCP_SNAPSHOT_SIMULATOR_ID ?? 'iPhone 17 Pro';
const IOS_SIMULATOR_PLATFORM = 'iOS Simulator';
const CALCULATOR_BUNDLE_ID = 'io.sentry.calculatorapp';
const NONEXISTENT_BUNDLE_ID = 'com.nonexistent.app';

async function buildSimulatorCalculator(
  simulatorId: string,
  derivedDataPath: string,
): Promise<string> {
  await buildApp({
    workspacePath: WORKSPACE,
    scheme: SCHEME,
    destination: `platform=iOS Simulator,id=${simulatorId}`,
    derivedDataPath,
  });
  return builtAppPath(derivedDataPath, SCHEME, 'iphonesimulator');
}

export function registerSimulatorSnapshotSuite(runtime: SnapshotRuntime): void {
  const expectFixture = createWorkflowResultFixtureMatcher(runtime, 'simulator');

  describe(`${runtime} simulator workflow`, () => {
    let harness: WorkflowSnapshotHarness;
    let simulatorUdid: string;
    let cleanup: CleanupStack;
    let derivedDataPath: string;

    beforeAll(async () => {
      vi.setConfig({ testTimeout: TEST_TIMEOUT_MS });
      simulatorUdid = await resolveSimulatorId(CONFIGURED_SIMULATOR);
    }, TEST_TIMEOUT_MS);

    beforeEach(async () => {
      harness = await createHarnessForRuntime(runtime);
      cleanup = new CleanupStack();
      derivedDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-derived-data-'));
      cleanup.defer('remove simulator DerivedData', () => {
        fs.rmSync(derivedDataPath, { recursive: true, force: true });
      });
      await ensureSimulatorBooted(simulatorUdid, cleanup);
      await ensureSimulatorAppNotInstalled(simulatorUdid, CALCULATOR_BUNDLE_ID);
      cleanup.defer('remove calculator from simulator', () =>
        ensureSimulatorAppNotInstalled(simulatorUdid, CALCULATOR_BUNDLE_ID),
      );
    }, TEST_TIMEOUT_MS);

    afterEach(async () => {
      try {
        await cleanup.cleanup();
      } finally {
        await harness.cleanup();
      }
    });

    describe('build', () => {
      it(
        'success',
        async () => {
          const result = await harness.invoke('simulator', 'build', {
            workspacePath: WORKSPACE,
            scheme: SCHEME,
            simulatorId: simulatorUdid,
            derivedDataPath,
          });
          expectFixture(result, 'build--success', 'success');
        },
        TEST_TIMEOUT_MS,
      );

      it(
        'success - prepared tests',
        async () => {
          const result = await harness.invoke('simulator', 'build', {
            workspacePath: WORKSPACE,
            scheme: SCHEME,
            simulatorId: simulatorUdid,
            derivedDataPath,
            buildForTesting: true,
            testProductsPath: path.join(derivedDataPath, 'CalculatorApp Tests.xctestproducts'),
          });
          expectFixture(result, 'build--success-prepared-tests', 'success');
        },
        TEST_TIMEOUT_MS,
      );

      it(
        'error - wrong scheme',
        async () => {
          const result = await harness.invoke('simulator', 'build', {
            workspacePath: WORKSPACE,
            scheme: INVALID_SCHEME,
            simulatorId: simulatorUdid,
            derivedDataPath,
          });
          expectFixture(result, 'build--error-wrong-scheme', 'error');
        },
        TEST_TIMEOUT_MS,
      );

      it(
        'error - compiler error',
        async () => {
          const result = await harness.invoke('simulator', 'build', {
            workspacePath: WORKSPACE,
            scheme: SCHEME,
            simulatorId: simulatorUdid,
            derivedDataPath,
            extraArgs: compilerErrorExtraArgs(),
          });
          expectFixture(result, 'build--error-compiler', 'error');
        },
        TEST_TIMEOUT_MS,
      );

      it(
        'error - prepared tests with wrong scheme',
        async () => {
          const result = await harness.invoke('simulator', 'build', {
            workspacePath: WORKSPACE,
            scheme: INVALID_SCHEME,
            simulatorId: simulatorUdid,
            derivedDataPath,
            buildForTesting: true,
            testProductsPath: path.join(
              derivedDataPath,
              'Invalid CalculatorApp Tests.xctestproducts',
            ),
          });
          expectFixture(result, 'build--error-prepared-tests-wrong-scheme', 'error');
        },
        TEST_TIMEOUT_MS,
      );
    });

    describe('build-and-run', () => {
      it(
        'success',
        async () => {
          const result = await harness.invoke('simulator', 'build-and-run', {
            workspacePath: WORKSPACE,
            scheme: SCHEME,
            simulatorId: simulatorUdid,
            derivedDataPath,
          });
          expectFixture(result, 'build-and-run--success', 'success');
        },
        TEST_TIMEOUT_MS,
      );

      it(
        'error - wrong scheme',
        async () => {
          const result = await harness.invoke('simulator', 'build-and-run', {
            workspacePath: WORKSPACE,
            scheme: INVALID_SCHEME,
            simulatorId: simulatorUdid,
            derivedDataPath,
          });
          expectFixture(result, 'build-and-run--error-wrong-scheme', 'error');
        },
        TEST_TIMEOUT_MS,
      );

      it(
        'error - compiler error',
        async () => {
          const result = await harness.invoke('simulator', 'build-and-run', {
            workspacePath: WORKSPACE,
            scheme: SCHEME,
            simulatorId: simulatorUdid,
            derivedDataPath,
            extraArgs: compilerErrorExtraArgs(),
          });
          expectFixture(result, 'build-and-run--error-compiler', 'error');
        },
        TEST_TIMEOUT_MS,
      );
    });

    describe('test', () => {
      it(
        'success',
        async () => {
          const result = await harness.invoke('simulator', 'test', {
            workspacePath: WORKSPACE,
            scheme: SCHEME,
            simulatorId: simulatorUdid,
            derivedDataPath,
            extraArgs: ['-only-testing:CalculatorAppTests/CalculatorAppTests/testAddition'],
          });
          expectFixture(result, 'test--success', 'success');
        },
        TEST_TIMEOUT_MS,
      );

      it(
        'failure - intentional test failure',
        async () => {
          const result = await harness.invoke('simulator', 'test', {
            workspacePath: WORKSPACE,
            scheme: SCHEME,
            simulatorId: simulatorUdid,
            derivedDataPath,
          });
          expectFixture(result, 'test--failure', 'error');
        },
        TEST_TIMEOUT_MS,
      );

      it(
        'error - wrong scheme',
        async () => {
          const result = await harness.invoke('simulator', 'test', {
            workspacePath: WORKSPACE,
            scheme: INVALID_SCHEME,
            simulatorId: simulatorUdid,
            derivedDataPath,
          });
          expectFixture(result, 'test--error-wrong-scheme', 'error');
        },
        TEST_TIMEOUT_MS,
      );

      it(
        'error - compiler error',
        async () => {
          const result = await harness.invoke('simulator', 'test', {
            workspacePath: WORKSPACE,
            scheme: SCHEME,
            simulatorId: simulatorUdid,
            derivedDataPath,
            extraArgs: compilerErrorExtraArgs([
              '-only-testing:CalculatorAppTests/CalculatorAppTests/testAddition',
            ]),
          });
          expectFixture(result, 'test--error-compiler', 'error');
        },
        TEST_TIMEOUT_MS,
      );
    });

    describe('get-app-path', () => {
      it(
        'success',
        async () => {
          const result = await harness.invoke('simulator', 'get-app-path', {
            workspacePath: WORKSPACE,
            scheme: SCHEME,
            platform: IOS_SIMULATOR_PLATFORM,
            simulatorId: simulatorUdid,
            derivedDataPath,
          });
          expectFixture(result, 'get-app-path--success', 'success');
        },
        TEST_TIMEOUT_MS,
      );

      it(
        'error - wrong scheme',
        async () => {
          const result = await harness.invoke('simulator', 'get-app-path', {
            workspacePath: WORKSPACE,
            scheme: INVALID_SCHEME,
            platform: IOS_SIMULATOR_PLATFORM,
            simulatorId: simulatorUdid,
            derivedDataPath,
          });
          expectFixture(result, 'get-app-path--error-wrong-scheme', 'error');
        },
        TEST_TIMEOUT_MS,
      );
    });

    describe('list', () => {
      it('success', async () => {
        const result = await harness.invoke('simulator', 'list', {});
        expectFixture(result, 'list--success', 'success');
      });
    });

    describe('install', () => {
      it(
        'success',
        async () => {
          const appPath = await buildSimulatorCalculator(simulatorUdid, derivedDataPath);
          const result = await harness.invoke('simulator', 'install', {
            simulatorId: simulatorUdid,
            appPath,
          });
          expectFixture(result, 'install--success', 'success');
        },
        TEST_TIMEOUT_MS,
      );

      it(
        'error - invalid app',
        async () => {
          const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-install-'));
          const fakeApp = path.join(tmpDir, 'NotAnApp.app');
          fs.mkdirSync(fakeApp);
          try {
            const result = await harness.invoke('simulator', 'install', {
              simulatorId: simulatorUdid,
              appPath: fakeApp,
            });
            expectFixture(result, 'install--error-invalid-app', 'error');
          } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
          }
        },
        TEST_TIMEOUT_MS,
      );
    });

    describe('launch-app', () => {
      it(
        'success',
        async () => {
          const appPath = await buildSimulatorCalculator(simulatorUdid, derivedDataPath);
          await prepareSimulatorApp(simulatorUdid, appPath, CALCULATOR_BUNDLE_ID, cleanup);
          const result = await harness.invoke('simulator', 'launch-app', {
            simulatorId: simulatorUdid,
            bundleId: CALCULATOR_BUNDLE_ID,
          });
          expectFixture(result, 'launch-app--success', 'success');
        },
        TEST_TIMEOUT_MS,
      );

      it(
        'error - not installed',
        async () => {
          await ensureSimulatorAppNotInstalled(simulatorUdid, NONEXISTENT_BUNDLE_ID);
          const result = await harness.invoke('simulator', 'launch-app', {
            simulatorId: simulatorUdid,
            bundleId: NONEXISTENT_BUNDLE_ID,
          });
          expectFixture(result, 'launch-app--error-not-installed', 'error');
        },
        TEST_TIMEOUT_MS,
      );
    });

    describe('screenshot', () => {
      it(
        'success',
        async () => {
          const result = await harness.invoke('simulator', 'screenshot', {
            simulatorId: simulatorUdid,
            returnFormat: 'path',
          });
          expectFixture(result, 'screenshot--success', 'success');
        },
        TEST_TIMEOUT_MS,
      );

      it(
        'error - invalid simulator',
        async () => {
          const result = await harness.invoke('simulator', 'screenshot', {
            simulatorId: '00000000-0000-0000-0000-000000000000',
            returnFormat: 'path',
          });
          expectFixture(result, 'screenshot--error-invalid-simulator', 'error');
        },
        TEST_TIMEOUT_MS,
      );
    });

    describe('stop', () => {
      it(
        'success',
        async () => {
          const appPath = await buildSimulatorCalculator(simulatorUdid, derivedDataPath);
          await prepareSimulatorApp(simulatorUdid, appPath, CALCULATOR_BUNDLE_ID, cleanup);
          await launchSimulatorApp(simulatorUdid, CALCULATOR_BUNDLE_ID);
          const result = await harness.invoke('simulator', 'stop', {
            simulatorId: simulatorUdid,
            bundleId: CALCULATOR_BUNDLE_ID,
          });
          expectFixture(result, 'stop--success', 'success');
        },
        TEST_TIMEOUT_MS,
      );

      it(
        'error - no app',
        async () => {
          await ensureSimulatorAppNotInstalled(simulatorUdid, NONEXISTENT_BUNDLE_ID);
          const result = await harness.invoke('simulator', 'stop', {
            simulatorId: simulatorUdid,
            bundleId: NONEXISTENT_BUNDLE_ID,
          });
          expectFixture(result, 'stop--error-no-app', 'error');
        },
        TEST_TIMEOUT_MS,
      );
    });

    if (isMcpSnapshotRuntime(runtime) && runtime !== 'mcp/json') {
      describe('mcp-only extras', () => {
        beforeEach(async () => {
          const result = await harness.invoke('session-management', 'clear-defaults', {
            all: true,
          });
          if (result.isError) {
            throw new Error(`Failed to clear snapshot session defaults:\n${result.rawText}`);
          }
        });

        // MCP disables session-default hydration in the snapshot harness, while the CLI surface
        // validates and hydrates arguments differently. This makes the empty-args build failure
        // a transport-specific MCP snapshot rather than a shared CLI/MCP parity case.
        it('build -- error missing params', async () => {
          const result = await harness.invoke('simulator', 'build', {});
          expectFixture(result, 'build--error-missing-params', 'error');
        });
      });
    }
  });
}
