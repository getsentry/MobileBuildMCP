import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildOpenAppCommand,
  buildOpenSimulatorFrontendCommands,
  buildOpenSimulatorAppCommand,
  isHeadlessLaunchMode,
  openSimulatorFrontend,
} from '../focus-policy.ts';
import { createMockCommandResponse } from '../../test-utils/mock-executors.ts';

const ENV_VAR = 'MOBILEBUILDMCP_HEADLESS_LAUNCH';

describe('focus-policy', () => {
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env[ENV_VAR];
    delete process.env[ENV_VAR];
  });

  afterEach(() => {
    if (previous === undefined) {
      delete process.env[ENV_VAR];
    } else {
      process.env[ENV_VAR] = previous;
    }
  });

  describe('isHeadlessLaunchMode', () => {
    it('returns false when unset', () => {
      expect(isHeadlessLaunchMode()).toBe(false);
    });

    it('returns true for "1"', () => {
      process.env[ENV_VAR] = '1';
      expect(isHeadlessLaunchMode()).toBe(true);
    });

    it('returns true for "true" case-insensitive', () => {
      process.env[ENV_VAR] = 'TRUE';
      expect(isHeadlessLaunchMode()).toBe(true);
    });

    it('returns false for "0"', () => {
      process.env[ENV_VAR] = '0';
      expect(isHeadlessLaunchMode()).toBe(false);
    });

    it('returns false for empty string', () => {
      process.env[ENV_VAR] = '';
      expect(isHeadlessLaunchMode()).toBe(false);
    });
  });

  describe('buildOpenAppCommand', () => {
    it('returns plain `open <path>` by default', () => {
      expect(buildOpenAppCommand('/Apps/Foo.app')).toEqual(['open', '/Apps/Foo.app']);
    });

    it('appends --args when args are provided', () => {
      expect(buildOpenAppCommand('/Apps/Foo.app', { args: ['--flag', 'value'] })).toEqual([
        'open',
        '/Apps/Foo.app',
        '--args',
        '--flag',
        'value',
      ]);
    });

    it('inserts -g when headless mode is enabled', () => {
      process.env[ENV_VAR] = '1';
      expect(buildOpenAppCommand('/Apps/Foo.app')).toEqual(['open', '-g', '/Apps/Foo.app']);
    });

    it('preserves --args ordering under headless mode', () => {
      process.env[ENV_VAR] = '1';
      expect(buildOpenAppCommand('/Apps/Foo.app', { args: ['x'] })).toEqual([
        'open',
        '-g',
        '/Apps/Foo.app',
        '--args',
        'x',
      ]);
    });
  });

  describe('buildOpenSimulatorAppCommand', () => {
    it('returns `open -a Simulator` by default', () => {
      expect(buildOpenSimulatorAppCommand()).toEqual(['open', '-a', 'Simulator']);
    });

    it('targets a simulator UDID when provided', () => {
      expect(buildOpenSimulatorAppCommand({ simulatorId: 'SIM-123' })).toEqual([
        'open',
        '-a',
        'Simulator',
        '--args',
        '-CurrentDeviceUDID',
        'SIM-123',
      ]);
    });

    it('returns null in headless mode', () => {
      process.env[ENV_VAR] = '1';
      expect(buildOpenSimulatorAppCommand()).toBeNull();
    });
  });

  describe('buildOpenSimulatorFrontendCommands', () => {
    it('prefers Device Hub and falls back to Simulator.app', () => {
      expect(buildOpenSimulatorFrontendCommands()).toEqual([
        { frontend: 'device-hub', command: ['open', '-a', 'DeviceHub'] },
        { frontend: 'simulator', command: ['open', '-a', 'Simulator'] },
      ]);
    });

    it('targets the requested UDID in both frontends', () => {
      expect(buildOpenSimulatorFrontendCommands({ simulatorId: 'SIM 123' })).toEqual([
        {
          frontend: 'device-hub',
          command: ['open', 'devices:///manage/select?id=SIM%20123'],
        },
        {
          frontend: 'simulator',
          command: ['open', '-a', 'Simulator', '--args', '-CurrentDeviceUDID', 'SIM 123'],
        },
      ]);
    });

    it('returns null in headless mode', () => {
      process.env[ENV_VAR] = '1';
      expect(buildOpenSimulatorFrontendCommands()).toBeNull();
    });
  });

  describe('openSimulatorFrontend', () => {
    it('uses Device Hub when it is available', async () => {
      const commands: string[][] = [];
      const result = await openSimulatorFrontend(async (command) => {
        commands.push(command);
        return createMockCommandResponse({ success: true });
      });

      expect(result).toEqual({ success: true, frontend: 'device-hub' });
      expect(commands).toEqual([['open', '-a', 'DeviceHub']]);
    });

    it('falls back to Simulator.app when Device Hub is unavailable', async () => {
      const commands: string[][] = [];
      const result = await openSimulatorFrontend(async (command) => {
        commands.push(command);
        return createMockCommandResponse({
          success: command.includes('Simulator'),
          error: command.includes('Simulator') ? undefined : 'Device Hub not found',
        });
      });

      expect(result).toEqual({ success: true, frontend: 'simulator' });
      expect(commands).toEqual([
        ['open', '-a', 'DeviceHub'],
        ['open', '-a', 'Simulator'],
      ]);
    });

    it('reports both launch failures', async () => {
      const result = await openSimulatorFrontend(async (command) =>
        createMockCommandResponse({ success: false, error: `${command.at(-1)} not found` }),
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Device Hub: DeviceHub not found');
        expect(result.error).toContain('Simulator.app: Simulator not found');
      }
    });

    it('skips both frontends in headless mode', async () => {
      process.env[ENV_VAR] = '1';
      let called = false;
      const result = await openSimulatorFrontend(async () => {
        called = true;
        return createMockCommandResponse({ success: true });
      });

      expect(result).toEqual({ success: true, frontend: null });
      expect(called).toBe(false);
    });
  });
});
