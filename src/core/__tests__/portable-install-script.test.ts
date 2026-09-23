import { execFileSync } from 'node:child_process';
import type { ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const verifyScriptPath = join(process.cwd(), 'scripts', 'verify-portable-install.sh');
const execOptions = {
  encoding: 'utf8',
  stdio: 'pipe',
} satisfies ExecFileSyncOptionsWithStringEncoding;

function createExecutable(path: string) {
  writeFileSync(path, '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(path, 0o755);
}

function createPortableRoot(root: string) {
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(join(root, 'libexec', 'manifests'), { recursive: true });
  mkdirSync(join(root, 'libexec', 'bundled', 'Frameworks'), { recursive: true });
  mkdirSync(join(root, 'libexec', 'skills'), { recursive: true });
  mkdirSync(join(root, 'libexec', 'schemas', 'structured-output', '_defs'), { recursive: true });
  mkdirSync(
    join(root, 'libexec', 'schemas', 'structured-output', 'mobilebuildmcp.output.session-defaults'),
    { recursive: true },
  );

  createExecutable(join(root, 'bin', 'mobilebuildmcp'));
  createExecutable(join(root, 'bin', 'mobilebuildmcp-doctor'));
  createExecutable(join(root, 'libexec', 'mobilebuildmcp'));
  createExecutable(join(root, 'libexec', 'node-runtime'));
  createExecutable(join(root, 'libexec', 'bundled', 'axe'));
  writeFileSync(
    join(root, 'libexec', 'schemas', 'structured-output', '_defs', 'common.schema.json'),
    '{}',
  );
  writeFileSync(
    join(
      root,
      'libexec',
      'schemas',
      'structured-output',
      'mobilebuildmcp.output.session-defaults',
      '1.schema.json',
    ),
    '{}',
  );
}

describe('verify-portable-install.sh', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `mobilebuildmcp-portable-verify-${process.pid}-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('accepts a portable root containing structured output schemas', () => {
    const root = join(tempDir, 'portable-root');
    createPortableRoot(root);

    expect(() => execFileSync(verifyScriptPath, ['--root', root], execOptions)).not.toThrow();
  });

  it('rejects a portable root missing structured output schemas', () => {
    const root = join(tempDir, 'portable-root');
    createPortableRoot(root);
    rmSync(join(root, 'libexec', 'schemas'), { recursive: true, force: true });

    try {
      execFileSync(verifyScriptPath, ['--root', root], execOptions);
      throw new Error('Expected verify-portable-install.sh to fail');
    } catch (error) {
      expect(error).toMatchObject({
        stdout: expect.stringContaining('Missing structured output common schema'),
      });
    }
  });
});
