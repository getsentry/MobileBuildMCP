import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  PromptCancelledError,
  PromptInterruptedError,
  type Prompter,
} from '../../interactive/prompts.ts';
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

describe('purge command', () => {
  beforeEach(() => {
    appDir = mkdtempSync(path.join(tmpdir(), 'mobilebuildmcp-purge-cli-'));
    setMobileBuildMCPAppDirOverrideForTests(appDir);
  });

  afterEach(() => {
    setMobileBuildMCPAppDirOverrideForTests(null);
    rmSync(appDir, { recursive: true, force: true });
  });

  it('defaults to report mode when not running in a TTY', async () => {
    const layout = getWorkspaceFilesystemLayout(currentWorkspaceKey);
    const logPath = path.join(layout.logs, managedLogName('old'));
    writeFileWithMtime(logPath, 'old', now - 10 * DAY_MS);
    const output = captureOutput();

    await runPurgeCommand({}, { currentWorkspaceKey, isTTY: false, now, write: output.write });

    expect(output.chunks.join('')).toContain('MobileBuildMCP storage report');
    expect(output.chunks.join('')).toContain(currentWorkspaceKey);
    expect(existsSync(logPath)).toBe(true);
  });

  it('prints deterministic JSON report output for the current workspace by default', async () => {
    const layout = getWorkspaceFilesystemLayout(currentWorkspaceKey);
    const unrelatedWorkspaceKey = 'OtherApp-abcdefabcdef';
    const unrelated = getWorkspaceFilesystemLayout(unrelatedWorkspaceKey);
    writeFileWithMtime(path.join(layout.logs, managedLogName('old')), 'old', now - 10 * DAY_MS);
    writeFileWithMtime(
      path.join(unrelated.logs, managedLogName('unrelated')),
      'unrelated',
      now - 10 * DAY_MS,
    );
    const output = captureOutput();

    await runPurgeCommand(
      { json: true },
      { currentWorkspaceKey, isTTY: false, now, write: output.write },
    );

    const parsed = JSON.parse(output.chunks.join('')) as {
      action: string;
      deletionHappened: boolean;
      selectedScope: { type: string; workspaceKey?: string };
      workspaces: Array<{ workspaceKey: string }>;
    };
    expect(parsed.action).toBe('report');
    expect(parsed.deletionHappened).toBe(false);
    expect(parsed.selectedScope).toEqual({ type: 'workspace', workspaceKey: currentWorkspaceKey });
    expect(parsed.workspaces.map((workspace) => workspace.workspaceKey)).toEqual([
      currentWorkspaceKey,
    ]);
  });

  it('reports all workspaces when all scope is explicit', async () => {
    const unrelatedWorkspaceKey = 'OtherApp-abcdefabcdef';
    const target = getWorkspaceFilesystemLayout(currentWorkspaceKey);
    const unrelated = getWorkspaceFilesystemLayout(unrelatedWorkspaceKey);
    writeFileWithMtime(
      path.join(target.logs, managedLogName('target')),
      'target',
      now - 10 * DAY_MS,
    );
    writeFileWithMtime(
      path.join(unrelated.logs, managedLogName('unrelated')),
      'unrelated',
      now - 10 * DAY_MS,
    );
    const output = captureOutput();

    await runPurgeCommand(
      { report: true, scope: 'all', json: true },
      { currentWorkspaceKey, isTTY: false, now, write: output.write },
    );

    const parsed = JSON.parse(output.chunks.join('')) as {
      selectedScope: { type: string };
      workspaces: Array<{ workspaceKey: string }>;
    };
    expect(parsed.selectedScope).toEqual({ type: 'all' });
    expect(parsed.workspaces.map((workspace) => workspace.workspaceKey).sort()).toEqual([
      currentWorkspaceKey,
      unrelatedWorkspaceKey,
    ]);
  });

  it('dry-runs selected purge candidates without deleting them', async () => {
    const layout = getWorkspaceFilesystemLayout(currentWorkspaceKey);
    const logPath = path.join(layout.logs, managedLogName('old'));
    writeFileWithMtime(logPath, 'old', now - 10 * DAY_MS);
    const output = captureOutput();

    await runPurgeCommand(
      { dryRun: true, scope: 'all', classes: 'logs' },
      { currentWorkspaceKey, isTTY: false, now, write: output.write },
    );

    expect(output.chunks.join('')).toContain('Purge dry run');
    expect(output.chunks.join('')).toContain('Candidates: 1');
    expect(existsSync(logPath)).toBe(true);
  });

  it('scopes dry-run enumeration to the requested workspace', async () => {
    const unrelatedWorkspaceKey = 'OtherApp-abcdefabcdef';
    const target = getWorkspaceFilesystemLayout(currentWorkspaceKey);
    const unrelated = getWorkspaceFilesystemLayout(unrelatedWorkspaceKey);
    writeFileWithMtime(
      path.join(target.logs, managedLogName('target')),
      'target',
      now - 10 * DAY_MS,
    );
    writeFileWithMtime(
      path.join(unrelated.logs, managedLogName('unrelated')),
      'unrelated',
      now - 10 * DAY_MS,
    );
    const output = captureOutput();

    await runPurgeCommand(
      {
        dryRun: true,
        scope: 'workspace',
        workspaceKey: currentWorkspaceKey,
        classes: 'logs',
        json: true,
      },
      { currentWorkspaceKey, isTTY: false, now, write: output.write },
    );

    const parsed = JSON.parse(output.chunks.join('')) as {
      selectedWorkspaceKeys: string[];
      candidates: Array<{ workspaceKey: string }>;
      report: { workspaces: Array<{ workspaceKey: string }> };
    };
    expect(parsed.selectedWorkspaceKeys).toEqual([currentWorkspaceKey]);
    expect(parsed.candidates.map((candidate) => candidate.workspaceKey)).toEqual([
      currentWorkspaceKey,
    ]);
    expect(parsed.report.workspaces.map((workspace) => workspace.workspaceKey)).toEqual([
      currentWorkspaceKey,
    ]);
  });

  it('rejects non-interactive delete without the exact confirmation phrase', async () => {
    const layout = getWorkspaceFilesystemLayout(currentWorkspaceKey);
    const logPath = path.join(layout.logs, managedLogName('old'));
    writeFileWithMtime(logPath, 'old', now - 10 * DAY_MS);
    const output = captureOutput();

    await expect(
      runPurgeCommand(
        { delete: true, scope: 'all', classes: 'logs', confirm: 'delete' },
        { currentWorkspaceKey, isTTY: false, now, write: output.write },
      ),
    ).rejects.toThrow('Destructive purge requires --confirm delete-mobilebuildmcp-storage');
    expect(existsSync(logPath)).toBe(true);
  });

  it('requires an explicit non-interactive mode when TTY purge flags are supplied', async () => {
    await expect(
      runPurgeCommand(
        { classes: 'logs' },
        { currentWorkspaceKey, isTTY: true, now, write: captureOutput().write },
      ),
    ).rejects.toThrow(
      'Purge flags require an explicit mode: --report, --dry-run, or --delete. Supplied: --classes.',
    );
  });

  it('rejects planning-only flags in report mode', async () => {
    await expect(
      runPurgeCommand(
        { report: true, classes: 'logs' },
        { currentWorkspaceKey, isTTY: false, now, write: captureOutput().write },
      ),
    ).rejects.toThrow('--report cannot be combined with --classes.');

    await expect(
      runPurgeCommand(
        { report: true, olderThan: '7d' },
        { currentWorkspaceKey, isTTY: false, now, write: captureOutput().write },
      ),
    ).rejects.toThrow('--report cannot be combined with --older-than.');
  });

  it('rejects delete confirmation in dry-run mode', async () => {
    await expect(
      runPurgeCommand(
        { dryRun: true, classes: 'logs', confirm: 'delete-mobilebuildmcp-storage' },
        { currentWorkspaceKey, isTTY: false, now, write: captureOutput().write },
      ),
    ).rejects.toThrow('--dry-run cannot be combined with --confirm.');
  });

  it('rejects blank workspace and family scope values', async () => {
    await expect(
      runPurgeCommand(
        { dryRun: true, workspaceKey: '', classes: 'logs' },
        { currentWorkspaceKey, isTTY: false, now, write: captureOutput().write },
      ),
    ).rejects.toThrow('--workspace-key must not be empty.');

    await expect(
      runPurgeCommand(
        { report: true, family: '   ' },
        { currentWorkspaceKey, isTTY: false, now, write: captureOutput().write },
      ),
    ).rejects.toThrow('--family must not be empty.');
  });

  it('runs the interactive project to workspace to folder flow for one workspace', async () => {
    const first = getWorkspaceFilesystemLayout(currentWorkspaceKey);
    const secondWorkspaceKey = 'DemoApp-abcdefabcdef';
    const thirdWorkspaceKey = 'DemoApp-bbbbbbbbbbbb';
    const second = getWorkspaceFilesystemLayout(secondWorkspaceKey);
    const third = getWorkspaceFilesystemLayout(thirdWorkspaceKey);
    const firstLog = path.join(first.logs, managedLogName('first'));
    const secondLog = path.join(second.logs, managedLogName('second'));
    const thirdLog = path.join(third.logs, managedLogName('third'));
    writeFileWithMtime(firstLog, 'first', now - 10 * DAY_MS);
    writeFileWithMtime(secondLog, 'second', now - 10 * DAY_MS);
    writeFileWithMtime(thirdLog, 'third', now - 10 * DAY_MS);
    const output = captureOutput();
    const messages: string[] = [];
    let deleted = false;
    const prompter: Prompter = {
      selectOne: async <T>(opts: { message: string; options: Array<{ value: T }> }) => {
        messages.push(opts.message);
        if (opts.message === PURGE_INTERACTIVE_ROOT_PROMPT) {
          if (deleted) return opts.options.find((option) => option.value === 'cancel')!.value;
          return opts.options.find(
            (option) =>
              typeof option.value === 'object' &&
              option.value !== null &&
              'name' in option.value &&
              option.value.name === 'DemoApp',
          )!.value;
        }
        if (opts.message === purgeInteractiveProjectPrompt('DemoApp')) {
          if (deleted) return opts.options.find((option) => option.value === 'back')!.value;
          return opts.options.find(
            (option) =>
              typeof option.value === 'object' &&
              option.value !== null &&
              'workspaceKey' in option.value &&
              option.value.workspaceKey === currentWorkspaceKey,
          )!.value;
        }
        if (opts.message === purgeInteractiveWorkspacePrompt(currentWorkspaceKey)) {
          if (deleted) return opts.options.find((option) => option.value === 'back')!.value;
          return opts.options.find((option) => option.value === 'logs')!.value;
        }
        return opts.options[0].value;
      },
      selectMany: async <T>(opts: { message: string; options: Array<{ value: T }> }) => {
        messages.push(opts.message);
        return opts.options
          .filter((option) => option.value === 'logs')
          .map((option) => option.value);
      },
      confirm: async (opts) => {
        messages.push(opts.message);
        deleted = true;
        return true;
      },
    };

    await runPurgeCommand(
      {},
      { currentWorkspaceKey, prompter, isTTY: true, now, write: output.write },
    );

    const text = output.chunks.join('');
    expect(messages).toContain(PURGE_INTERACTIVE_ROOT_PROMPT);
    expect(messages).toContain(purgeInteractiveProjectPrompt('DemoApp'));
    expect(messages).toContain(purgeInteractiveWorkspacePrompt(currentWorkspaceKey));
    expect(messages).not.toContain('Select project');
    expect(messages).not.toContain('Select workspace in DemoApp');
    expect(messages).not.toContain(`Select folders in ${currentWorkspaceKey}`);
    expect(text).toContain('Ready to delete');
    expect(text).not.toContain('Warnings:');
    expect(existsSync(firstLog)).toBe(false);
    expect(existsSync(secondLog)).toBe(true);
    expect(existsSync(thirdLog)).toBe(true);
  });

  it('runs the interactive workspace DerivedData action without deleting logs', async () => {
    const first = getWorkspaceFilesystemLayout(currentWorkspaceKey);
    const secondWorkspaceKey = 'DemoApp-abcdefabcdef';
    const second = getWorkspaceFilesystemLayout(secondWorkspaceKey);
    const firstDerivedData = path.join(first.derivedData, 'DemoApp-a');
    const secondDerivedData = path.join(second.derivedData, 'DemoApp-b');
    const logPath = path.join(first.logs, managedLogName('old'));
    writeFileWithMtime(firstDerivedData, 'first', now - 10 * DAY_MS);
    writeFileWithMtime(secondDerivedData, 'second', now - 10 * DAY_MS);
    writeFileWithMtime(logPath, 'old', now - 10 * DAY_MS);
    const output = captureOutput();
    let deleted = false;
    const prompter: Prompter = {
      selectOne: async <T>(opts: { message: string; options: Array<{ value: T }> }) => {
        if (opts.message === PURGE_INTERACTIVE_ROOT_PROMPT) {
          if (deleted) return opts.options.find((option) => option.value === 'cancel')!.value;
          return opts.options.find(
            (option) =>
              typeof option.value === 'object' &&
              option.value !== null &&
              'name' in option.value &&
              option.value.name === 'DemoApp',
          )!.value;
        }
        if (opts.message === purgeInteractiveProjectPrompt('DemoApp')) {
          if (deleted) return opts.options.find((option) => option.value === 'back')!.value;
          return opts.options.find(
            (option) =>
              typeof option.value === 'object' &&
              option.value !== null &&
              'workspaceKey' in option.value &&
              option.value.workspaceKey === currentWorkspaceKey,
          )!.value;
        }
        if (opts.message === purgeInteractiveWorkspacePrompt(currentWorkspaceKey)) {
          if (deleted) return opts.options.find((option) => option.value === 'back')!.value;
          return opts.options.find((option) => option.value === 'derivedData')!.value;
        }
        return opts.options[0].value;
      },
      selectMany: async () => [],
      confirm: async () => {
        deleted = true;
        return true;
      },
    };

    await runPurgeCommand(
      {},
      { currentWorkspaceKey, prompter, isTTY: true, now, write: output.write },
    );

    const text = output.chunks.join('');
    expect(text).toContain('Includes DerivedData.');
    expect(existsSync(firstDerivedData)).toBe(false);
    expect(existsSync(secondDerivedData)).toBe(true);
    expect(existsSync(logPath)).toBe(true);
  });

  it('backs out of nested interactive menus without deleting storage', async () => {
    const first = getWorkspaceFilesystemLayout(currentWorkspaceKey);
    const secondWorkspaceKey = 'DemoApp-abcdefabcdef';
    const second = getWorkspaceFilesystemLayout(secondWorkspaceKey);
    const firstLog = path.join(first.logs, managedLogName('first'));
    const secondLog = path.join(second.logs, managedLogName('second'));
    writeFileWithMtime(firstLog, 'first', now - 10 * DAY_MS);
    writeFileWithMtime(secondLog, 'second', now - 10 * DAY_MS);
    const output = captureOutput();
    const messages: string[] = [];
    let rootVisits = 0;
    let projectVisits = 0;
    const prompter: Prompter = {
      selectOne: async <T>(opts: { message: string; options: Array<{ value: T }> }) => {
        messages.push(opts.message);
        if (opts.message === PURGE_INTERACTIVE_ROOT_PROMPT) {
          rootVisits += 1;
          if (rootVisits > 1)
            return opts.options.find((option) => option.value === 'cancel')!.value;
          return opts.options.find(
            (option) =>
              typeof option.value === 'object' &&
              option.value !== null &&
              'name' in option.value &&
              option.value.name === 'DemoApp',
          )!.value;
        }
        if (opts.message === purgeInteractiveProjectPrompt('DemoApp')) {
          projectVisits += 1;
          if (projectVisits > 1)
            return opts.options.find((option) => option.value === 'back')!.value;
          return opts.options.find(
            (option) =>
              typeof option.value === 'object' &&
              option.value !== null &&
              'workspaceKey' in option.value &&
              option.value.workspaceKey === currentWorkspaceKey,
          )!.value;
        }
        if (opts.message === purgeInteractiveWorkspacePrompt(currentWorkspaceKey)) {
          return opts.options.find((option) => option.value === 'back')!.value;
        }
        return opts.options[0].value;
      },
      selectMany: async () => {
        throw new Error('selectMany should not be reached');
      },
      confirm: async () => {
        throw new Error('confirm should not be reached');
      },
    };

    await runPurgeCommand(
      {},
      { currentWorkspaceKey, prompter, isTTY: true, now, write: output.write },
    );

    expect(messages).toEqual([
      PURGE_INTERACTIVE_ROOT_PROMPT,
      purgeInteractiveProjectPrompt('DemoApp'),
      purgeInteractiveWorkspacePrompt(currentWorkspaceKey),
      purgeInteractiveProjectPrompt('DemoApp'),
      PURGE_INTERACTIVE_ROOT_PROMPT,
    ]);
    expect(output.chunks.join('')).toContain('No storage deleted.');
    expect(existsSync(firstLog)).toBe(true);
    expect(existsSync(secondLog)).toBe(true);
  });

  it('treats prompt cancellation as back in nested menus and cancel at the root', async () => {
    const layout = getWorkspaceFilesystemLayout(currentWorkspaceKey);
    const second = getWorkspaceFilesystemLayout('DemoApp-abcdefabcdef');
    const logPath = path.join(layout.logs, managedLogName('old'));
    writeFileWithMtime(logPath, 'old', now - 10 * DAY_MS);
    writeFileWithMtime(
      path.join(second.logs, managedLogName('second')),
      'second',
      now - 10 * DAY_MS,
    );
    const output = captureOutput();
    let rootVisits = 0;
    const prompter: Prompter = {
      selectOne: async <T>(opts: { message: string; options: Array<{ value: T }> }) => {
        if (opts.message === PURGE_INTERACTIVE_ROOT_PROMPT) {
          rootVisits += 1;
          if (rootVisits > 1) throw new PromptCancelledError();
          return opts.options.find(
            (option) =>
              typeof option.value === 'object' &&
              option.value !== null &&
              'name' in option.value &&
              option.value.name === 'DemoApp',
          )!.value;
        }
        if (opts.message === purgeInteractiveProjectPrompt('DemoApp')) {
          throw new PromptCancelledError();
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

    expect(output.chunks.join('')).toContain('No storage deleted.');
    expect(existsSync(logPath)).toBe(true);
  });

  it('quits cleanly when an interactive prompt is interrupted from a nested menu', async () => {
    const layout = getWorkspaceFilesystemLayout(currentWorkspaceKey);
    const second = getWorkspaceFilesystemLayout('DemoApp-abcdefabcdef');
    const logPath = path.join(layout.logs, managedLogName('old'));
    writeFileWithMtime(logPath, 'old', now - 10 * DAY_MS);
    writeFileWithMtime(
      path.join(second.logs, managedLogName('second')),
      'second',
      now - 10 * DAY_MS,
    );
    const output = captureOutput();
    const prompter: Prompter = {
      selectOne: async <T>(opts: { message: string; options: Array<{ value: T }> }) => {
        if (opts.message === PURGE_INTERACTIVE_ROOT_PROMPT) {
          return opts.options.find(
            (option) =>
              typeof option.value === 'object' &&
              option.value !== null &&
              'name' in option.value &&
              option.value.name === 'DemoApp',
          )!.value;
        }
        if (opts.message === purgeInteractiveProjectPrompt('DemoApp')) {
          throw new PromptInterruptedError();
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

    expect(output.chunks.join('')).toContain('No storage deleted.');
    expect(existsSync(logPath)).toBe(true);
  });

  it('hides workspaces that only contain lock and lifecycle marker files in interactive mode', async () => {
    const layout = getWorkspaceFilesystemLayout(currentWorkspaceKey);
    mkdirSync(layout.filesystemLifecycle.lockDir, { recursive: true });
    writeFileWithMtime(layout.filesystemLifecycle.markerPath, 'cleanup-marker', now - 10 * DAY_MS);
    const output = captureOutput();
    const prompter: Prompter = {
      selectOne: async <T>(opts: { message: string; options: Array<{ value: T }> }) => {
        if (opts.message === PURGE_INTERACTIVE_ROOT_PROMPT) {
          const demoApp = opts.options.find(
            (option) =>
              typeof option.value === 'object' &&
              option.value !== null &&
              'name' in option.value &&
              option.value.name === 'DemoApp',
          );
          expect(demoApp).toBeUndefined();
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

    const text = output.chunks.join('');
    expect(text).toContain('0 projects / 0 workspaces');
    expect(text).not.toContain('Largest projects:');
  });

  it('does not confirm an interactive delete when selected storage disappears before planning', async () => {
    const layout = getWorkspaceFilesystemLayout(currentWorkspaceKey);
    const logPath = path.join(layout.logs, managedLogName('old'));
    writeFileWithMtime(logPath, 'old', now - 10 * DAY_MS);
    const output = captureOutput();
    let rootVisits = 0;
    const prompter: Prompter = {
      selectOne: async <T>(opts: { message: string; options: Array<{ value: T }> }) => {
        if (opts.message === PURGE_INTERACTIVE_ROOT_PROMPT) {
          rootVisits += 1;
          if (rootVisits === 1) {
            rmSync(logPath, { force: true });
            return opts.options.find(
              (option) =>
                typeof option.value === 'object' &&
                option.value !== null &&
                'name' in option.value &&
                option.value.name === 'DemoApp',
            )!.value;
          }
          return opts.options.find((option) => option.value === 'cancel')!.value;
        }
        return opts.options[0].value;
      },
      selectMany: async () => [],
      confirm: async () => {
        throw new Error('confirm should not be reached for an empty purge plan');
      },
    };

    await runPurgeCommand(
      {},
      { currentWorkspaceKey, prompter, isTTY: true, now, write: output.write },
    );

    const text = output.chunks.join('');
    expect(rootVisits).toBe(2);
    expect(text).toContain('No matching purgeable storage found for that selection.');
    expect(text).not.toContain('Ready to delete');
    expect(text).not.toContain('Delete 0 B?');
  });

  it('refreshes interactive project options after deleting a project', async () => {
    const first = getWorkspaceFilesystemLayout(currentWorkspaceKey);
    const secondWorkspaceKey = 'DemoApp-abcdefabcdef';
    const second = getWorkspaceFilesystemLayout(secondWorkspaceKey);
    const firstLog = path.join(first.logs, managedLogName('first'));
    const secondLog = path.join(second.logs, managedLogName('second'));
    writeFileWithMtime(firstLog, 'first', now - 10 * DAY_MS);
    writeFileWithMtime(secondLog, 'second', now - 10 * DAY_MS);
    const output = captureOutput();
    let rootVisits = 0;
    const prompter: Prompter = {
      selectOne: async <T>(opts: { message: string; options: Array<{ value: T }> }) => {
        if (opts.message === PURGE_INTERACTIVE_ROOT_PROMPT) {
          rootVisits += 1;
          const demoApp = opts.options.find(
            (option) =>
              typeof option.value === 'object' &&
              option.value !== null &&
              'name' in option.value &&
              option.value.name === 'DemoApp',
          );
          if (rootVisits === 1) {
            return demoApp!.value;
          }
          expect(demoApp).toBeUndefined();
          return opts.options.find((option) => option.value === 'cancel')!.value;
        }
        if (opts.message === purgeInteractiveProjectPrompt('DemoApp')) {
          return opts.options.find((option) => option.value === 'deleteAllWorkspaces')!.value;
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

    expect(rootVisits).toBe(2);
    expect(existsSync(firstLog)).toBe(false);
    expect(existsSync(secondLog)).toBe(false);
  });
});
