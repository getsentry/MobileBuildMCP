import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SetLevelRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { registerResources } from '../core/resources.ts';
import type { FileSystemExecutor } from '../utils/FileSystemExecutor.ts';
import { log, normalizeLogLevel, setLogLevel } from '../utils/logger.ts';
import type { RuntimeConfigOverrides } from '../utils/config-store.ts';
import { getRegisteredWorkflows, registerWorkflowsFromManifest } from '../utils/tool-registry.ts';
import { bootstrapRuntime } from '../runtime/bootstrap-runtime.ts';
import { getXcodeToolsBridgeManager } from '../integrations/xcode-tools-bridge/index.ts';
import { detectXcodeRuntime } from '../utils/xcode-process.ts';
import { readXcodeIdeState } from '../utils/xcode-state-reader.ts';
import { sessionStore } from '../utils/session-store.ts';
import { startXcodeStateWatcher, lookupBundleId } from '../utils/xcode-state-watcher.ts';
import { getDefaultCommandExecutor } from '../utils/command.ts';
import type { PredicateContext } from '../visibility/predicate-types.ts';
import { createStartupProfiler, getStartupProfileNowMs } from './startup-profiler.ts';
import { runWorkspaceFilesystemLifecycleSweep } from '../utils/workspace-filesystem-lifecycle.ts';
import { pruneManagedTestProductsAcrossWorkspaces } from '../utils/test-products-lifecycle.ts';

export interface BootstrapOptions {
  enabledWorkflows?: string[];
  configOverrides?: RuntimeConfigOverrides;
  fileSystemExecutor?: FileSystemExecutor;
  cwd?: string;
}

export interface BootstrapResult {
  runDeferredInitialization: (options?: { isShutdownRequested?: () => boolean }) => Promise<void>;
}

