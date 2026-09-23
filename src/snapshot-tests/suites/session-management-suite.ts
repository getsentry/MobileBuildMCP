import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'vitest';
import { getWorkspacesDir, getWorkspaceFilesystemLayout } from '../../utils/log-paths.ts';
import { workspaceKeyForRoot } from '../../utils/workspace-identity.ts';
import {
  isMcpSnapshotRuntime,
  type SnapshotResult,
  type SnapshotRuntime,
  type WorkflowSnapshotHarness,
} from '../contracts.ts';
import { CleanupStack } from '../preflight/cleanup.ts';
import { installCalculatorXcodeState } from '../preflight/xcode-state.ts';
import { createHarnessForRuntime, createWorkflowResultFixtureMatcher } from './helpers.ts';

const WORKSPACE = 'example_projects/iOS_Calculator/CalculatorApp.xcworkspace';
const CALCULATOR_PROJECT = resolve('example_projects/iOS_Calculator');

function removeOwnedManagedWorkspace(testWorkspace: string): void {
  const workspaceKey = workspaceKeyForRoot(testWorkspace);
  const managedWorkspace = getWorkspaceFilesystemLayout(workspaceKey).root;
  if (
    dirname(managedWorkspace) !== getWorkspacesDir() ||
    basename(managedWorkspace) !== workspaceKey
  ) {
    throw new Error(`Refusing to remove unowned managed workspace: ${managedWorkspace}`);
  }
  rmSync(managedWorkspace, { recursive: true, force: true });
}

function assertSetupSucceeded(result: SnapshotResult, label: string): void {
  if (result.isError) {
    throw new Error(`${label} failed during snapshot setup:\n${result.rawText}`);
  }
}

export function registerSessionManagementSnapshotSuite(runtime: SnapshotRuntime): void {
  const expectFixture = createWorkflowResultFixtureMatcher(runtime, 'session-management');

  describe(`${runtime} session-management workflow`, () => {
    let harness: WorkflowSnapshotHarness;
    let cleanup: CleanupStack;
    let testWorkspace: string;

    async function invokeSetup(
      workflow: string,
      tool: string,
      args: Record<string, unknown>,
    ): Promise<void> {
      const result = await harness.invoke(workflow, tool, args);
      assertSetupSucceeded(result, `${workflow}/${tool}`);
    }

    async function seedSessionDefaults(): Promise<void> {
      await invokeSetup('session-management', 'clear-defaults', { all: true });
      await invokeSetup('session-management', 'set-defaults', {
        workspacePath: WORKSPACE,
        scheme: 'CalculatorApp',
      });
      await invokeSetup('session-management', 'set-defaults', {
        profile: 'MyCustomProfile',
        createIfNotExists: true,
        workspacePath: WORKSPACE,
        scheme: 'CalculatorApp',
      });
      await invokeSetup('session-management', 'use-defaults-profile', { global: true });
    }

    beforeEach(async () => {
      cleanup = new CleanupStack();
      try {
        testWorkspace = mkdtempSync(join(tmpdir(), 'mobilebuildmcp-session-snapshot-'));
        cleanup.defer('remove session snapshot directory', () =>
          rmSync(testWorkspace, { recursive: true, force: true }),
        );
        cleanup.defer('remove managed session workspace', () =>
          removeOwnedManagedWorkspace(testWorkspace),
        );

        const exampleProjects = join(testWorkspace, 'example_projects');
        mkdirSync(exampleProjects, { recursive: true });
        cpSync(CALCULATOR_PROJECT, join(exampleProjects, 'iOS_Calculator'), { recursive: true });
        harness = await createHarnessForRuntime(runtime, { cwd: testWorkspace });
        cleanup.defer('cleanup session snapshot harness', () => harness.cleanup());
      } catch (error) {
        await cleanup.cleanup();
        throw error;
      }
    });

    afterEach(async () => {
      await cleanup.cleanup();
    });

    describe('shared snapshots', () => {
      describe('session-set-defaults', () => {
        it('success', async () => {
          await invokeSetup('session-management', 'clear-defaults', { all: true });
          const result = await harness.invoke('session-management', 'set-defaults', {
            scheme: 'CalculatorApp',
            workspacePath: WORKSPACE,
          });
          expectFixture(result, 'session-set-defaults--success', 'success');
        });
      });

      describe('session-show-defaults', () => {
        it('success', async () => {
          await seedSessionDefaults();
          const result = await harness.invoke('session-management', 'show-defaults', {});
          expectFixture(result, 'session-show-defaults--success', 'success');
        });
      });

      describe('session-clear-defaults', () => {
        it('success', async () => {
          await seedSessionDefaults();
          const result = await harness.invoke('session-management', 'clear-defaults', {});
          expectFixture(result, 'session-clear-defaults--success', 'success');
        });
      });

      describe('session-use-defaults-profile', () => {
        it('success', async () => {
          await seedSessionDefaults();
          const result = await harness.invoke('session-management', 'use-defaults-profile', {
            profile: 'MyCustomProfile',
          });
          expectFixture(result, 'session-use-defaults-profile--success', 'success');
        });
      });

      describe('session-sync-xcode-defaults', () => {
        it('success', async () => {
          installCalculatorXcodeState(join(testWorkspace, WORKSPACE));
          await seedSessionDefaults();
          await invokeSetup('project-discovery', 'show-build-settings', {
            workspacePath: WORKSPACE,
            scheme: 'CalculatorApp',
          });
          const result = await harness.invoke('session-management', 'sync-xcode-defaults', {});
          expectFixture(result, 'session-sync-xcode-defaults--success', 'success');
        });
      });
    });

    if (isMcpSnapshotRuntime(runtime)) {
      describe('mcp-only extras', () => {
        it('session-show-defaults -- empty', async () => {
          await invokeSetup('session-management', 'clear-defaults', { all: true });
          const result = await harness.invoke('session-management', 'show-defaults', {});
          expectFixture(result, 'session-show-defaults--empty', 'success');
        });

        it('session-set-defaults -- set scheme', async () => {
          await invokeSetup('session-management', 'clear-defaults', { all: true });
          const result = await harness.invoke('session-management', 'set-defaults', {
            scheme: 'CalculatorApp',
          });
          expectFixture(result, 'session-set-defaults--scheme', 'success');
        });

        it('session-use-defaults-profile -- persist success', async () => {
          await invokeSetup('session-management', 'clear-defaults', { all: true });
          await invokeSetup('session-management', 'set-defaults', {
            profile: 'MyCustomProfile',
            createIfNotExists: true,
            workspacePath: WORKSPACE,
            scheme: 'CalculatorApp',
          });
          await invokeSetup('session-management', 'use-defaults-profile', { global: true });

          const result = await harness.invoke('session-management', 'use-defaults-profile', {
            profile: 'MyCustomProfile',
            persist: true,
          });
          expectFixture(result, 'session-use-defaults-profile--persist-success', 'success');
        });
      });
    }
  });
}
