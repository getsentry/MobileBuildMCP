import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runDirectory } from '../run-directory.ts';

describe('runDirectory', () => {
  it('continues running later suites after an earlier suite returns non-zero', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'mobilebuildmcp-bench-suites-'));
    try {
      await writeFile(path.join(directory, 'a.yml'), 'name: a\n', 'utf8');
      await writeFile(path.join(directory, 'b.yml'), 'name: b\n', 'utf8');
      await writeFile(path.join(directory, 'c.yml'), 'name: c\n', 'utf8');

      const calls: string[][] = [];
      const exitCode = await runDirectory(
        [directory, 'private', '--model', 'opus'],
        async (args) => {
          calls.push(args);
          return args[1]?.endsWith('b.yml') ? 1 : 0;
        },
      );

      expect(exitCode).toBe(1);
      expect(calls).toEqual([
        ['--suite', path.join(directory, 'a.yml'), '--model', 'opus'],
        ['--suite', path.join(directory, 'b.yml'), '--model', 'opus'],
        ['--suite', path.join(directory, 'c.yml'), '--model', 'opus'],
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
