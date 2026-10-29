import { describe, it, expect, beforeEach } from 'vitest';
import * as z from 'zod';
import {
  createMockCommandResponse,
  createMockExecutor,
} from '../../../../test-utils/mock-executors.ts';
import { sessionStore } from '../../../../utils/session-store.ts';
import { schema, handler, shutdown_simLogic } from '../shutdown_sim.ts';
import {
  allText,
  runLogic,
  callHandler,
  createMockToolHandlerContext,
} from '../../../../test-utils/test-helpers.ts';

const availableSimulatorsJson = JSON.stringify({
  devices: {
    'iOS 26.0': [{ name: 'iPhone 17', udid: 'resolved-uuid', isAvailable: true }],
  },
});

describe('shutdown_sim tool', () => {
  beforeEach(() => {
    sessionStore.clear();
  });

  describe('Export Field Validation (Literal)', () => {
    it('should expose empty public schema', () => {
      const schemaObj = z.object(schema);
      expect(schemaObj.safeParse({}).success).toBe(true);
      expect(Object.keys(schema)).toHaveLength(0);

      const withSimId = schemaObj.safeParse({ simulatorId: 'abc' });
      expect(withSimId.success).toBe(true);
      expect('simulatorId' in (withSimId.data as Record<string, unknown>)).toBe(false);
    });
  });

  describe('Handler Requirements', () => {
    it('should require simulatorId when not provided', async () => {
      const result = await callHandler(handler, {});

      expect(result.isError).toBe(true);
      const message = result.content[0].text;
      expect(message).toContain('Missing required session defaults');
      expect(message).toContain('Provide simulatorId or simulatorName');
      expect(message).toContain('session-set-defaults');
    });

    it('should reject simulatorId and simulatorName together', async () => {
      const result = await callHandler(handler, {
        simulatorId: 'test-uuid-123',
        simulatorName: 'iPhone 17',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(
        'Mutually exclusive parameters provided: simulatorId, simulatorName',
      );
    });
  });

  describe('Logic Behavior (Literal Results)', () => {
    it('should handle successful shutdown', async () => {
      const mockExecutor = createMockExecutor({ success: true, output: '' });
      const { ctx, run } = createMockToolHandlerContext();

      await run(() => shutdown_simLogic({ simulatorId: 'test-uuid-123' }, mockExecutor));

      expect(ctx.structuredOutput).toEqual({
        schema: 'mobilebuildmcp.output.simulator-action-result',
        schemaVersion: '3',
        result: {
          kind: 'simulator-action-result',
          didError: false,
          error: null,
          summary: { status: 'SUCCEEDED' },
          action: { type: 'shutdown' },
          artifacts: { simulatorId: 'test-uuid-123' },
        },
      });
      expect(ctx.nextStepParams).toBeUndefined();
    });

    it('should render shutdown success text', async () => {
      const mockExecutor = createMockExecutor({ success: true, output: '' });

      const result = await runLogic(() =>
        shutdown_simLogic({ simulatorId: 'test-uuid-123' }, mockExecutor),
      );

      const text = allText(result);
      expect(text).toContain('Shut Down Simulator');
      expect(text).toContain('Simulator shut down successfully');
      expect(result.isError).toBeFalsy();
    });

    it('should surface the simctl error for a simulator that is already shut down', async () => {
      const alreadyShutdownError =
        'An error was encountered processing the command (domain=com.apple.CoreSimulator.SimError, code=405):\nUnable to shutdown device in current state: Shutdown\n';
      const mockExecutor = createMockExecutor({ success: false, error: alreadyShutdownError });

      const result = await runLogic(() =>
        shutdown_simLogic({ simulatorId: 'test-uuid-123' }, mockExecutor),
      );

      const text = allText(result);
      expect(text).toContain('Shut down simulator operation failed.');
      expect(text).toContain('Unable to shutdown device in current state: Shutdown');
      expect(result.isError).toBe(true);
    });

    it('should handle exception with Error object', async () => {
      const mockExecutor = async () => {
        throw new Error('Connection failed');
      };

      const result = await runLogic(() =>
        shutdown_simLogic({ simulatorId: 'test-uuid-123' }, mockExecutor),
      );

      const text = allText(result);
      expect(text).toContain('Shut down simulator operation failed.');
      expect(text).toContain('Connection failed');
      expect(result.isError).toBe(true);
    });

    it('should resolve simulatorName before shutting down', async () => {
      const calls: string[][] = [];
      const mockExecutor = async (command: string[]) => {
        calls.push(command);
        if (command.includes('list')) {
          return createMockCommandResponse({ success: true, output: availableSimulatorsJson });
        }
        return createMockCommandResponse({ success: true, output: '' });
      };

      const result = await runLogic(() =>
        shutdown_simLogic({ simulatorName: 'iPhone 17' }, mockExecutor),
      );

      expect(result.isError).toBeFalsy();
      expect(calls).toEqual([
        ['xcrun', 'simctl', 'list', 'devices', 'available', '-j'],
        ['xcrun', 'simctl', 'shutdown', 'resolved-uuid'],
      ]);
    });

    it('should fail without running shutdown when simulatorName cannot be resolved', async () => {
      const calls: string[][] = [];
      const mockExecutor = async (command: string[]) => {
        calls.push(command);
        return createMockCommandResponse({ success: true, output: availableSimulatorsJson });
      };

      const result = await runLogic(() =>
        shutdown_simLogic({ simulatorName: 'iPhone 1' }, mockExecutor),
      );

      expect(result.isError).toBe(true);
      expect(allText(result)).toContain('Failed to resolve simulator');
      expect(calls).toEqual([['xcrun', 'simctl', 'list', 'devices', 'available', '-j']]);
    });

    it('should verify command generation with mock executor', async () => {
      const calls: Array<{
        command: string[];
        description?: string;
        allowStderr?: boolean;
        opts?: { cwd?: string };
      }> = [];
      const mockExecutor = async (
        command: string[],
        description?: string,
        allowStderr?: boolean,
        opts?: { cwd?: string },
      ) => {
        calls.push({ command, description, allowStderr, opts });
        return createMockCommandResponse({ success: true, output: '' });
      };

      await runLogic(() => shutdown_simLogic({ simulatorId: 'test-uuid-123' }, mockExecutor));

      expect(calls).toEqual([
        {
          command: ['xcrun', 'simctl', 'shutdown', 'test-uuid-123'],
          description: 'Shut Down Simulator',
          allowStderr: false,
          opts: undefined,
        },
      ]);
    });
  });
});
