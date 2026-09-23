import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, it, vi } from 'vitest';
import type { SnapshotResult, SnapshotRuntime, WorkflowSnapshotHarness } from '../contracts.ts';
import { CleanupStack } from '../preflight/cleanup.ts';
import {
  ensureSimulatorBooted,
  launchSimulatorApp,
  prepareSimulatorApp,
  resolveSimulatorId,
} from '../preflight/simulator.ts';
import { buildApp, builtAppPath } from '../preflight/xcodebuild.ts';
import { createHarnessForRuntime, createWorkflowResultFixtureMatcher } from './helpers.ts';

const WORKSPACE = 'example_projects/iOS_Calculator/CalculatorApp.xcworkspace';
const SCHEME = 'CalculatorApp';
const PRODUCT_NAME = 'CalculatorApp';
const BUNDLE_ID = 'io.sentry.calculatorapp';
const SNAPSHOT_SCROLL_SURFACE_ARGUMENT = '--snapshot-scroll-surface';
const SIMULATOR_NAME = 'iPhone 17 Pro';
const CONFIGURED_SIMULATOR = process.env.MOBILEBUILDMCP_SNAPSHOT_SIMULATOR_ID ?? SIMULATOR_NAME;
const INVALID_SIMULATOR_ID = '00000000-0000-0000-0000-000000000000';
const UI_READY_TIMEOUT_MS = 15_000;
const UI_READY_POLL_INTERVAL_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertSetupSucceeded(result: SnapshotResult, label: string): void {
  if (result.isError) {
    throw new Error(`${label} failed:\n${result.rawText}`);
  }
}

function tapRefByLabel(result: SnapshotResult, label: string): string {
  assertSetupSucceeded(result, 'Capture runtime UI snapshot');
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const elementRef = new RegExp(`\\b(e\\d+)\\|tap\\|[^|]*\\|${escapedLabel}\\|`).exec(
    result.rawText,
  )?.[1];
  if (!elementRef) {
    throw new Error(`Expected Calculator button '${label}' to have a tap ref.`);
  }
  return elementRef;
}

function scrollSurfaceRef(result: SnapshotResult): string {
  assertSetupSucceeded(result, 'Capture runtime UI snapshot');
  const elementRef =
    /\b(e\d+)\|swipe\|[^|\n]*\|[^|\n]*\|[^|\n]*\|snapshot-scroll-surface(?=\||\n|"|$)/u.exec(
      result.rawText,
    )?.[1];
  if (!elementRef) {
    throw new Error('Expected the launched app to expose the snapshot scroll-surface ref.');
  }
  return elementRef;
}

