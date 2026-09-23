import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as z from 'zod';
import {
  createMockExecutor,
  createMockCommandResponse,
} from '../../../../test-utils/mock-executors.ts';
import type { CommandExecutor } from '../../../../utils/execution/index.ts';
import { sessionStore } from '../../../../utils/session-store.ts';
import {
  clearAllSimulatorLaunchOsLogSessionsForTests,
  registerSimulatorLaunchOsLogSession,
  setSimulatorLaunchOsLogRegistryDirOverrideForTests,
} from '../../../../utils/log-capture/simulator-launch-oslog-sessions.ts';
import { setSimulatorLaunchOsLogRecordActiveOverrideForTests } from '../../../../utils/log-capture/simulator-launch-oslog-registry.ts';
import { schema, handler, stop_app_simLogic } from '../stop_app_sim.ts';
import { allText, runLogic, callHandler } from '../../../../test-utils/test-helpers.ts';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { setRuntimeInstanceForTests } from '../../../../utils/runtime-instance.ts';

const availableSimulatorsJson = JSON.stringify({
  devices: {
    'iOS 26.0': [{ name: 'iPhone 17', udid: 'resolved-uuid', isAvailable: true }],
  },
});

function createTrackedChild(options?: {
  pid?: number;
  killImplementation?: (signal?: NodeJS.Signals | number) => boolean;
}): ChildProcess {
  const emitter = new EventEmitter();
  const child = emitter as ChildProcess;
  let exitCode: number | null = null;
  const pid = options?.pid ?? nextPid++;

  Object.defineProperty(child, 'pid', { value: pid, configurable: true });
  Object.defineProperty(child, 'exitCode', {
    configurable: true,
    get: () => exitCode,
    set: (value: number | null) => {
      exitCode = value;
    },
  });

  trackedChildren.set(pid, child);

  child.kill = vi.fn((signal?: NodeJS.Signals | number) => {
    if (options?.killImplementation) {
      return options.killImplementation(signal);
    }
    exitCode = 0;
    queueMicrotask(() => {
      emitter.emit('exit', 0, signal);
      emitter.emit('close', 0, signal);
    });
    return true;
  }) as ChildProcess['kill'];

  return child;
}

let registryDir: string;
let nextPid = 1234;
const trackedChildren = new Map<number, ChildProcess>();

