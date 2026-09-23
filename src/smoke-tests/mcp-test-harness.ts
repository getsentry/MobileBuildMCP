import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import type { ChildProcess } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CommandExecutor, CommandResponse } from '../utils/CommandExecutor.ts';
import {
  __setTestCommandExecutorOverride,
  __setTestFileSystemExecutorOverride,
  __clearTestExecutorOverrides,
} from '../utils/command.ts';
import {
  __setTestInteractiveSpawnerOverride,
  __clearTestInteractiveSpawnerOverride,
} from '../utils/execution/interactive-process.ts';
import {
  __resetConfigStoreForTests,
  initConfigStore,
  type RuntimeConfigOverrides,
} from '../utils/config-store.ts';
import { __resetServerStateForTests } from '../server/server-state.ts';
import { __resetToolRegistryForTests } from '../utils/tool-registry.ts';
import {
  createMockFileSystemExecutor,
  createNoopInteractiveSpawner,
} from '../test-utils/mock-executors.ts';
import { createServer } from '../server/server.ts';
import { bootstrapServer } from '../server/bootstrap.ts';
import { sessionStore } from '../utils/session-store.ts';
import {
  __setTestDebuggerToolContextOverride,
  __clearTestDebuggerToolContextOverride,
  DebuggerManager,
} from '../utils/debugger/index.ts';
import { getPackageRoot } from '../core/manifest/load-manifest.ts';
import { shutdownXcodeToolsBridge } from '../integrations/xcode-tools-bridge/index.ts';
import { setXcodebuildLogDirOverrideForTests } from '../utils/xcodebuild-log-capture.ts';

export interface CapturedCommand {
  command: string[];
  logPrefix?: string;
  useShell?: boolean;
  opts?: { env?: Record<string, string>; cwd?: string };
  detached?: boolean;
}

export interface McpTestHarness {
  client: Client;
  capturedCommands: CapturedCommand[];
  resetCapturedCommands(): void;
  cleanup(): Promise<void>;
}

export interface McpTestHarnessOptions {
  enabledWorkflows?: string[];
  commandResponses?: Record<string, { success: boolean; output: string }>;
}

const defaultCommandResponse: CommandResponse = {
  success: true,
  output: '',
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  process: { pid: 99999 } as ChildProcess,
  exitCode: 0,
};

