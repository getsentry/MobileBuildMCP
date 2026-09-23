import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { Prompter } from '../../interactive/prompts.ts';
import {
  PURGE_INTERACTIVE_ROOT_PROMPT,
  purgeInteractiveProjectPrompt,
  purgeInteractiveWorkspacePrompt,
} from '../purge-interactive.ts';
import { runPurgeCommand } from '../purge.ts';
import {
  getWorkspaceFilesystemLayout,
  setMobileBuildMCPAppDirOverrideForTests,
} from '../../../utils/log-paths.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.UTC(2026, 5, 8, 12);
const currentWorkspaceKey = 'DemoApp-123456789abc';

let appDir: string;

function managedLogName(name = 'build_sim'): string {
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

describe('purge interactive command', () => {
  beforeEach(() => {
    appDir = mkdtempSync(path.join(tmpdir(), 'mobilebuildmcp-purge-interactive-'));
    setMobileBuildMCPAppDirOverrideForTests(appDir);
  });

  afterEach(() => {
    setMobileBuildMCPAppDirOverrideForTests(null);
    rmSync(appDir, { recursive: true, force: true });
  });

  it('groups purgeable unknown workspace keys under one Unknown workspaces row', async () => {
    const known = getWorkspaceFilesystemLayout(currentWorkspaceKey);
    const unknownOne = getWorkspaceFilesystemLayout('20260524T184215Z');
    const unknownTwo = getWorkspaceFilesystemLayout('20260524T204326Z-49434c797e95');
    writeFileWithMtime(path.join(known.logs, managedLogName('known')), 'known', now - 10 * DAY_MS);
    writeFileWithMtime(
      path.join(unknownOne.logs, managedLogName('unknown-one')),
      'one',
      now - 10 * DAY_MS,
    );
    writeFileWithMtime(
      path.join(unknownTwo.logs, managedLogName('unknown-two')),
      'two',
      now - 10 * DAY_MS,
    );
    const output = captureOutput();
    const rootLabels: string[] = [];
    const prompter: Prompter = {
      selectOne: async <T>(opts: {
        message: string;
        options: Array<{ value: T; label?: string }>;
      }) => {
        if (opts.message === PURGE_INTERACTIVE_ROOT_PROMPT) {
          rootLabels.push(...opts.options.map((option) => option.label ?? ''));
          return opts.options.find((option) => option.value === 'cancel')!.value;
        }
        return opts.options[0].value;
      },
      selectMany: async () => [],
      confirm: async () => true,
    };

    await runPurgeCommand(
      {},
      { currentWorkspaceKey, prompter, isTTY: true, now, write: output.write },
    );

    expect(rootLabels.some((label) => label.startsWith('› Unknown workspaces - '))).toBe(true);
    expect(rootLabels.some((label) => label.startsWith('20260524T184215Z - '))).toBe(false);
    expect(rootLabels.some((label) => label.startsWith('20260524T204326Z-49434c797e95 - '))).toBe(
      false,
    );
    expect(output.chunks.join('')).toContain('Purgeable:');
  });

  it('reports interactive overview counts from visible purgeable groups only', async () => {
    const purgeable = getWorkspaceFilesystemLayout(currentWorkspaceKey);
    const hidden = getWorkspaceFilesystemLayout('HiddenApp-abcdefabcdef');
    writeFileWithMtime(
      path.join(purgeable.logs, managedLogName('known')),
      'known',
      now - 10 * DAY_MS,
    );
    mkdirSync(hidden.filesystemLifecycle.lockDir, { recursive: true });
    writeFileWithMtime(hidden.filesystemLifecycle.markerPath, 'marker', now - 10 * DAY_MS);
    const output = captureOutput();
    const prompter: Prompter = {
      selectOne: async <T>(opts: { options: Array<{ value: T }> }) =>
        opts.options.find((option) => option.value === 'cancel')!.value,
      selectMany: async () => [],
      confirm: async () => true,
    };

    await runPurgeCommand(
      {},
      { currentWorkspaceKey, prompter, isTTY: true, now, write: output.write },
    );

    expect(output.chunks.join('')).toContain('1 projects / 1 workspaces');
    expect(output.chunks.join('')).not.toContain('2 workspaces');
  });

  it('opens the workspace class menu for a single-workspace project', async () => {
    const layout = getWorkspaceFilesystemLayout(currentWorkspaceKey);
    const logPath = path.join(layout.logs, managedLogName('known'));
    const derivedDataPath = path.join(layout.derivedData, 'DemoApp-a');
    writeFileWithMtime(logPath, 'known', now - 10 * DAY_MS);
    writeFileWithMtime(derivedDataPath, 'derived', now - 10 * DAY_MS);
    const output = captureOutput();
    const messages: string[] = [];
    let rootVisits = 0;
    let workspaceVisits = 0;
    const prompter: Prompter = {
      selectOne: async <T>(opts: {
        message: string;
        options: Array<{ value: T; label?: string }>;
      }) => {
        messages.push(opts.message);
        if (opts.message === PURGE_INTERACTIVE_ROOT_PROMPT) {
          rootVisits += 1;
          if (rootVisits > 1)
            return opts.options.find((option) => option.value === 'cancel')!.value;
          return opts.options.find((option) => option.label?.startsWith('› DemoApp - '))!.value;
        }
        if (opts.message === purgeInteractiveWorkspacePrompt(currentWorkspaceKey)) {
          workspaceVisits += 1;
          if (workspaceVisits > 1)
            return opts.options.find((option) => option.value === 'back')!.value;
          return opts.options.find((option) => option.value === 'logs')!.value;
        }
        return opts.options.find((option) => option.value === 'cancel')!.value;
      },
      selectMany: async () => [],
      confirm: async (opts) => {
        messages.push(opts.message);
        return true;
      },
    };

    await runPurgeCommand(
      {},
      { currentWorkspaceKey, prompter, isTTY: true, now, write: output.write },
    );

    expect(messages).toContain(PURGE_INTERACTIVE_ROOT_PROMPT);
    expect(messages).toContain(purgeInteractiveWorkspacePrompt(currentWorkspaceKey));
    expect(messages.some((message) => /^Delete .*\?$/u.test(message))).toBe(true);
    expect(messages).not.toContain(purgeInteractiveProjectPrompt('DemoApp'));
    expect(output.chunks.join('')).toContain('Deleted 1 item;');
    expect(existsSync(logPath)).toBe(false);
    expect(existsSync(derivedDataPath)).toBe(true);
  });

  it('omits global destructive actions from the root menu', async () => {
    const layout = getWorkspaceFilesystemLayout(currentWorkspaceKey);
    writeFileWithMtime(path.join(layout.logs, managedLogName('known')), 'known', now - 10 * DAY_MS);
    const output = captureOutput();
    const rootLabels: string[] = [];
    const prompter: Prompter = {
      selectOne: async <T>(opts: {
        message: string;
        options: Array<{ value: T; label?: string }>;
      }) => {
        if (opts.message === PURGE_INTERACTIVE_ROOT_PROMPT) {
          rootLabels.push(...opts.options.map((option) => option.label ?? ''));
          return opts.options.find((option) => option.value === 'cancel')!.value;
        }
        return opts.options[0].value;
      },
      selectMany: async () => [],
      confirm: async () => true,
    };

    await runPurgeCommand(
      {},
      { currentWorkspaceKey, prompter, isTTY: true, now, write: output.write },
    );

    expect(rootLabels).toContain('Cancel');
    expect(rootLabels.some((label) => label.startsWith('› DemoApp - '))).toBe(true);
    expect(rootLabels).not.toContain('Delete all projects');
    expect(rootLabels).not.toContain('Select multiple projects to delete');
    expect(rootLabels).not.toContain('Delete all DerivedData folders');
  });
});
