import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { describe, it } from 'vitest';
import type { SnapshotResult, SnapshotRuntime, WorkflowSnapshotHarness } from '../contracts.ts';
import { createHarnessForRuntime, createWorkflowResultFixtureMatcher } from './helpers.ts';

const PACKAGE_SOURCE_PATH = resolve('example_projects/spm');

interface SwiftPackageTestContext {
  harness: WorkflowSnapshotHarness;
  packagePath: string;
}

function copyPackageForTest(tempDirectory: string): string {
  const packagePath = join(tempDirectory, 'spm');
  cpSync(PACKAGE_SOURCE_PATH, packagePath, {
    recursive: true,
    filter: (source) => basename(source) !== '.build',
  });
  return packagePath;
}

async function withSwiftPackageTestContext(
  runtime: SnapshotRuntime,
  run: (context: SwiftPackageTestContext) => Promise<void>,
): Promise<void> {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'mobilebuildmcp-swift-package-snapshot-'));
  const packagePath = copyPackageForTest(tempDirectory);
  let harness: WorkflowSnapshotHarness | undefined;

  try {
    harness = await createHarnessForRuntime(runtime);
    await run({ harness, packagePath });
  } finally {
    try {
      await harness?.cleanup();
    } finally {
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  }
}

function assertSetupSucceeded(result: SnapshotResult, label: string): void {
  if (result.isError) {
    throw new Error(`${label} failed:\n${result.rawText}`);
  }
}

function getProcessId(result: SnapshotResult): number {
  const data = result.structuredEnvelope?.data;
  if (typeof data === 'object' && data !== null && 'artifacts' in data) {
    const artifacts = data.artifacts;
    if (
      typeof artifacts === 'object' &&
      artifacts !== null &&
      'processId' in artifacts &&
      typeof artifacts.processId === 'number'
    ) {
      return artifacts.processId;
    }
  }

  const processId = result.rawText.match(/Process ID:\s*(\d+)/)?.[1];
  if (processId === undefined) {
    throw new Error(`Swift package run did not return a process ID:\n${result.rawText}`);
  }
  return Number(processId);
}

export function registerSwiftPackageSnapshotSuite(runtime: SnapshotRuntime): void {
  const expectFixture = createWorkflowResultFixtureMatcher(runtime, 'swift-package');

  describe(`${runtime} swift-package workflow`, () => {
    describe('build', () => {
      it('success', async () => {
        await withSwiftPackageTestContext(runtime, async ({ harness, packagePath }) => {
          const result = await harness.invoke('swift-package', 'build', { packagePath });
          expectFixture(result, 'build--success', 'success');
        });
      }, 120_000);

      it('error - bad path', async () => {
        await withSwiftPackageTestContext(runtime, async ({ harness, packagePath }) => {
          const result = await harness.invoke('swift-package', 'build', {
            packagePath: join(packagePath, 'NONEXISTENT'),
          });
          expectFixture(result, 'build--error-bad-path', 'error');
        });
      });
    });

    describe('test', () => {
      it('success', async () => {
        await withSwiftPackageTestContext(runtime, async ({ harness, packagePath }) => {
          const result = await harness.invoke('swift-package', 'test', {
            packagePath,
            filter: 'basicTruthTest',
          });
          expectFixture(result, 'test--success', 'success');
        });
      }, 120_000);

      it('failure - intentional test failure', async () => {
        await withSwiftPackageTestContext(runtime, async ({ harness, packagePath }) => {
          const result = await harness.invoke('swift-package', 'test', { packagePath });
          expectFixture(result, 'test--failure', 'error');
        });
      }, 120_000);

      it('error - bad path', async () => {
        await withSwiftPackageTestContext(runtime, async ({ harness, packagePath }) => {
          const result = await harness.invoke('swift-package', 'test', {
            packagePath: join(packagePath, 'NONEXISTENT'),
          });
          expectFixture(result, 'test--error-bad-path', 'error');
        });
      });
    });

    describe('clean', () => {
      it('success', async () => {
        await withSwiftPackageTestContext(runtime, async ({ harness, packagePath }) => {
          const result = await harness.invoke('swift-package', 'clean', { packagePath });
          expectFixture(result, 'clean--success', 'success');
        });
      });

      it('error - bad path', async () => {
        await withSwiftPackageTestContext(runtime, async ({ harness, packagePath }) => {
          const result = await harness.invoke('swift-package', 'clean', {
            packagePath: join(packagePath, 'NONEXISTENT'),
          });
          expectFixture(result, 'clean--error-bad-path', 'error');
        });
      });
    });

    describe('run', () => {
      it('success', async () => {
        await withSwiftPackageTestContext(runtime, async ({ harness, packagePath }) => {
          const result = await harness.invoke('swift-package', 'run', {
            packagePath,
            executableName: 'spm',
          });
          expectFixture(result, 'run--success', 'success');
        });
      }, 120_000);

      it('error - bad executable', async () => {
        await withSwiftPackageTestContext(runtime, async ({ harness, packagePath }) => {
          const result = await harness.invoke('swift-package', 'run', {
            packagePath,
            executableName: 'nonexistent-executable',
          });
          expectFixture(result, 'run--error-bad-executable', 'error');
        });
      }, 120_000);
    });

    describe('list', () => {
      it('no processes', async () => {
        await withSwiftPackageTestContext(runtime, async ({ harness }) => {
          const result = await harness.invoke('swift-package', 'list', {});
          expectFixture(result, 'list--no-processes', 'success');
        });
      });

      it('success', async () => {
        await withSwiftPackageTestContext(runtime, async ({ harness, packagePath }) => {
          const runResult = await harness.invoke('swift-package', 'run', {
            packagePath,
            executableName: 'spm',
            background: true,
          });
          assertSetupSucceeded(runResult, 'Start Swift package process');
          const processId = getProcessId(runResult);

          try {
            const result = await harness.invoke('swift-package', 'list', {});
            expectFixture(result, 'list--success', 'success');
          } finally {
            const stopResult = await harness.invoke('swift-package', 'stop', { pid: processId });
            assertSetupSucceeded(stopResult, `Stop Swift package process ${processId}`);
          }
        });
      }, 120_000);
    });

    describe('stop', () => {
      it('error - no process', async () => {
        await withSwiftPackageTestContext(runtime, async ({ harness }) => {
          const result = await harness.invoke('swift-package', 'stop', { pid: 999999 });
          expectFixture(result, 'stop--error-no-process', 'error');
        });
      });
    });
  });
}
