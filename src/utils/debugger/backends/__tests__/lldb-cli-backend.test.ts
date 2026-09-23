import { describe, expect, it } from 'vitest';
import {
  createMockInteractiveSpawner,
  type MockInteractiveSession,
} from '../../../../test-utils/mock-executors.ts';
import { createLldbCliBackend } from '../lldb-cli-backend.ts';

const SENTINEL_COMMAND = 'script print("__MOBILEBUILDMCP_DONE__")';
const SENTINEL_OUTPUT = '\n__MOBILEBUILDMCP_DONE__\nMOBILEBUILDMCP_LLDB> ';

function emitSentinel(session: MockInteractiveSession): void {
  session.stdout.write(SENTINEL_OUTPUT);
}

describe('LldbCliBackend', () => {
  it('reports a resumed process as running without waiting for it to stop', async () => {
    const commands: string[] = [];
    let sentinelCount = 0;
    const spawner = createMockInteractiveSpawner({
      onWrite(data, session) {
        commands.push(data);
        if (data.includes(SENTINEL_COMMAND) && sentinelCount++ === 0) {
          emitSentinel(session);
        }
      },
    });
    const backend = await createLldbCliBackend(spawner);

    await backend.resume();
    await expect(backend.getExecutionState({ timeoutMs: 10 })).resolves.toEqual({
      status: 'running',
      description: 'Process is running',
    });
    expect(commands).not.toContain('process status\n');
    await backend.dispose();
  });

  it('does not report stale running state after LLDB exits', async () => {
    let session: MockInteractiveSession | undefined;
    let sentinelCount = 0;
    const spawner = createMockInteractiveSpawner({
      onSpawn(spawnedSession) {
        session = spawnedSession;
      },
      onWrite(data, spawnedSession) {
        if (data.includes(SENTINEL_COMMAND) && sentinelCount++ === 0) {
          emitSentinel(spawnedSession);
        }
      },
    });
    const backend = await createLldbCliBackend(spawner);

    await backend.resume();
    session?.emitExit(9);

    await expect(backend.getExecutionState()).resolves.toEqual({
      status: 'terminated',
      description: 'LLDB process exited (code 9)',
    });
    await backend.dispose();
    await expect(backend.getExecutionState()).resolves.toEqual({
      status: 'unknown',
      description: 'LLDB backend disposed',
    });
  });

  it('drains continue output before returning the next command output', async () => {
    const spawner = createMockInteractiveSpawner({
      onWrite(data, session) {
        if (data === 'process continue\n') {
          session.stdout.write('Process resumed and later stopped\n');
        } else if (data === 'process status\n') {
          session.stdout.write('Process 42 stopped\n');
        } else if (data.includes(SENTINEL_COMMAND)) {
          emitSentinel(session);
        }
      },
    });
    const backend = await createLldbCliBackend(spawner);

    await backend.resume();
    const output = await backend.runCommand('process status');

    expect(output).toBe('Process 42 stopped');
    await backend.dispose();
  });

  it('keeps breakpoint values on a single LLDB command line', async () => {
    const commands: string[] = [];
    const spawner = createMockInteractiveSpawner({
      onWrite(data, session) {
        commands.push(data);
        if (data.startsWith('breakpoint set')) {
          session.stdout.write('Breakpoint 1: resolved\n');
        } else if (data.startsWith('breakpoint modify')) {
          session.stdout.write('Breakpoint 1: modified\n');
        } else if (data.includes(SENTINEL_COMMAND)) {
          emitSentinel(session);
        }
      },
    });
    const backend = await createLldbCliBackend(spawner);

    await backend.addBreakpoint(
      {
        kind: 'file-line',
        file: 'Example".swift\nplatform shell echo injected',
        line: 12,
      },
      { condition: 'value == "ok"\nplatform shell echo injected' },
    );

    const breakpointCommands = commands.filter((command) => command.startsWith('breakpoint'));
    expect(breakpointCommands).toEqual([
      'breakpoint set --file "Example\\".swift\\nplatform shell echo injected" --line 12\n',
      'breakpoint modify -c "value == \\"ok\\"\\nplatform shell echo injected" 1\n',
    ]);
    expect(breakpointCommands.every((command) => command.split('\n').length === 2)).toBe(true);
    await backend.dispose();
  });

  it('escapes named breakpoint values', async () => {
    const commands: string[] = [];
    const spawner = createMockInteractiveSpawner({
      onWrite(data, session) {
        commands.push(data);
        if (data.startsWith('breakpoint set')) {
          session.stdout.write('Breakpoint 1: resolved\n');
        } else if (data.includes(SENTINEL_COMMAND)) {
          emitSentinel(session);
        }
      },
    });
    const backend = await createLldbCliBackend(spawner);

    await backend.addBreakpoint({ kind: 'function', name: 'run"\nprocess detach' });

    expect(commands.find((command) => command.startsWith('breakpoint set'))).toBe(
      'breakpoint set --name "run\\"\\nprocess detach"\n',
    );
    await backend.dispose();
  });
});