export function registerUiAutomationSnapshotSuite(runtime: SnapshotRuntime): void {
  const expectFixture = createWorkflowResultFixtureMatcher(runtime, 'ui-automation');

  describe(`${runtime} ui-automation workflow`, () => {
    let harness: WorkflowSnapshotHarness;
    let cleanup: CleanupStack;
    let suiteCleanup: CleanupStack;
    let builtApp: string;

    beforeAll(async () => {
      vi.setConfig({ testTimeout: 300_000 });
      suiteCleanup = new CleanupStack();
      const simulatorId = await resolveSimulatorId(CONFIGURED_SIMULATOR);
      await ensureSimulatorBooted(simulatorId, suiteCleanup);
      const derivedDataPath = mkdtempSync(path.join(tmpdir(), 'mobilebuildmcp-ui-snapshot-'));
      suiteCleanup.defer('remove shared UI snapshot DerivedData', () => {
        rmSync(derivedDataPath, { recursive: true, force: true });
      });
      await buildApp({
        workspacePath: WORKSPACE,
        scheme: SCHEME,
        destination: `platform=iOS Simulator,id=${simulatorId}`,
        derivedDataPath,
      });
      builtApp = builtAppPath(derivedDataPath, PRODUCT_NAME, 'iphonesimulator');
    });

    afterAll(async () => {
      await suiteCleanup.cleanup();
    });

    beforeEach(async () => {
      vi.setConfig({ testTimeout: 300_000 });
      harness = await createHarnessForRuntime(runtime);
      cleanup = new CleanupStack();
    });

    afterEach(async () => {
      try {
        await harness.cleanup();
      } finally {
        await cleanup.cleanup();
      }
    });

    async function prepareCalculator(launchArguments: string[] = []): Promise<string> {
      const simulatorId = await resolveSimulatorId(CONFIGURED_SIMULATOR);
      await prepareSimulatorApp(simulatorId, builtApp, BUNDLE_ID, cleanup, undefined, {
        shutdownOnCleanup: false,
      });
      await launchSimulatorApp(simulatorId, BUNDLE_ID, launchArguments);
      const expectsScrollSurface = launchArguments.includes(SNAPSHOT_SCROLL_SURFACE_ARGUMENT);
      const readyPattern = expectsScrollSurface
        ? /\|swipe\|[^|\n]*\|[^|\n]*\|[^|\n]*\|snapshot-scroll-surface(?=\||\n|"|$)/u
        : /\|tap\|[^|]*\|C\|/u;
      const deadline = Date.now() + UI_READY_TIMEOUT_MS;
      let lastSnapshot: SnapshotResult | undefined;
      do {
        lastSnapshot = await harness.invoke('ui-automation', 'snapshot-ui', { simulatorId });
        if (lastSnapshot.outcome === 'success' && readyPattern.test(lastSnapshot.rawText)) {
          return simulatorId;
        }
        await sleep(UI_READY_POLL_INTERVAL_MS);
      } while (Date.now() < deadline);

      throw new Error(
        `Calculator UI did not become ready before timeout.\n${lastSnapshot?.rawText ?? ''}`,
      );
    }

    async function calculatorTapRef(simulatorId: string, label = '7'): Promise<string> {
      const snapshot = await harness.invoke('ui-automation', 'snapshot-ui', { simulatorId });
      return tapRefByLabel(snapshot, label);
    }

    describe('tap', () => {
      it('success', async () => {
        const simulatorId = await prepareCalculator();
        const result = await harness.invoke('ui-automation', 'tap', {
          simulatorId,
          elementRef: await calculatorTapRef(simulatorId),
        });
        expectFixture(result, 'tap--success', 'success');
      });

      if (runtime === 'cli/json') {
        it('success - verbose runtime snapshot', async () => {
          const simulatorId = await prepareCalculator();
          const result = await harness.invoke(
            'ui-automation',
            'tap',
            { simulatorId, elementRef: await calculatorTapRef(simulatorId) },
            { verbose: true },
          );
          expectFixture(result, 'tap--success-verbose', 'success');
        });
      }

      it('error - invalid simulator', async () => {
        const result = await harness.invoke('ui-automation', 'tap', {
          simulatorId: INVALID_SIMULATOR_ID,
          elementRef: 'e3',
        });
        expectFixture(result, 'tap--error-no-simulator', 'error');
      });
    });

    describe('touch', () => {
      it('success', async () => {
        const simulatorId = await prepareCalculator();
        const result = await harness.invoke('ui-automation', 'touch', {
          simulatorId,
          elementRef: await calculatorTapRef(simulatorId),
          down: true,
          up: true,
        });
        expectFixture(result, 'touch--success', 'success');
      });

      it('error - invalid simulator', async () => {
        const result = await harness.invoke('ui-automation', 'touch', {
          simulatorId: INVALID_SIMULATOR_ID,
          elementRef: 'e3',
          down: true,
          up: true,
        });
        expectFixture(result, 'touch--error-no-simulator', 'error');
      });
    });

    describe('long-press', () => {
      it('success', async () => {
        const simulatorId = await prepareCalculator();
        const result = await harness.invoke('ui-automation', 'long-press', {
          simulatorId,
          elementRef: await calculatorTapRef(simulatorId),
          duration: 500,
        });
        expectFixture(result, 'long-press--success', 'success');
      });

      it('error - invalid simulator', async () => {
        const result = await harness.invoke('ui-automation', 'long-press', {
          simulatorId: INVALID_SIMULATOR_ID,
          elementRef: 'e3',
          duration: 500,
        });
        expectFixture(result, 'long-press--error-no-simulator', 'error');
      });
    });

    describe('swipe', () => {
      it('success', async () => {
        const simulatorId = await prepareCalculator([SNAPSHOT_SCROLL_SURFACE_ARGUMENT]);
        const snapshot = await harness.invoke('ui-automation', 'snapshot-ui', { simulatorId });
        const result = await harness.invoke('ui-automation', 'swipe', {
          simulatorId,
          withinElementRef: scrollSurfaceRef(snapshot),
          direction: 'up',
          distance: 0.1,
        });
        expectFixture(result, 'swipe--success', 'success');
      });

      it('error - target not actionable', async () => {
        const simulatorId = await prepareCalculator();
        const result = await harness.invoke('ui-automation', 'swipe', {
          simulatorId,
          withinElementRef: await calculatorTapRef(simulatorId),
          direction: 'up',
        });
        expectFixture(result, 'swipe--error-not-actionable', 'error');
      });

      it('error - invalid simulator', async () => {
        const result = await harness.invoke('ui-automation', 'swipe', {
          simulatorId: INVALID_SIMULATOR_ID,
          withinElementRef: 'e3',
          direction: 'up',
        });
        expectFixture(result, 'swipe--error-no-simulator', 'error');
      });
    });

    describe('gesture', () => {
      it('success', async () => {
        const simulatorId = await prepareCalculator();
        const result = await harness.invoke('ui-automation', 'gesture', {
          simulatorId,
          preset: 'scroll-down',
        });
        expectFixture(result, 'gesture--success', 'success');
      });

      it('error - invalid simulator', async () => {
        const result = await harness.invoke('ui-automation', 'gesture', {
          simulatorId: INVALID_SIMULATOR_ID,
          preset: 'scroll-down',
        });
        expectFixture(result, 'gesture--error-no-simulator', 'error');
      });
    });

    describe('button', () => {
      it('success', async () => {
        const simulatorId = await prepareCalculator();
        const result = await harness.invoke('ui-automation', 'button', {
          simulatorId,
          buttonType: 'home',
        });
        expectFixture(result, 'button--success', 'success');
      });

      it('error - invalid simulator', async () => {
        const result = await harness.invoke('ui-automation', 'button', {
          simulatorId: INVALID_SIMULATOR_ID,
          buttonType: 'home',
        });
        expectFixture(result, 'button--error-no-simulator', 'error');
      });
    });

    describe('key-press', () => {
      it('success', async () => {
        const simulatorId = await prepareCalculator();
        const result = await harness.invoke('ui-automation', 'key-press', {
          simulatorId,
          keyCode: 4,
        });
        expectFixture(result, 'key-press--success', 'success');
      });

      it('error - invalid simulator', async () => {
        const result = await harness.invoke('ui-automation', 'key-press', {
          simulatorId: INVALID_SIMULATOR_ID,
          keyCode: 4,
        });
        expectFixture(result, 'key-press--error-no-simulator', 'error');
      });
    });

    describe('key-sequence', () => {
      it('success', async () => {
        const simulatorId = await prepareCalculator();
        const result = await harness.invoke('ui-automation', 'key-sequence', {
          simulatorId,
          keyCodes: [4, 5, 6],
        });
        expectFixture(result, 'key-sequence--success', 'success');
      });

      it('error - invalid simulator', async () => {
        const result = await harness.invoke('ui-automation', 'key-sequence', {
          simulatorId: INVALID_SIMULATOR_ID,
          keyCodes: [4, 5, 6],
        });
        expectFixture(result, 'key-sequence--error-no-simulator', 'error');
      });
    });

    describe('type-text', () => {
      it('error - target not actionable', async () => {
        const simulatorId = await prepareCalculator();
        const result = await harness.invoke('ui-automation', 'type-text', {
          simulatorId,
          elementRef: await calculatorTapRef(simulatorId),
          text: 'hello',
        });
        expectFixture(result, 'type-text--error-not-actionable', 'error');
      });

      it('error - invalid simulator', async () => {
        const result = await harness.invoke('ui-automation', 'type-text', {
          simulatorId: INVALID_SIMULATOR_ID,
          elementRef: 'e3',
          text: 'hello',
        });
        expectFixture(result, 'type-text--error-no-simulator', 'error');
      });
    });

    describe('wait-for-ui', () => {
      it('success - existing calculator button', async () => {
        const simulatorId = await prepareCalculator();
        const result = await harness.invoke('ui-automation', 'wait-for-ui', {
          simulatorId,
          predicate: 'exists',
          label: 'C',
          role: 'button',
          timeoutMs: 1000,
          pollIntervalMs: 100,
        });
        expectFixture(result, 'wait-for-ui--success', 'success');
      });
    });

    describe('snapshot-ui', () => {
      it('success - calculator app', async () => {
        const simulatorId = await prepareCalculator();
        const result = await harness.invoke('ui-automation', 'snapshot-ui', { simulatorId });
        expectFixture(result, 'snapshot-ui--success', 'success');
      });

      if (runtime === 'cli/json') {
        it('success - verbose runtime snapshot', async () => {
          const simulatorId = await prepareCalculator();
          const result = await harness.invoke(
            'ui-automation',
            'snapshot-ui',
            { simulatorId },
            { verbose: true },
          );
          expectFixture(result, 'snapshot-ui--success-verbose', 'success');
        });
      }

      it('error - invalid simulator', async () => {
        const result = await harness.invoke('ui-automation', 'snapshot-ui', {
          simulatorId: INVALID_SIMULATOR_ID,
        });
        expectFixture(result, 'snapshot-ui--error-no-simulator', 'error');
      });
    });
  });
}
