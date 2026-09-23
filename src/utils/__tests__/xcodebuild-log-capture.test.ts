import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  createLogCapture,
  createParserDebugCapture,
  setXcodebuildLogDirOverrideForTests,
} from '../xcodebuild-log-capture.ts';
import { resetWorkspaceFilesystemLifecycleStateForTests } from '../workspace-filesystem-lifecycle.ts';
import { getWorkspaceFilesystemLayout } from '../log-paths.ts';
import { setRuntimeInstanceForTests } from '../runtime-instance.ts';

let logDir: string;

describe('xcodebuild log capture', () => {
  beforeEach(() => {
    logDir = mkdtempSync(path.join(tmpdir(), 'mobilebuildmcp-log-capture-'));
    setXcodebuildLogDirOverrideForTests(logDir);
    setRuntimeInstanceForTests({
      instanceId: 'capture-test',
      pid: process.pid,
      workspaceKey: 'workspace-a',
    });
    resetWorkspaceFilesystemLifecycleStateForTests();
  });

  afterEach(async () => {
    setXcodebuildLogDirOverrideForTests(null);
    setRuntimeInstanceForTests(null);
    resetWorkspaceFilesystemLifecycleStateForTests();
    await rm(logDir, { recursive: true, force: true });
  });

  it('does not create a file before the first write', () => {
    const capture = createLogCapture('build_sim');

    expect(capture.path).toContain(logDir);
    expect(existsSync(capture.path)).toBe(false);

    capture.close();

    expect(existsSync(capture.path)).toBe(false);
  });

  it('uses the current workspace log directory when no test override is set', () => {
    setXcodebuildLogDirOverrideForTests(null);

    const capture = createLogCapture('build_sim');

    expect(capture.path).toContain(getWorkspaceFilesystemLayout('workspace-a').logs);
    capture.close();
  });

  it('creates the file on first non-empty write', async () => {
    const capture = createLogCapture('build_sim');

    capture.write('CompileSwift normal arm64 /tmp/App.swift\n');
    capture.close();

    await expect(readFile(capture.path, 'utf-8')).resolves.toBe(
      'CompileSwift normal arm64 /tmp/App.swift\n',
    );
  });

  it('ignores empty writes', () => {
    const capture = createLogCapture('build_sim');

    capture.write('');
    capture.close();

    expect(existsSync(capture.path)).toBe(false);
  });

  it('writes parser debug logs to the resolved log directory', async () => {
    const capture = createParserDebugCapture('build_sim');
    capture.addUnrecognizedLine('unexpected output');

    const debugPath = capture.flush();

    expect(debugPath).not.toBeNull();
    expect(debugPath).toContain(logDir);
    await expect(readFile(debugPath as string, 'utf-8')).resolves.toContain('unexpected output');
  });
});
