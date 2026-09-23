import { describe, it, expect } from 'vitest';
import * as z from 'zod';
import {
  createMockCommandResponse,
  createMockExecutor,
} from '../../../../test-utils/mock-executors.ts';
import { createMockToolHandlerContext } from '../../../../test-utils/test-helpers.ts';

import {
  createListSimsExecutor,
  schema,
  handler,
  list_simsLogic,
  listSimulators,
} from '../list_sims.ts';
import type { CommandExecutor } from '../../../../utils/execution/index.ts';

async function runListSimsLogic(params: { enabled?: boolean }, executor: CommandExecutor) {
  const { ctx, result, run } = createMockToolHandlerContext();
  await run(() => list_simsLogic(params, executor));
  return {
    content: [{ type: 'text' as const, text: result.text() }],
    isError: result.isError() || undefined,
    nextStepParams: ctx.nextStepParams,
    structuredOutput: ctx.structuredOutput,
  };
}

describe('list_sims tool', () => {
  let callHistory: Array<{
    command: string[];
    logPrefix?: string;
    useShell?: boolean;
    env?: Record<string, string>;
  }>;

  callHistory = [];

  describe('Export Field Validation (Literal)', () => {
    it('should have handler function', () => {
      expect(typeof handler).toBe('function');
    });

    it('should have correct schema with enabled boolean field', () => {
      const schemaObj = z.object(schema);

      expect(schemaObj.safeParse({ enabled: true }).success).toBe(true);
      expect(schemaObj.safeParse({ enabled: false }).success).toBe(true);
      expect(schemaObj.safeParse({ enabled: undefined }).success).toBe(true);
      expect(schemaObj.safeParse({}).success).toBe(true);

      expect(schemaObj.safeParse({ enabled: 'yes' }).success).toBe(false);
      expect(schemaObj.safeParse({ enabled: 1 }).success).toBe(false);
      expect(schemaObj.safeParse({ enabled: null }).success).toBe(false);
    });
  });

  describe('Handler Behavior (Complete Literal Returns)', () => {
    it('returns structured simulator records for setup flows', async () => {
      const mockExecutor = createMockExecutor({
        success: true,
        output: JSON.stringify({
          devices: {
            'iOS 17.0': [
              {
                name: 'iPhone 15',
                udid: 'test-uuid-123',
                isAvailable: true,
                state: 'Shutdown',
              },
            ],
          },
        }),
        error: undefined,
      });

      const simulators = await listSimulators(mockExecutor);
      expect(simulators).toEqual([
        {
          runtime: 'iOS 17.0',
          name: 'iPhone 15',
          udid: 'test-uuid-123',
          state: 'Shutdown',
          isAvailable: true,
        },
      ]);
    });

    it('should handle successful simulator listing', async () => {
      const mockJsonOutput = JSON.stringify({
        devices: {
          'iOS 17.0': [
            {
              name: 'iPhone 15',
              udid: 'test-uuid-123',
              isAvailable: true,
              state: 'Shutdown',
            },
          ],
        },
      });

      const mockExecutor = async (
        command: string[],
        logPrefix?: string,
        useShell?: boolean,
        opts?: { env?: Record<string, string> },
        detached?: boolean,
      ) => {
        callHistory.push({ command, logPrefix, useShell, env: opts?.env });
        void detached;

        return createMockCommandResponse({
          success: true,
          output: mockJsonOutput,
          error: undefined,
        });
      };

      const result = await runListSimsLogic({ enabled: true }, mockExecutor);

      expect(callHistory).toHaveLength(1);
      expect(callHistory[0]).toEqual({
        command: ['xcrun', 'simctl', 'list', 'devices', '--json'],
        logPrefix: 'List Simulators',
        useShell: false,
        env: undefined,
      });

      const text = result.content.map((c) => c.text).join('\n');
      expect(text).toContain('List Simulators');
      expect(text).toContain('iOS 17.0');
      expect(text).toContain('iPhone 15');
      expect(text).toContain('Shutdown');
      expect(result.structuredOutput).toEqual({
        schema: 'mobilebuildmcp.output.simulator-list',
        schemaVersion: '2',
        result: {
          kind: 'simulator-list',
          didError: false,
          error: null,
          simulators: [
            {
              name: 'iPhone 15',
              simulatorId: 'test-uuid-123',
              state: 'Shutdown',
              isAvailable: true,
              runtime: 'iOS 17.0',
            },
          ],
        },
      });
      expect(result.nextStepParams).toEqual({
        boot_sim: { simulatorId: 'UUID_FROM_ABOVE' },
        open_sim: {},
        build_sim: { scheme: 'YOUR_SCHEME', simulatorId: 'UUID_FROM_ABOVE' },
        get_sim_app_path: {
          scheme: 'YOUR_SCHEME',
          platform: 'iOS Simulator',
          simulatorId: 'UUID_FROM_ABOVE',
        },
      });
    });

    it('should handle successful listing with booted simulator', async () => {
      const mockExecutor = createMockExecutor({
        success: true,
        output: JSON.stringify({
          devices: {
            'iOS 17.0': [
              {
                name: 'iPhone 15',
                udid: 'test-uuid-123',
                isAvailable: true,
                state: 'Booted',
              },
            ],
          },
        }),
        error: undefined,
      });

      const result = await runListSimsLogic({ enabled: true }, mockExecutor);

      const text = result.content.map((c) => c.text).join('\n');
      expect(text).toContain('List Simulators');
      expect(text).toContain('iOS 17.0');
      expect(text).toContain('iPhone 15');
      expect(text).toContain('Booted');
      expect(result.nextStepParams).toEqual({
        boot_sim: { simulatorId: 'UUID_FROM_ABOVE' },
        open_sim: {},
        build_sim: { scheme: 'YOUR_SCHEME', simulatorId: 'UUID_FROM_ABOVE' },
        get_sim_app_path: {
          scheme: 'YOUR_SCHEME',
          platform: 'iOS Simulator',
          simulatorId: 'UUID_FROM_ABOVE',
        },
      });
    });

    it('should handle command failure', async () => {
      const mockExecutor = createMockExecutor({
        success: false,
        output: '',
        error: 'Command failed',
        process: { pid: 12345 },
      });

      const result = await runListSimsLogic({ enabled: true }, mockExecutor);

      const text = result.content.map((c) => c.text).join('\n');
      expect(text).toContain('Failed to list simulators: Command failed');
      expect(result.isError).toBe(true);
      expect(result.structuredOutput).toEqual({
        schema: 'mobilebuildmcp.output.simulator-list',
        schemaVersion: '2',
        result: {
          kind: 'simulator-list',
          didError: true,
          error: 'Failed to list simulators: Command failed',
          simulators: [],
        },
      });
    });

    it('should handle JSON parse failure', async () => {
      const mockExecutor = createMockExecutor({
        success: true,
        output: 'invalid json',
        error: undefined,
      });

      const result = await runListSimsLogic({ enabled: true }, mockExecutor);

      const text = result.content.map((c) => c.text).join('\n');
      expect(text).toContain('Failed to list simulators:');
      expect(result.isError).toBe(true);
    });

    it('should handle exception with Error object', async () => {
      const mockExecutor = createMockExecutor(new Error('Command execution failed'));

      const result = await runListSimsLogic({ enabled: true }, mockExecutor);

      const text = result.content.map((c) => c.text).join('\n');
      expect(text).toContain('Failed to list simulators: Command execution failed');
      expect(result.isError).toBe(true);
    });

    it('should handle exception with string error', async () => {
      const mockExecutor = createMockExecutor('String error');

      const result = await runListSimsLogic({ enabled: true }, mockExecutor);

      const text = result.content.map((c) => c.text).join('\n');
      expect(text).toContain('Failed to list simulators: String error');
      expect(result.isError).toBe(true);
    });

    it('returns a domain result and progress events from the executor', async () => {
      const mockExecutor = createMockExecutor({
        success: true,
        output: JSON.stringify({
          devices: {
            'com.apple.CoreSimulator.SimRuntime.iOS-17-0': [
              {
                name: 'iPhone 15',
                udid: 'test-uuid-123',
                isAvailable: true,
                state: 'Shutdown',
              },
            ],
          },
        }),
        error: undefined,
      });
      const executeListSims = createListSimsExecutor(mockExecutor);

      const result = await executeListSims({});
      expect(result).toEqual({
        kind: 'simulator-list',
        didError: false,
        error: null,
        simulators: [
          {
            name: 'iPhone 15',
            simulatorId: 'test-uuid-123',
            state: 'Shutdown',
            isAvailable: true,
            runtime: 'iOS 17.0',
          },
        ],
      });
    });
  });
});
