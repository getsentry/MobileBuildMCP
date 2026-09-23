import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { XCODEMAKE_COMMIT, XCODEMAKE_SHA256 } from '../xcodemake.ts';

const FILESYSTEM_TIMESTAMP_TOLERANCE_MS = 1_000;
const PINNED_FIXTURE_PATH = fileURLToPath(
  new URL(`./fixtures/xcodemake/xcodemake-${XCODEMAKE_COMMIT}`, import.meta.url),
);

function writeExecutable(filePath: string, contents: string): void {
  writeFileSync(filePath, contents);
  chmodSync(filePath, 0o755);
}

function readLines(filePath: string): string[] {
  if (!existsSync(filePath)) {
    return [];
  }

  const contents = readFileSync(filePath, 'utf8').trim();
  return contents.length > 0 ? contents.split('\n') : [];
}

describe('pinned xcodemake wrapper lifecycle', () => {
  let temporaryDirectory: string;
  let projectDirectory: string;
  let projectFile: string;
  let fakeBinDirectory: string;
  let xcodebuildInvocationLog: string;
  let makeInvocationLog: string;

  beforeEach(() => {
    temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'mobilebuildmcp-xcodemake-wrapper-'));
    projectDirectory = path.join(temporaryDirectory, 'project');
    fakeBinDirectory = path.join(temporaryDirectory, 'bin');
    xcodebuildInvocationLog = path.join(temporaryDirectory, 'xcodebuild-invocations.log');
    makeInvocationLog = path.join(temporaryDirectory, 'make-invocations.log');

    mkdirSync(path.join(projectDirectory, 'MyWorkspace.xcworkspace'), { recursive: true });
    mkdirSync(fakeBinDirectory, { recursive: true });
    projectFile = path.join(projectDirectory, 'MyWorkspace.xcodeproj', 'project.pbxproj');
    mkdirSync(path.dirname(projectFile), { recursive: true });
    writeFileSync(projectFile, '// test project\n');

    writeExecutable(
      path.join(fakeBinDirectory, 'xcodebuild'),
      '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$XCODEMAKE_TEST_XCODEBUILD_LOG"\n',
    );
    writeExecutable(
      path.join(fakeBinDirectory, 'make'),
      '#!/bin/sh\nprintf \'make\\n\' >> "$XCODEMAKE_TEST_MAKE_LOG"\nattempts=0\nwhile IFS= read -r _; do attempts=$((attempts + 1)); done < "$XCODEMAKE_TEST_MAKE_LOG"\nif [ "${XCODEMAKE_TEST_FAIL_FIRST_MAKE:-0}" = "1" ] && [ "$attempts" -eq 1 ]; then\n  exit 1\nfi\n',
    );
  });

  afterEach(() => {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  function runWrapper(arguments_: string[], environment: Record<string, string> = {}): void {
    execFileSync('perl', [PINNED_FIXTURE_PATH, ...arguments_], {
      cwd: projectDirectory,
      encoding: 'utf8',
      stdio: 'pipe',
      env: {
        ...process.env,
        PATH: `${fakeBinDirectory}${path.delimiter}${process.env.PATH ?? ''}`,
        DEVELOPER_BIN_DIR: fakeBinDirectory,
        OBJROOT: path.join(temporaryDirectory, 'objroot'),
        XCODEMAKE_TEST_XCODEBUILD_LOG: xcodebuildInvocationLog,
        XCODEMAKE_TEST_MAKE_LOG: makeInvocationLog,
        ...environment,
      },
    });
  }

  function captureLogs(): string[] {
    return readdirSync(projectDirectory).filter(
      (fileName) => fileName.startsWith('xcodemake') && fileName.endsWith('.log'),
    );
  }

  it('captures and reuses builds while invalidating changed or stale state', () => {
    const fixtureChecksum = createHash('sha256')
      .update(readFileSync(PINNED_FIXTURE_PATH))
      .digest('hex');
    expect(fixtureChecksum).toBe(XCODEMAKE_SHA256);

    const derivedDataPath =
      '/Users/developer/Library/Developer/MobileBuildMCP/DerivedData/MyWorkspace-57a542dedf16';
    const initialArguments = [
      '-workspace',
      'MyWorkspace.xcworkspace',
      '-scheme',
      'MyScheme',
      '-configuration',
      'Debug',
      '-derivedDataPath',
      derivedDataPath,
      'build',
    ];

    runWrapper(initialArguments);

    const initialXcodebuildInvocations = readLines(xcodebuildInvocationLog);
    expect(initialXcodebuildInvocations).toHaveLength(2);
    expect(initialXcodebuildInvocations).not.toContainEqual(
      expect.stringContaining('-config Debug'),
    );
    expect(initialXcodebuildInvocations[0]).toContain(derivedDataPath);
    expect(initialXcodebuildInvocations[0]).toMatch(/ clean$/);
    expect(initialXcodebuildInvocations[1]).not.toMatch(/ clean$/);
    expect(readLines(makeInvocationLog)).toHaveLength(1);
    expect(captureLogs()).toHaveLength(1);
    expect(readFileSync(path.join(projectDirectory, 'Makefile'), 'utf8')).toContain(
      derivedDataPath,
    );

    const makefilePath = path.join(projectDirectory, 'Makefile');
    const futureMakefileTime = new Date(Date.now() + 60_000);
    utimesSync(makefilePath, futureMakefileTime, futureMakefileTime);

    runWrapper(initialArguments);

    expect(readLines(xcodebuildInvocationLog)).toHaveLength(2);
    expect(readLines(makeInvocationLog)).toHaveLength(2);
    expect(captureLogs()).toHaveLength(1);
    expect(
      Math.abs(statSync(makefilePath).mtimeMs - futureMakefileTime.getTime()),
    ).toBeLessThanOrEqual(FILESYSTEM_TIMESTAMP_TOLERANCE_MS);

    const changedArguments = initialArguments.map((argument) =>
      argument === 'Debug' ? 'Release' : argument,
    );
    runWrapper(changedArguments);

    expect(readLines(xcodebuildInvocationLog)).toHaveLength(4);
    expect(readLines(makeInvocationLog)).toHaveLength(3);
    expect(captureLogs()).toHaveLength(2);
    expect(readFileSync(path.join(projectDirectory, 'Makefile'), 'utf8')).toContain(
      '-configuration Release',
    );

    const newestCaptureTime = Math.max(
      ...captureLogs().map((fileName) => statSync(path.join(projectDirectory, fileName)).mtimeMs),
    );
    const newerProjectTime = new Date(newestCaptureTime + 5_000);
    utimesSync(projectFile, newerProjectTime, newerProjectTime);

    runWrapper(changedArguments);

    expect(readLines(xcodebuildInvocationLog)).toHaveLength(6);
    expect(readLines(makeInvocationLog)).toHaveLength(4);
    expect(captureLogs()).toHaveLength(2);
  });

  it('preserves the long configuration option when direct xcodebuild fallback is required', () => {
    runWrapper(
      [
        '-workspace',
        'MyWorkspace.xcworkspace',
        '-scheme',
        'MyScheme',
        '-configuration',
        'Release',
        'build',
      ],
      { XCODEMAKE_TEST_FAIL_FIRST_MAKE: '1' },
    );

    const xcodebuildInvocations = readLines(xcodebuildInvocationLog);
    expect(xcodebuildInvocations).toHaveLength(5);
    expect(
      xcodebuildInvocations.every((invocation) => invocation.includes('-configuration Release')),
    ).toBe(true);
    expect(xcodebuildInvocations).not.toContainEqual(expect.stringContaining('-config Debug'));
    expect(xcodebuildInvocations[2]).not.toMatch(/ clean$/);
    expect(readLines(makeInvocationLog)).toHaveLength(2);
  });
});