describe('stop_app_sim tool', () => {
  beforeEach(async () => {
    nextPid = 1234;
    trackedChildren.clear();
    registryDir = mkdtempSync(path.join(tmpdir(), 'mobilebuildmcp-stop-app-sim-'));
    setSimulatorLaunchOsLogRegistryDirOverrideForTests(registryDir);
    setRuntimeInstanceForTests({
      instanceId: 'stop-app-sim-test',
      pid: process.pid,
      workspaceKey: 'workspace-a',
    });
    setSimulatorLaunchOsLogRecordActiveOverrideForTests(async (record) => {
      const child = trackedChildren.get(record.helperPid);
      return child ? child.exitCode == null : true;
    });
    sessionStore.clear();
    await clearAllSimulatorLaunchOsLogSessionsForTests();
  });

  afterEach(async () => {
    sessionStore.clear();
    await clearAllSimulatorLaunchOsLogSessionsForTests();
    setSimulatorLaunchOsLogRecordActiveOverrideForTests(null);
    setRuntimeInstanceForTests(null);
    setSimulatorLaunchOsLogRegistryDirOverrideForTests(null);
    trackedChildren.clear();
    await rm(registryDir, { recursive: true, force: true });
  });

  describe('Export Field Validation (Literal)', () => {
    it('should expose empty public schema', () => {
      const schemaObj = z.object(schema);

      expect(schemaObj.safeParse({}).success).toBe(true);
      expect(schemaObj.safeParse({ bundleId: 'io.sentry.app' }).success).toBe(true);
      expect(schemaObj.safeParse({ bundleId: 42 }).success).toBe(true);
      expect(Object.keys(schema)).toEqual([]);

      const withSessionDefaults = schemaObj.safeParse({
        simulatorId: 'SIM-UUID',
        simulatorName: 'iPhone 17',
      });
      expect(withSessionDefaults.success).toBe(true);
      const parsed = withSessionDefaults.data as Record<string, unknown>;
      expect(parsed.simulatorId).toBeUndefined();
      expect(parsed.simulatorName).toBeUndefined();
    });
  });

  describe('Handler Requirements', () => {
    it('should require simulator identifier when not provided', async () => {
      const result = await callHandler(handler, { bundleId: 'io.sentry.app' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Missing required session defaults');
      expect(result.content[0].text).toContain('Provide simulatorId or simulatorName');
      expect(result.content[0].text).toContain('session-set-defaults');
    });

    it('should require bundleId when simulatorId default exists', async () => {
      sessionStore.setDefaults({ simulatorId: 'SIM-UUID' });

      const result = await callHandler(handler, {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Missing required session defaults');
      expect(result.content[0].text).toContain('bundleId is required');
    });

    it('should reject mutually exclusive simulator parameters', async () => {
      const result = await callHandler(handler, {
        simulatorId: 'SIM-UUID',
        simulatorName: 'iPhone 17',
        bundleId: 'io.sentry.app',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Mutually exclusive parameters provided');
      expect(result.content[0].text).toContain('simulatorId');
      expect(result.content[0].text).toContain('simulatorName');
    });
  });

  describe('Logic Behavior (Literal Returns)', () => {
    it('should stop app successfully with simulatorId', async () => {
      const mockExecutor = createMockExecutor({ success: true, output: '' });

      const result = await runLogic(() =>
        stop_app_simLogic(
          {
            simulatorId: 'test-uuid',
            bundleId: 'io.sentry.App',
          },
          mockExecutor,
        ),
      );

      const text = allText(result);
      expect(text).toContain('Stop App');
      expect(text).toContain('io.sentry.App');
      expect(text).toContain('stopped successfully');
      expect(text).toContain('test-uuid');
    });

    it('stops tracked OSLog sessions alongside the app', async () => {
      const mockExecutor = createMockExecutor({ success: true, output: '' });
      const child = createTrackedChild();
      await registerSimulatorLaunchOsLogSession({
        process: child,
        simulatorUuid: 'test-uuid',
        bundleId: 'io.sentry.App',
        logFilePath: '/tmp/app.log',
      });

      const result = await runLogic(() =>
        stop_app_simLogic(
          {
            simulatorId: 'test-uuid',
            bundleId: 'io.sentry.App',
          },
          mockExecutor,
        ),
      );

      const text = allText(result);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(text).toContain('stopped successfully');
      expect(text).not.toContain('Tracked OSLog sessions cleaned up');
    });

    it('should resolve simulatorName before stopping', async () => {
      const calls: string[][] = [];
      const mockExecutor: CommandExecutor = async (command) => {
        calls.push(command);
        if (command.includes('list')) {
          return createMockCommandResponse({ success: true, output: availableSimulatorsJson });
        }
        return createMockCommandResponse({ success: true, output: '' });
      };

      const result = await runLogic(() =>
        stop_app_simLogic(
          {
            simulatorName: 'iPhone 17',
            bundleId: 'io.sentry.App',
          },
          mockExecutor,
        ),
      );

      expect(result.isError).toBeFalsy();
      expect(calls).toEqual([
        ['xcrun', 'simctl', 'list', 'devices', 'available', '-j'],
        ['xcrun', 'simctl', 'terminate', 'resolved-uuid', 'io.sentry.App'],
      ]);
    });

    it('should display friendly name when simulatorName is provided alongside resolved simulatorId', async () => {
      const mockExecutor = createMockExecutor({ success: true, output: '' });

      const result = await runLogic(() =>
        stop_app_simLogic(
          {
            simulatorId: 'resolved-uuid',
            simulatorName: 'iPhone 17',
            bundleId: 'io.sentry.App',
          },
          mockExecutor,
        ),
      );

      const text = allText(result);
      expect(text).toContain('Stop App');
      expect(text).toContain('io.sentry.App');
      expect(text).toContain('stopped successfully');
      expect(text).toContain('resolved-uuid');
    });

    it('should surface terminate failures', async () => {
      const terminateExecutor = createMockExecutor({
        success: false,
        output: '',
        error: 'Simulator not found',
      });

      await registerSimulatorLaunchOsLogSession({
        process: createTrackedChild(),
        simulatorUuid: 'invalid-uuid',
        bundleId: 'io.sentry.App',
        logFilePath: '/tmp/app.log',
      });

      const result = await runLogic(() =>
        stop_app_simLogic(
          {
            simulatorId: 'invalid-uuid',
            bundleId: 'io.sentry.App',
          },
          terminateExecutor,
        ),
      );

      const text = allText(result);
      expect(text).toContain('Failed to stop app');
      expect(text).toContain('Simulator not found');
      expect(result.isError).toBe(true);
    });

    it('should report cleanup failures even when terminate succeeds', async () => {
      const mockExecutor = createMockExecutor({ success: true, output: '' });
      await registerSimulatorLaunchOsLogSession({
        process: createTrackedChild({
          killImplementation: () => {
            throw new Error('cleanup boom');
          },
        }),
        simulatorUuid: 'test-uuid',
        bundleId: 'io.sentry.App',
        logFilePath: '/tmp/app.log',
      });

      const result = await runLogic(() =>
        stop_app_simLogic(
          {
            simulatorId: 'test-uuid',
            bundleId: 'io.sentry.App',
          },
          mockExecutor,
        ),
      );

      const text = allText(result);
      expect(text).toContain('OSLog cleanup failed');
      expect(text).toContain('cleanup boom');
      expect(result.isError).toBe(true);
    });

    it('should handle unexpected exceptions', async () => {
      const throwingExecutor = async () => {
        throw new Error('Unexpected error');
      };

      const result = await runLogic(() =>
        stop_app_simLogic(
          {
            simulatorId: 'test-uuid',
            bundleId: 'io.sentry.App',
          },
          throwingExecutor,
        ),
      );

      const text = allText(result);
      expect(text).toContain('Failed to stop app');
      expect(text).toContain('Unexpected error');
      expect(result.isError).toBe(true);
    });

    it('should call correct terminate command', async () => {
      const calls: Array<{
        command: string[];
        logPrefix?: string;
        useShell?: boolean;
        opts?: { env?: Record<string, string>; cwd?: string };
        detached?: boolean;
      }> = [];

      const trackingExecutor: CommandExecutor = async (
        command,
        logPrefix,
        useShell,
        opts,
        detached,
      ) => {
        calls.push({ command, logPrefix, useShell, opts, detached });
        return createMockCommandResponse({
          success: true,
          output: '',
          error: undefined,
        });
      };

      await runLogic(() =>
        stop_app_simLogic(
          {
            simulatorId: 'test-uuid',
            bundleId: 'io.sentry.App',
          },
          trackingExecutor,
        ),
      );

      expect(calls).toEqual([
        {
          command: ['xcrun', 'simctl', 'terminate', 'test-uuid', 'io.sentry.App'],
          logPrefix: 'Stop App in Simulator',
          useShell: false,
          opts: undefined,
          detached: undefined,
        },
      ]);
    });
  });
});
