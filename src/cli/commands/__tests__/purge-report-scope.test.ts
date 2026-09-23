import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { runPurgeCommand } from '../purge.ts';
import {
  getWorkspaceFilesystemLayout,
  setMobileBuildMCPAppDirOverrideForTests,
} from '../../../utils/log-paths.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.UTC(2026, 5, 8, 12);
const currentWorkspaceKey = 'DemoApp-123456789abc';

let appDir: string;

function managedLogName(name: string): string {
  return `${name}_2026-05-02T12-00-00-000Z_pid123_abcdef12.log`;
}

function writeFileWithMtime(filePath: string, content: string, mtimeMs: number): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  const mtime = new Date(mtimeMs);
  utimesSync(filePath, mtime, mtime);
}

function captureOutput(): { chunks: string[]; write: (text: string) => void } {
  const chunks: string[] = [];
  return {
    chunks,
    write: (text) => {
      chunks.push(text);
    },
  };
}

describe('purge report scope', () => {
  beforeEach(() => {
    appDir = mkdtempSync(path.join(tmpdir(), 'mobilebuildmcp-purge-report-scope-'));
    setMobileBuildMCPAppDirOverrideForTests(appDir);
  });

  afterEach(() => {
    setMobileBuildMCPAppDirOverrideForTests(null);
    rmSync(appDir, { recursive: true, force: true });
  });

  it('keeps explicit report defaults aligned with the current workspace planning scope', async () => {
    const current = getWorkspaceFilesystemLayout(currentWorkspaceKey);
    const unrelatedWorkspaceKey = 'OtherApp-abcdefabcdef';
    const unrelated = getWorkspaceFilesystemLayout(unrelatedWorkspaceKey);
    writeFileWithMtime(
      path.join(current.logs, managedLogName('current')),
      'current',
      now - 10 * DAY_MS,
    );
    writeFileWithMtime(
      path.join(unrelated.logs, managedLogName('unrelated')),
      'unrelated',
      now - 10 * DAY_MS,
    );
    const output = captureOutput();

    await runPurgeCommand(
      { report: true, json: true },
      { currentWorkspaceKey, isTTY: false, now, write: output.write },
    );

    const parsed = JSON.parse(output.chunks.join('')) as {
      selectedScope: { type: string; workspaceKey?: string };
      totals: { bytes: number };
      workspaces: Array<{ workspaceKey: string }>;
    };
    expect(parsed.selectedScope).toEqual({ type: 'workspace', workspaceKey: currentWorkspaceKey });
    expect(parsed.workspaces.map((workspace) => workspace.workspaceKey)).toEqual([
      currentWorkspaceKey,
    ]);
    expect(parsed.totals.bytes).toBe(Buffer.byteLength('current'));
  });
});
