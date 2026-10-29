import { describe, it, expect } from 'vitest';
import * as z from 'zod';
import {
  createMockCommandResponse,
  createMockExecutor,
  type CommandExecutor,
} from '../../../../test-utils/mock-executors.ts';
import { schema, handler, sim_statusbarLogic } from '../sim_statusbar.ts';
import {
  allText,
  callHandler,
  createMockToolHandlerContext,
  runLogic,
} from '../../../../test-utils/test-helpers.ts';

const SIMULATOR_ID = '00000000-0000-0000-0000-000000000000';

describe('sim_statusbar tool', () => {
  describe('Schema Validation', () => {
    it('should expose public schema without simulatorId field', () => {
      const schemaObj = z.object(schema);

      expect(schemaObj.safeParse({ dataNetwork: 'wifi' }).success).toBe(true);
      expect(schemaObj.safeParse({ dataNetwork: 'clear' }).success).toBe(true);
      expect(schemaObj.safeParse({ dataNetwork: 'invalid' }).success).toBe(false);

      const withSimId = schemaObj.safeParse({ simulatorId: 'test-uuid', dataNetwork: 'wifi' });
      expect(withSimId.success).toBe(true);
      expect('simulatorId' in (withSimId.data as object)).toBe(false);
    });

    it('should accept status bar overrides without dataNetwork', () => {
      const schemaObj = z.object(schema);

      expect(
        schemaObj.safeParse({
          time: '9:41',
          wifiMode: 'active',
          wifiBars: 3,
          cellularMode: 'notSupported',
          cellularBars: 0,
          batteryState: 'charged',
          batteryLevel: 100,
        }).success,
      ).toBe(true);
    });

    it('should reject values simctl does not accept', () => {
      const schemaObj = z.object(schema);

      expect(schemaObj.safeParse({ wifiMode: 'connected' }).success).toBe(false);
      expect(schemaObj.safeParse({ wifiBars: 4 }).success).toBe(false);
      expect(schemaObj.safeParse({ cellularMode: 'roaming' }).success).toBe(false);
      expect(schemaObj.safeParse({ cellularBars: 5 }).success).toBe(false);
      expect(schemaObj.safeParse({ batteryState: 'full' }).success).toBe(false);
      expect(schemaObj.safeParse({ batteryLevel: 101 }).success).toBe(false);
      expect(schemaObj.safeParse({ batteryLevel: -1 }).success).toBe(false);
      expect(schemaObj.safeParse({ batteryLevel: 50.5 }).success).toBe(false);
    });
  });

  describe('Handler Validation', () => {
    it('should require at least one status bar field', async () => {
      const result = await callHandler(handler, { simulatorId: SIMULATOR_ID });

      expect(result.isError).toBe(true);
      expect(allText(result)).toContain('Provide at least one status bar field');
    });

    it('should reject dataNetwork clear combined with other fields', async () => {
      const result = await callHandler(handler, {
        simulatorId: SIMULATOR_ID,
        dataNetwork: 'clear',
        batteryLevel: 100,
      });

      expect(result.isError).toBe(true);
      expect(allText(result)).toContain(
        'dataNetwork "clear" removes all status bar overrides and cannot be combined with other status bar fields.',
      );
    });
  });

  describe('Handler Behavior (Complete Literal Returns)', () => {
    it('should handle successful status bar data network setting', async () => {
      const mockExecutor = createMockExecutor({
        success: true,
        output: 'Status bar set successfully',
      });

      const result = await runLogic(() =>
        sim_statusbarLogic(
          {
            simulatorId: 'test-uuid-123',
            dataNetwork: 'wifi',
          },
          mockExecutor,
        ),
      );

      expect(result.isError).toBeFalsy();
    });

    it('should handle command failure', async () => {
      const mockExecutor = createMockExecutor({
        success: false,
        error: 'Simulator not found',
      });

      const result = await runLogic(() =>
        sim_statusbarLogic(
          {
            simulatorId: 'invalid-uuid',
            dataNetwork: '3g',
          },
          mockExecutor,
        ),
      );

      expect(result.isError).toBe(true);
      const text = allText(result);
      expect(text).toContain('Failed to set status bar.');
      expect(text).toContain('Simulator not found');
    });

    it('should handle exception with Error object', async () => {
      const mockExecutor: CommandExecutor = async () => {
        throw new Error('Connection failed');
      };

      const result = await runLogic(() =>
        sim_statusbarLogic(
          {
            simulatorId: 'test-uuid-123',
            dataNetwork: '4g',
          },
          mockExecutor,
        ),
      );

      expect(result.isError).toBe(true);
      const text = allText(result);
      expect(text).toContain('Failed to set status bar.');
      expect(text).toContain('Connection failed');
    });

    it('should verify command generation with mock executor for override', async () => {
      const calls: Array<{
        command: string[];
        operationDescription?: string;
        keepAlive?: boolean;
        opts?: { cwd?: string };
      }> = [];

      const mockExecutor: CommandExecutor = async (
        command,
        operationDescription,
        keepAlive,
        opts,
        detached,
      ) => {
        calls.push({ command, operationDescription, keepAlive, opts });
        void detached;
        return createMockCommandResponse({
          success: true,
          output: 'Status bar set successfully',
          error: undefined,
        });
      };

      await runLogic(() =>
        sim_statusbarLogic(
          {
            simulatorId: 'test-uuid-123',
            dataNetwork: 'wifi',
          },
          mockExecutor,
        ),
      );

      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({
        command: [
          'xcrun',
          'simctl',
          'status_bar',
          'test-uuid-123',
          'override',
          '--dataNetwork',
          'wifi',
        ],
        operationDescription: 'Set Status Bar',
        keepAlive: false,
        opts: undefined,
      });
    });

    it('should verify command generation for clear operation', async () => {
      const calls: Array<{
        command: string[];
        operationDescription?: string;
        keepAlive?: boolean;
        opts?: { cwd?: string };
      }> = [];

      const mockExecutor: CommandExecutor = async (
        command,
        operationDescription,
        keepAlive,
        opts,
        detached,
      ) => {
        calls.push({ command, operationDescription, keepAlive, opts });
        void detached;
        return createMockCommandResponse({
          success: true,
          output: 'Status bar cleared successfully',
          error: undefined,
        });
      };

      await runLogic(() =>
        sim_statusbarLogic(
          {
            simulatorId: 'test-uuid-123',
            dataNetwork: 'clear',
          },
          mockExecutor,
        ),
      );

      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({
        command: ['xcrun', 'simctl', 'status_bar', 'test-uuid-123', 'clear'],
        operationDescription: 'Set Status Bar',
        keepAlive: false,
        opts: undefined,
      });
    });

    it('should handle successful clear operation', async () => {
      const mockExecutor = createMockExecutor({
        success: true,
        output: 'Status bar cleared successfully',
      });

      const result = await runLogic(() =>
        sim_statusbarLogic(
          {
            simulatorId: 'test-uuid-123',
            dataNetwork: 'clear',
          },
          mockExecutor,
        ),
      );

      expect(result.isError).toBeFalsy();
      expect(allText(result)).toContain('Status bar overrides cleared');
    });

    it('should pass every supplied override to a single simctl override call', async () => {
      const commands: string[][] = [];
      const mockExecutor: CommandExecutor = async (command) => {
        commands.push(command);
        return createMockCommandResponse({ success: true, output: '' });
      };

      const result = await runLogic(() =>
        sim_statusbarLogic(
          {
            simulatorId: 'test-uuid-123',
            batteryLevel: 100,
            batteryState: 'charged',
            cellularBars: 4,
            cellularMode: 'active',
            wifiBars: 3,
            wifiMode: 'active',
            dataNetwork: '5g',
            time: '9:41',
          },
          mockExecutor,
        ),
      );

      expect(result.isError).toBeFalsy();
      expect(allText(result)).toContain('Status bar overrides set successfully');
      expect(commands).toEqual([
        [
          'xcrun',
          'simctl',
          'status_bar',
          'test-uuid-123',
          'override',
          '--time',
          '9:41',
          '--dataNetwork',
          '5g',
          '--wifiMode',
          'active',
          '--wifiBars',
          '3',
          '--cellularMode',
          'active',
          '--cellularBars',
          '4',
          '--batteryState',
          'charged',
          '--batteryLevel',
          '100',
        ],
      ]);
    });

    it('should report the applied overrides in structured output', async () => {
      const mockExecutor = createMockExecutor({ success: true, output: '' });
      const { ctx, run } = createMockToolHandlerContext();

      await run(() =>
        sim_statusbarLogic(
          {
            simulatorId: 'test-uuid-123',
            time: '9:41',
            batteryState: 'charging',
            batteryLevel: 0,
            wifiBars: 0,
          },
          mockExecutor,
        ),
      );

      expect(ctx.structuredOutput).toEqual({
        schema: 'mobilebuildmcp.output.simulator-action-result',
        schemaVersion: '3',
        result: {
          kind: 'simulator-action-result',
          didError: false,
          error: null,
          summary: { status: 'SUCCEEDED' },
          action: {
            type: 'statusbar',
            time: '9:41',
            wifiBars: 0,
            batteryState: 'charging',
            batteryLevel: 0,
          },
          artifacts: { simulatorId: 'test-uuid-123' },
        },
      });
    });
  });
});
