import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import type { SnapshotResult, SnapshotRuntime, WorkflowSnapshotHarness } from '../contracts.ts';
import { CleanupStack } from '../preflight/cleanup.ts';
import {
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
const SIMULATOR_NAME = 'iPhone 17 Pro';
const CONFIGURED_SIMULATOR = process.env.MOBILEBUILDMCP_SNAPSHOT_SIMULATOR_ID ?? SIMULATOR_NAME;
const INVALID_SIMULATOR_ID = '00000000-0000-0000-0000-000000000000';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertSetupSucceeded(result: SnapshotResult, label: string): void {
  if (result.isError) {
    throw new Error(`${label} failed:\n${result.rawText}`);
  }
}

function breakpointIdFromResult(result: SnapshotResult): number {
  assertSetupSucceeded(result, 'Add debugger breakpoint');
  const data = result.structuredEnvelope?.data;
  if (typeof data === 'object' && data !== null && 'breakpoint' in data) {
    const breakpoint = data.breakpoint;
    if (
      typeof breakpoint === 'object' &&
      breakpoint !== null &&
      'breakpointId' in breakpoint &&
      typeof breakpoint.breakpointId === 'number'
    ) {
      return breakpoint.breakpointId;
    }
  }
  const breakpointId = /Breakpoint\s+(\d+)\s+set/i.exec(result.rawText)?.[1];
  if (!breakpointId) {
    throw new Error(`Add debugger breakpoint did not return an ID:\n${result.rawText}`);
  }
  return Number(breakpointId);
}

function debugSessionIdFromResult(result: SnapshotResult): string {
  assertSetupSucceeded(result, 'Attach debugger');
  const data = result.structuredEnvelope?.data;
  if (typeof data === 'object' && data !== null && 'session' in data) {
    const session = data.session;
    if (
      typeof session === 'object' &&
      session !== null &&
      'debugSessionId' in session &&
      typeof session.debugSessionId === 'string'
    ) {
      return session.debugSessionId;
    }
  }
  const debugSessionId = /Debug session ID:\s*([0-9a-f-]+)/i.exec(result.rawText)?.[1];
  if (!debugSessionId) {
    throw new Error(`Attach debugger did not return a session ID:\n${result.rawText}`);
  }
  return debugSessionId;
}

export function registerDebuggingSnapshotSuite(runtime: SnapshotRuntime): void {
  const expectFixture = createWorkflowResultFixtureMatcher(runtime, 'debugging');

  describe(`${runtime} debugging workflow`, () => {
    let harness: WorkflowSnapshotHarness;
    let cleanup: CleanupStack;
    let debugSessionId: string | undefined;

    beforeEach(async () => {
      vi.setConfig({ testTimeout: 300_000 });
      harness = await createHarnessForRuntime(runtime);
      cleanup = new CleanupStack();
      debugSessionId = undefined;
    });

    afterEach(async () => {
      try {
        if (debugSessionId) {
          const result = await harness.invoke('debugging', 'detach', { debugSessionId });
          assertSetupSucceeded(result, 'Detach debugger cleanup');
          debugSessionId = undefined;
        }
      } finally {
        try {
          await harness.cleanup();
        } finally {
          await cleanup.cleanup();
        }
      }
    });

    async function prepareDebugTarget(): Promise<string> {
      const simulatorId = await resolveSimulatorId(CONFIGURED_SIMULATOR);
      const derivedDataPath = mkdtempSync(path.join(tmpdir(), 'mobilebuildmcp-debug-snapshot-'));
      cleanup.defer('remove debugger snapshot DerivedData', () => {
        rmSync(derivedDataPath, { recursive: true, force: true });
      });
      await buildApp({
        workspacePath: WORKSPACE,
        scheme: SCHEME,
        destination: `platform=iOS Simulator,id=${simulatorId}`,
        derivedDataPath,
      });
      await prepareSimulatorApp(
        simulatorId,
        builtAppPath(derivedDataPath, PRODUCT_NAME, 'iphonesimulator'),
        BUNDLE_ID,
        cleanup,
      );
      await launchSimulatorApp(simulatorId, BUNDLE_ID);
      await sleep(2_000);
      return simulatorId;
    }

    async function attachForSetup(simulatorId: string): Promise<string> {
      const result = await harness.invoke('debugging', 'attach', {
        simulatorId,
        bundleId: BUNDLE_ID,
        continueOnAttach: false,
      });
      debugSessionId = debugSessionIdFromResult(result);
      await sleep(250);
      return debugSessionId;
    }

    describe('error paths (no session)', () => {
      it('continue - error no session', async () => {
        const result = await harness.invoke('debugging', 'continue', {});
        expectFixture(result, 'continue--error-no-session', 'error');
      });

      it('detach - error no session', async () => {
        const result = await harness.invoke('debugging', 'detach', {});
        expectFixture(result, 'detach--error-no-session', 'error');
      });

      it('stack - error no session', async () => {
        const result = await harness.invoke('debugging', 'stack', {});
        expectFixture(result, 'stack--error-no-session', 'error');
      });

      it('variables - error no session', async () => {
        const result = await harness.invoke('debugging', 'variables', {});
        expectFixture(result, 'variables--error-no-session', 'error');
      });

      it('add-breakpoint - error no session', async () => {
        const result = await harness.invoke('debugging', 'add-breakpoint', {
          file: 'ContentView.swift',
          line: 42,
        });
        expectFixture(result, 'add-breakpoint--error-no-session', 'error');
      });

      it('remove-breakpoint - error no session', async () => {
        const result = await harness.invoke('debugging', 'remove-breakpoint', { breakpointId: 1 });
        expectFixture(result, 'remove-breakpoint--error-no-session', 'error');
      });

      it('lldb-command - error no session', async () => {
        const result = await harness.invoke('debugging', 'lldb-command', {
          command: 'breakpoint list',
        });
        expectFixture(result, 'lldb-command--error-no-session', 'error');
      });

      it('attach - error no process', async () => {
        const result = await harness.invoke('debugging', 'attach', {
          simulatorId: INVALID_SIMULATOR_ID,
          bundleId: 'com.nonexistent.app',
        });
        expectFixture(result, 'attach--error-no-process', 'error');
      });
    });

    describe('happy path (live debugger session)', () => {
      it('attach - success', async () => {
        const simulatorId = await prepareDebugTarget();
        const result = await harness.invoke('debugging', 'attach', {
          simulatorId,
          bundleId: BUNDLE_ID,
          continueOnAttach: false,
        });
        debugSessionId = debugSessionIdFromResult(result);
        expectFixture(result, 'attach--success', 'success');
      });

      it('stack - success', async () => {
        const simulatorId = await prepareDebugTarget();
        const sessionId = await attachForSetup(simulatorId);
        const result = await harness.invoke('debugging', 'stack', { debugSessionId: sessionId });
        expectFixture(result, 'stack--success', 'success');
      });

      it('variables - success', async () => {
        const simulatorId = await prepareDebugTarget();
        const sessionId = await attachForSetup(simulatorId);
        const result = await harness.invoke('debugging', 'variables', {
          debugSessionId: sessionId,
        });
        expectFixture(result, 'variables--success', 'success');
      });

      it('add-breakpoint - success', async () => {
        const simulatorId = await prepareDebugTarget();
        const sessionId = await attachForSetup(simulatorId);
        const result = await harness.invoke('debugging', 'add-breakpoint', {
          debugSessionId: sessionId,
          file: 'ContentView.swift',
          line: 42,
        });
        expectFixture(result, 'add-breakpoint--success', 'success');
      });

      it('continue - success', async () => {
        const simulatorId = await prepareDebugTarget();
        const sessionId = await attachForSetup(simulatorId);
        const result = await harness.invoke('debugging', 'continue', {
          debugSessionId: sessionId,
        });
        expectFixture(result, 'continue--success', 'success');
      });

      it('lldb-command - success', async () => {
        const simulatorId = await prepareDebugTarget();
        const sessionId = await attachForSetup(simulatorId);
        const result = await harness.invoke('debugging', 'lldb-command', {
          debugSessionId: sessionId,
          command: 'breakpoint list',
        });
        expectFixture(result, 'lldb-command--success', 'success');
      });

      it('remove-breakpoint - success', async () => {
        const simulatorId = await prepareDebugTarget();
        const sessionId = await attachForSetup(simulatorId);
        const addResult = await harness.invoke('debugging', 'add-breakpoint', {
          debugSessionId: sessionId,
          file: 'ContentView.swift',
          line: 42,
        });
        const result = await harness.invoke('debugging', 'remove-breakpoint', {
          debugSessionId: sessionId,
          breakpointId: breakpointIdFromResult(addResult),
        });
        expectFixture(result, 'remove-breakpoint--success', 'success');
      });

      it('detach - success', async () => {
        const simulatorId = await prepareDebugTarget();
        const sessionId = await attachForSetup(simulatorId);
        const result = await harness.invoke('debugging', 'detach', {
          debugSessionId: sessionId,
        });
        expectFixture(result, 'detach--success', 'success');
        debugSessionId = undefined;
      });

      it('attach - success (continue on attach)', async () => {
        const simulatorId = await prepareDebugTarget();
        const result = await harness.invoke('debugging', 'attach', {
          simulatorId,
          bundleId: BUNDLE_ID,
          continueOnAttach: true,
        });
        debugSessionId = debugSessionIdFromResult(result);
        expectFixture(result, 'attach--success-continue', 'success');
      });
    });
  });
}
