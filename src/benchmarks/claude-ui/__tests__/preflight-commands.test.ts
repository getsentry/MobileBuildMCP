import { preflightCommandsWithFocusResign } from '../preflight-commands.ts';

const HEADLESS_ENV_VAR = 'MOBILEBUILDMCP_HEADLESS_LAUNCH';

describe('Claude UI benchmark preflight commands', () => {
  let previousHeadlessValue: string | undefined;

  beforeEach(() => {
    previousHeadlessValue = process.env[HEADLESS_ENV_VAR];
    delete process.env[HEADLESS_ENV_VAR];
  });

  afterEach(() => {
    if (previousHeadlessValue === undefined) {
      delete process.env[HEADLESS_ENV_VAR];
    } else {
      process.env[HEADLESS_ENV_VAR] = previousHeadlessValue;
    }
  });
  it('resigns focus to the target Simulator after launching RocketSim.app', () => {
    expect(
      preflightCommandsWithFocusResign({
        commands: ['killall -9 RocketSim || true', 'sleep 2', 'open -gja RocketSim', 'sleep 10'],
        simulatorId: 'SIM-123',
      }),
    ).toEqual([
      'killall -9 RocketSim || true',
      'sleep 2',
      'open -gja RocketSim',
      "open 'devices:///manage/select?id=SIM-123' || open -a Simulator --args -CurrentDeviceUDID SIM-123",
      'sleep 10',
    ]);
  });

  it('keeps preflight commands unchanged when no target simulator is resolved', () => {
    const commands = ['open -gja RocketSim'];

    expect(preflightCommandsWithFocusResign({ commands })).toBe(commands);
  });

  it('detects simple and path-based RocketSim launch commands', () => {
    expect(
      preflightCommandsWithFocusResign({
        commands: ['open RocketSim', 'open /Applications/RocketSim.app'],
        simulatorId: 'SIM-123',
      }),
    ).toEqual([
      'open RocketSim',
      "open 'devices:///manage/select?id=SIM-123' || open -a Simulator --args -CurrentDeviceUDID SIM-123",
      'open /Applications/RocketSim.app',
      "open 'devices:///manage/select?id=SIM-123' || open -a Simulator --args -CurrentDeviceUDID SIM-123",
    ]);
  });

  it('shell-quotes simulator IDs used by the focus command', () => {
    expect(
      preflightCommandsWithFocusResign({
        commands: ['open -a RocketSim.app'],
        simulatorId: "SIM'123",
      }),
    ).toEqual([
      'open -a RocketSim.app',
      "open 'devices:///manage/select?id=SIM%27123' || open -a Simulator --args -CurrentDeviceUDID 'SIM'\"'\"'123'",
    ]);
  });

  it('does not inject simulator frontend focus commands in headless launch mode', () => {
    process.env[HEADLESS_ENV_VAR] = '1';
    const commands = ['open -gja RocketSim'];

    expect(preflightCommandsWithFocusResign({ commands, simulatorId: 'SIM-123' })).toBe(commands);
  });
});
