import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { ensureSocketDir } from '../socket-path.ts';

let tempDir: string;

describe('ensureSocketDir', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'mobilebuildmcp-socket-path-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates a private socket directory', () => {
    const socketPath = path.join(tempDir, 'daemon', 'd.sock');

    ensureSocketDir(socketPath);

    expect(existsSync(path.dirname(socketPath))).toBe(true);
    expect(statSync(path.dirname(socketPath)).mode & 0o777).toBe(0o700);
  });

  it('tightens permissions on an existing socket directory owned by the current user', () => {
    const dir = path.join(tempDir, 'daemon');
    const socketPath = path.join(dir, 'd.sock');
    ensureSocketDir(socketPath);
    chmodSync(dir, 0o755);

    ensureSocketDir(socketPath);

    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('rejects symlink socket directories', () => {
    const targetDir = path.join(tempDir, 'target');
    const linkDir = path.join(tempDir, 'daemon');
    ensureSocketDir(path.join(targetDir, 'placeholder.sock'));
    symlinkSync(targetDir, linkDir);

    expect(() => ensureSocketDir(path.join(linkDir, 'd.sock'))).toThrow(/cannot be a symlink/u);
  });

  it('rejects non-directory socket path parents', () => {
    const filePath = path.join(tempDir, 'daemon');
    writeFileSync(filePath, 'not a directory');

    expect(() => ensureSocketDir(path.join(filePath, 'd.sock'))).toThrow(/not a directory/u);
  });
});