export async function createMcpTestHarness(opts?: McpTestHarnessOptions): Promise<McpTestHarness> {
  const capturedCommands: CapturedCommand[] = [];

  const capturingExecutor: CommandExecutor = async (
    command,
    logPrefix,
    useShell,
    execOpts,
    detached,
  ) => {
    capturedCommands.push({ command, logPrefix, useShell, opts: execOpts, detached });

    if (opts?.commandResponses) {
      const commandStr = command.join(' ');
      const sorted = Object.entries(opts.commandResponses).sort(([a], [b]) => b.length - a.length);
      for (const [pattern, response] of sorted) {
        if (commandStr.includes(pattern)) {
          return {
            ...defaultCommandResponse,
            ...response,
            exitCode: response.success ? 0 : 1,
          };
        }
      }
    }

    return defaultCommandResponse;
  };

  // Reset all singletons
  __resetConfigStoreForTests();
  __resetServerStateForTests();
  __resetToolRegistryForTests();
  sessionStore.clear();

  const mockFs = createMockFileSystemExecutor();
  const logDir = await mkdtemp(join(tmpdir(), 'mobilebuildmcp-smoke-logs-'));

  setXcodebuildLogDirOverrideForTests(logDir);

  // Set executor overrides on the vitest-resolved source modules
  __setTestCommandExecutorOverride(capturingExecutor);
  __setTestFileSystemExecutorOverride(mockFs);
  __setTestInteractiveSpawnerOverride(createNoopInteractiveSpawner());

  // Also set overrides on the built module instances (used by dynamically imported tool handlers)
  const buildRoot = resolve(getPackageRoot(), 'build');
  if (!existsSync(buildRoot)) {
    throw new Error(
      `Build directory not found at ${buildRoot}. Run "npm run build" before running smoke tests.`,
    );
  }

  // Dynamic imports required: built modules are separate JS instances that must be patched independently of vitest-resolved source modules.
  const builtCommandModule = (await import(
    pathToFileURL(resolve(buildRoot, 'utils/command.js')).href
  )) as {
    __setTestCommandExecutorOverride: typeof __setTestCommandExecutorOverride;
    __setTestFileSystemExecutorOverride: typeof __setTestFileSystemExecutorOverride;
    __clearTestExecutorOverrides: typeof __clearTestExecutorOverrides;
  };
  builtCommandModule.__setTestCommandExecutorOverride(capturingExecutor);
  builtCommandModule.__setTestFileSystemExecutorOverride(mockFs);

  const builtLogCaptureModule = (await import(
    pathToFileURL(resolve(buildRoot, 'utils/xcodebuild-log-capture.js')).href
  )) as {
    setXcodebuildLogDirOverrideForTests: typeof setXcodebuildLogDirOverrideForTests;
  };
  builtLogCaptureModule.setXcodebuildLogDirOverrideForTests(logDir);

  // Set interactive spawner override (built module)
  const builtInteractiveModule = (await import(
    pathToFileURL(resolve(buildRoot, 'utils/execution/interactive-process.js')).href
  )) as {
    __setTestInteractiveSpawnerOverride: typeof __setTestInteractiveSpawnerOverride;
    __clearTestInteractiveSpawnerOverride: typeof __clearTestInteractiveSpawnerOverride;
  };
  builtInteractiveModule.__setTestInteractiveSpawnerOverride(createNoopInteractiveSpawner());

  // Set debugger tool context override (source module)
  __setTestDebuggerToolContextOverride({
    executor: capturingExecutor,
    debugger: new DebuggerManager(),
  });

  // Set debugger tool context override (built module)
  const builtDebuggerModule = (await import(
    pathToFileURL(resolve(buildRoot, 'utils/debugger/tool-context.js')).href
  )) as {
    __setTestDebuggerToolContextOverride: typeof __setTestDebuggerToolContextOverride;
    __clearTestDebuggerToolContextOverride: typeof __clearTestDebuggerToolContextOverride;
  };
  builtDebuggerModule.__setTestDebuggerToolContextOverride({
    executor: capturingExecutor,
    debugger: new DebuggerManager(),
  });

  // Initialize the built config-store module (separate singleton from source module).
  // Tool modules loaded from build/ use this config store for schema resolution
  // (e.g. session-aware vs legacy schema selection) and requirement validation.
  const builtConfigStoreModule = (await import(
    pathToFileURL(resolve(buildRoot, 'utils/config-store.js')).href
  )) as {
    __resetConfigStoreForTests: typeof __resetConfigStoreForTests;
    initConfigStore: typeof initConfigStore;
  };
  builtConfigStoreModule.__resetConfigStoreForTests();
  await builtConfigStoreModule.initConfigStore({
    cwd: '/test',
    fs: mockFs,
    overrides: {
      debug: true,
      disableXcodeAutoSync: true,
    } satisfies RuntimeConfigOverrides,
  });

  // Import the built session-store module (separate singleton from source module).
  // Session-aware tool handlers in build/ read/write defaults via this store.
  const builtSessionStoreModule = (await import(
    pathToFileURL(resolve(buildRoot, 'utils/session-store.js')).href
  )) as {
    sessionStore: typeof sessionStore;
  };
  builtSessionStoreModule.sessionStore.clear();

  // Create server (uses the real createServer + manifest system)
  const server = createServer();

  // Bootstrap with workflows enabled for maximum coverage.
  // xcode-ide is excluded: it connects to the real Xcode tools bridge MCP
  // server which triggers system permission prompts and requires Xcode.
  const allWorkflows = opts?.enabledWorkflows ?? [
    'simulator',
    'simulator-management',
    'device',
    'macos',
    'project-discovery',
    'project-scaffolding',
    'session-management',
    'swift-package',
    'logging',
    'debugging',
    'ui-automation',
    'utilities',
    'workflow-discovery',
    'doctor',
  ];

  await bootstrapServer(server, {
    enabledWorkflows: allWorkflows,
    configOverrides: {
      debug: true,
      disableXcodeAutoSync: true,
    },
    fileSystemExecutor: mockFs,
  });

  // Create InMemoryTransport linked pair
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  // Connect server to one end
  await server.connect(serverTransport);

  // Create and connect client to the other end
  const client = new Client({ name: 'e2e-test-client', version: '1.0.0' });
  await client.connect(clientTransport);

  return {
    client,
    capturedCommands,
    resetCapturedCommands(): void {
      capturedCommands.length = 0;
    },
    async cleanup(): Promise<void> {
      await client.close();
      await server.close();
      await shutdownXcodeToolsBridge();
      __clearTestExecutorOverrides();
      builtCommandModule.__clearTestExecutorOverrides();
      __clearTestInteractiveSpawnerOverride();
      builtInteractiveModule.__clearTestInteractiveSpawnerOverride();
      __clearTestDebuggerToolContextOverride();
      builtDebuggerModule.__clearTestDebuggerToolContextOverride();
      setXcodebuildLogDirOverrideForTests(null);
      builtLogCaptureModule.setXcodebuildLogDirOverrideForTests(null);
      await rm(logDir, { recursive: true, force: true });
      __resetConfigStoreForTests();
      builtConfigStoreModule.__resetConfigStoreForTests();
      __resetServerStateForTests();
      __resetToolRegistryForTests();
      sessionStore.clear();
      builtSessionStoreModule.sessionStore.clear();
    },
  };
}