function runStartupFilesystemLifecycleSweep(workspaceKey: string): Promise<void> {
  return Promise.all([
    runWorkspaceFilesystemLifecycleSweep({
      workspaceKey,
      trigger: 'startup',
    }),
    pruneManagedTestProductsAcrossWorkspaces(),
  ])
    .then(([lifecycle, testProducts]) => {
      if (lifecycle.stopped > 0 || lifecycle.deleted > 0 || lifecycle.errors.length > 0) {
        log(
          lifecycle.errors.length > 0 ? 'warn' : 'info',
          `[startup] Filesystem lifecycle: ${JSON.stringify(lifecycle)}`,
        );
      }
      if (testProducts.deleted > 0 || testProducts.errors.length > 0) {
        log(
          testProducts.errors.length > 0 ? 'warn' : 'info',
          `[startup] Test products lifecycle: ${JSON.stringify(testProducts)}`,
        );
      }
    })
    .catch((error) => {
      log(
        'warn',
        `[startup] Filesystem lifecycle failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
}

export async function bootstrapServer(
  server: McpServer,
  options: BootstrapOptions = {},
): Promise<BootstrapResult> {
  const profiler = createStartupProfiler('bootstrap');

  server.server.setRequestHandler(SetLevelRequestSchema, async (request) => {
    const { level } = request.params;
    const normalized = normalizeLogLevel(level);
    if (normalized) {
      setLogLevel(normalized);
    }
    log('info', `Client requested log level: ${level}`);
    return {};
  });

  const hasLegacyEnabledWorkflows = Object.prototype.hasOwnProperty.call(
    options,
    'enabledWorkflows',
  );
  let overrides: RuntimeConfigOverrides | undefined;
  if (options.configOverrides !== undefined) {
    overrides = { ...options.configOverrides };
  }
  if (hasLegacyEnabledWorkflows) {
    overrides ??= {};
    overrides.enabledWorkflows = options.enabledWorkflows ?? [];
  }

  let stageStartMs = getStartupProfileNowMs();
  const result = await bootstrapRuntime({
    runtime: 'mcp',
    cwd: options.cwd,
    fs: options.fileSystemExecutor,
    configOverrides: overrides,
  });
  profiler.mark('bootstrapRuntime', stageStartMs);

  if (result.configFound) {
    for (const notice of result.notices) {
      log('info', `[ProjectConfig] ${notice}`);
    }
  }

  const enabledWorkflows = result.runtime.config.enabledWorkflows;
  const { workspaceRoot, workspaceKey } = result;

  log('info', `🚀 Initializing server...`);

  const executor = getDefaultCommandExecutor();
  stageStartMs = getStartupProfileNowMs();
  const xcodeDetection = await detectXcodeRuntime(executor);
  profiler.mark('detectXcodeRuntime', stageStartMs);

  const ctx: PredicateContext = {
    runtime: 'mcp',
    config: result.runtime.config,
    runningUnderXcode: xcodeDetection.runningUnderXcode,
  };

  stageStartMs = getStartupProfileNowMs();
  await registerWorkflowsFromManifest(enabledWorkflows, ctx);
  profiler.mark('registerWorkflowsFromManifest', stageStartMs);

  const resolvedWorkflows = getRegisteredWorkflows();
  const xcodeIdeEnabled = resolvedWorkflows.includes('xcode-ide');
  const xcodeToolsBridge = xcodeIdeEnabled ? getXcodeToolsBridgeManager(server) : null;
  xcodeToolsBridge?.setWorkflowEnabled(xcodeIdeEnabled);

  stageStartMs = getStartupProfileNowMs();
  await registerResources(server, ctx);
  profiler.mark('registerResources', stageStartMs);

  return {
    runDeferredInitialization: async (options = {}): Promise<void> => {
      const deferredProfiler = createStartupProfiler('bootstrap-deferred');
      const isShutdownRequested = options.isShutdownRequested;

      void runStartupFilesystemLifecycleSweep(workspaceKey);

      if (!xcodeDetection.runningUnderXcode) {
        return;
      }

      log('info', `[xcode] Running under Xcode agent environment`);

      const { projectPath, workspacePath } = sessionStore.getAll();

      if (isShutdownRequested?.()) {
        return;
      }

      let deferredStageStartMs = getStartupProfileNowMs();
      const xcodeState = await readXcodeIdeState({
        executor,
        cwd: result.runtime.cwd,
        searchRoot: workspaceRoot,
        projectPath,
        workspacePath,
      });
      deferredProfiler.mark('readXcodeIdeState', deferredStageStartMs);

      if (isShutdownRequested?.()) {
        return;
      }

      if (xcodeState.error) {
        log('debug', `[xcode] Could not read Xcode IDE state: ${xcodeState.error}`);
      } else {
        const syncedDefaults: Record<string, string> = {};
        if (xcodeState.scheme) {
          syncedDefaults.scheme = xcodeState.scheme;
        }
        if (xcodeState.simulatorId) {
          syncedDefaults.simulatorId = xcodeState.simulatorId;
        }
        if (xcodeState.simulatorName) {
          syncedDefaults.simulatorName = xcodeState.simulatorName;
        }

        if (Object.keys(syncedDefaults).length > 0) {
          const currentDefaults = sessionStore.getAll();
          const selectorChanged =
            (syncedDefaults.simulatorId != null &&
              syncedDefaults.simulatorId !== currentDefaults.simulatorId) ||
            (syncedDefaults.simulatorName != null &&
              syncedDefaults.simulatorName !== currentDefaults.simulatorName);
          if (selectorChanged) {
            // The cached platform belongs to the previous simulator selection.
            sessionStore.clear(['simulatorPlatform']);
          }
          sessionStore.setDefaults(syncedDefaults);
          log(
            'info',
            `[xcode] Synced session defaults from Xcode: ${JSON.stringify(syncedDefaults)}`,
          );
        }

        if (xcodeState.scheme) {
          lookupBundleId(executor, xcodeState.scheme, projectPath, workspacePath)
            .then((bundleId) => {
              if (bundleId) {
                sessionStore.setDefaults({ bundleId });
                log('info', `[xcode] Bundle ID resolved: "${bundleId}"`);
              }
            })
            .catch((e) => {
              log('debug', `[xcode] Failed to lookup bundle ID: ${e}`);
            });
        }
      }

      if (!result.runtime.config.disableXcodeAutoSync) {
        if (isShutdownRequested?.()) {
          return;
        }
        deferredStageStartMs = getStartupProfileNowMs();
        const watcherStarted = await startXcodeStateWatcher({
          executor,
          cwd: result.runtime.cwd,
          searchRoot: workspaceRoot,
          projectPath,
          workspacePath,
        });
        deferredProfiler.mark('startXcodeStateWatcher', deferredStageStartMs);
        if (watcherStarted) {
          log('info', `[xcode] Started file watcher for automatic sync`);
        }
      } else {
        log('info', `[xcode] Automatic Xcode sync disabled via config`);
      }
    },
  };
}
