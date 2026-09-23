import { chmod, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { __getRealCommandExecutor } from '../command.ts';

describe('defaultExecutor', () => {
  it('passes arguments literally when shell execution is requested', async () => {
    const executor = __getRealCommandExecutor();
    const argumentsWithMetacharacters = [
      '$(printf injected)',
      '`printf injected`',
      'value; printf injected',
      '$HOME',
      "single'quote",
    ];

    const result = await executor(
      ['/usr/bin/printf', '%s\n', ...argumentsWithMetacharacters],
      'Shell Argument Test',
      true,
    );

    expect(result).toMatchObject({
      success: true,
      exitCode: 0,
      output: `${argumentsWithMetacharacters.join('\n')}\n`,
    });
  });

  it('treats a leading-dash executable as a command name when shell execution is requested', async () => {
    const executableDirectory = await mkdtemp(join(tmpdir(), 'mobilebuildmcp-command-'));
    const executablePath = join(executableDirectory, '-c');
    await writeFile(executablePath, '#!/bin/sh\nprintf "%s\\n" "$@"\n', 'utf8');
    await chmod(executablePath, 0o700);

    try {
      const executor = __getRealCommandExecutor();
      const result = await executor(['-c', 'literal argument'], 'Shell Executable Test', true, {
        env: { PATH: executableDirectory },
      });

      expect(result).toMatchObject({
        success: true,
        exitCode: 0,
        output: 'literal argument\n',
      });
    } finally {
      await rm(executableDirectory, { recursive: true, force: true });
    }
  });

  it('returns an exit response when a shell-mode executable is missing', async () => {
    const executor = __getRealCommandExecutor();
    const result = await executor(
      ['mobilebuildmcp-command-that-does-not-exist'],
      'Missing Shell Executable Test',
      true,
    );

    expect(result).toMatchObject({
      success: false,
      exitCode: 127,
    });
  });

  it('settles after exit even when child close is delayed', async () => {
    const executor = __getRealCommandExecutor();
    const startedAt = Date.now();

    const result = await executor(
      ['/bin/sh', '-lc', '(sleep 1) & echo launch failed 1>&2; exit 7'],
      'Test Run',
    );

    const durationMs = Date.now() - startedAt;

    expect(result).toMatchObject({
      success: false,
      exitCode: 7,
      error: 'launch failed\n',
    });
    expect(durationMs).toBeLessThan(900);
  });

  it('does not attach stdout or stderr listeners for detached commands', async () => {
    const executor = __getRealCommandExecutor();
    const result = await executor(
      ['/bin/sh', '-lc', 'sleep 1'],
      'Detached Test',
      false,
      undefined,
      true,
    );

    try {
      expect(result.process.stdout?.listenerCount('data') ?? 0).toBe(0);
      expect(result.process.stderr?.listenerCount('data') ?? 0).toBe(0);
    } finally {
      result.process.kill('SIGKILL');
    }
  });
});
