#!/usr/bin/env node

/**
 * MCP Server Startup Module
 *
 * This module provides the logic to start the MobileBuildMCP server.
 * It can be invoked from the CLI via the `mcp` subcommand.
 */

import { createServer, startServer } from './server.ts';
import { log, setLogLevel } from '../utils/logger.ts';
import {
  enrichSentryContext,
  initSentry,
  recordMcpLifecycleAnomalyMetric,
  recordMcpLifecycleMetric,
  setSentryRuntimeContext,
} from '../utils/sentry.ts';
import { version } from '../version.ts';
import process from 'node:process';
import { bootstrapServer } from './bootstrap.ts';
import { createStartupProfiler, getStartupProfileNowMs } from './startup-profiler.ts';
import { getConfig } from '../utils/config-store.ts';
import { getRegisteredWorkflows } from '../utils/tool-registry.ts';
import { hydrateSentryDisabledEnvFromProjectConfig } from '../utils/sentry-config.ts';
import { createMcpLifecycleCoordinator, isTransportDisconnectReason } from './mcp-lifecycle.ts';
import {
  createMcpIdleShutdownController,
  resolveMcpIdleCheckIntervalMs,
  resolveMcpIdleTimeoutConfig,
  type McpIdleShutdownController,
} from './mcp-idle-shutdown.ts';
import { runMcpShutdown } from './mcp-shutdown.ts';

/**
 * Start the MCP server.
 * This function initializes Sentry, creates and bootstraps the server,
 * sets up signal handlers for graceful shutdown, and starts the server.
 */
export async function startMcpServer(): Promise<void> {
  let idleShutdown: McpIdleShutdownController | null = null;

  const lifecycle = createMcpLifecycleCoordinator({
    onShutdown: async ({ reason, error, snapshot, server }) => {
      idleShutdown?.stop();

      const isCrash = reason === 'uncaught-exception' || reason === 'unhandled-rejection';
      const event = isCrash ? 'crash' : 'shutdown';

      const transportMessages: Record<string, string> = {
        'stdin-end': 'MCP stdin ended; shutting down MCP server',
        'stdin-close': 'MCP stdin closed; shutting down MCP server',
        'stdout-error': 'MCP stdout pipe broke; shutting down MCP server',
        'stderr-error': 'MCP stderr pipe broke; shutting down MCP server',
        'idle-timeout': 'MCP idle timeout reached; shutting down MCP server',
      };
      log('info', transportMessages[reason] ?? `MCP shutdown requested: ${reason}`);

      if (!isTransportDisconnectReason(reason)) {
        recordMcpLifecycleMetric({
          event,
          phase: snapshot.phase,
          reason,
          uptimeMs: snapshot.uptimeMs,
          rssBytes: snapshot.rssBytes,
          matchingMcpProcessCount: snapshot.matchingMcpProcessCount,
          activeOperationCount: snapshot.activeOperationCount,
          watcherRunning: snapshot.watcherRunning,
        });

        for (const anomaly of snapshot.anomalies) {
          recordMcpLifecycleAnomalyMetric({
            kind: anomaly,
            phase: snapshot.phase,
            reason,
          });
        }
      }

      const result = await runMcpShutdown({
        reason,
        error,
        snapshot,
        server,
      });

      lifecycle.detachProcessHandlers();
      process.exit(result.exitCode);
    },
  });

  lifecycle.attachProcessHandlers();

  try {
    const profiler = createStartupProfiler('start-mcp-server');

    // MCP mode defaults to info level logging
    // Clients can override via logging/setLevel MCP request
    setLogLevel('info');

    lifecycle.markPhase('hydrating-sentry-config');
    await hydrateSentryDisabledEnvFromProjectConfig();

    let stageStartMs = getStartupProfileNowMs();
    lifecycle.markPhase('initializing-sentry');
    initSentry({ mode: 'mcp' });
    profiler.mark('initSentry', stageStartMs);

    stageStartMs = getStartupProfileNowMs();
    lifecycle.markPhase('creating-server');
    const server = createServer();
    lifecycle.registerServer(server);
    profiler.mark('createServer', stageStartMs);

    stageStartMs = getStartupProfileNowMs();
    lifecycle.markPhase('bootstrapping-server');
    const bootstrap = await bootstrapServer(server);
    profiler.mark('bootstrapServer', stageStartMs);

    const idleTimeoutConfig = resolveMcpIdleTimeoutConfig();
    if (idleTimeoutConfig.invalid && idleTimeoutConfig.rawValue) {
      log(
        'warn',
        `Invalid MOBILEBUILDMCP_MCP_IDLE_TIMEOUT_MS=${idleTimeoutConfig.rawValue}; using default ${idleTimeoutConfig.timeoutMs}ms`,
      );
    }

    const idleCheckIntervalMs = resolveMcpIdleCheckIntervalMs(idleTimeoutConfig.timeoutMs);

    if (idleTimeoutConfig.timeoutMs === 0) {
      log('info', 'MCP idle shutdown disabled');
    } else {
      log(
        'info',
        `MCP idle shutdown enabled: timeout=${idleTimeoutConfig.timeoutMs}ms interval=${idleCheckIntervalMs}ms`,
      );
    }

    idleShutdown = createMcpIdleShutdownController({
      timeoutMs: idleTimeoutConfig.timeoutMs,
      intervalMs: idleCheckIntervalMs,
      requestShutdown: () => lifecycle.shutdown('idle-timeout'),
      isShutdownRequested: () => lifecycle.isShutdownRequested(),
      logIdleMessage: (message) => log('info', message),
    });

    stageStartMs = getStartupProfileNowMs();
    lifecycle.markPhase('starting-stdio-transport');
    await startServer(server, {
      requestLifecycle: {
        onRequestStarted: () => idleShutdown?.markRequestStarted(),
        onRequestCompleted: () => idleShutdown?.markRequestCompleted(),
      },
    });
    profiler.mark('startServer', stageStartMs);

    const config = getConfig();
    const enabledWorkflows = getRegisteredWorkflows();
    setSentryRuntimeContext({
      mode: 'mcp',
      enabledWorkflows,
      disableSessionDefaults: config.disableSessionDefaults,
      disableXcodeAutoSync: config.disableXcodeAutoSync,
      incrementalBuildsEnabled: config.incrementalBuildsEnabled,
      debugEnabled: config.debug,
      uiDebuggerGuardMode: config.uiDebuggerGuardMode,
      xcodeIdeWorkflowEnabled: enabledWorkflows.includes('xcode-ide'),
    });

    lifecycle.markPhase('running');
    idleShutdown.start();

    // Capture phase at schedule time so deferred snapshot metrics are not
    // attributed to a later phase (e.g. deferred-initialization) if markPhase
    // advances before getSnapshot resolves. See #461 / review note.
    const startupMetricPhase = 'running' as const;

    // Startup snapshot (simulator os_log sessions, peer process sample, etc.) is
    // telemetry-only. Awaiting it blocked the first tools/list by ~10–17s on cold
    // start, which makes short health-probe clients report "tools fetch failed"
    // even though the transport is already up. Keep the same logging/metrics, but
    // do not block readiness on the snapshot. See #461.
    void lifecycle
      .getSnapshot()
      .then((startupSnapshot) => {
        if (lifecycle.isShutdownRequested()) {
          return;
        }
        // Prefer the phase at snapshot-schedule time for metrics; still log the
        // full snapshot object as returned for operational debugging.
        const metricPhase = startupMetricPhase;
        log(
          'info',
          `[mcp-lifecycle] start ${JSON.stringify({ ...startupSnapshot, phase: metricPhase })}`,
        );
        recordMcpLifecycleMetric({
          event: 'start',
          phase: metricPhase,
          uptimeMs: startupSnapshot.uptimeMs,
          rssBytes: startupSnapshot.rssBytes,
          matchingMcpProcessCount: startupSnapshot.matchingMcpProcessCount,
          activeOperationCount: startupSnapshot.activeOperationCount,
          watcherRunning: startupSnapshot.watcherRunning,
        });
        for (const anomaly of startupSnapshot.anomalies) {
          recordMcpLifecycleAnomalyMetric({
            kind: anomaly,
            phase: metricPhase,
          });
        }
        if (startupSnapshot.anomalies.length > 0) {
          log(
            'warn',
            `[mcp-lifecycle] startup anomalies observed: ${startupSnapshot.anomalies.join(', ')}`,
            { sentry: true },
          );
        }
      })
      .catch((error) => {
        log(
          'warn',
          `Startup lifecycle snapshot failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });

    lifecycle.markPhase('deferred-initialization');
    void bootstrap
      .runDeferredInitialization({
        isShutdownRequested: () => lifecycle.isShutdownRequested(),
      })
      .catch((error) => {
        log(
          'warn',
          `Deferred bootstrap initialization failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        if (!lifecycle.isShutdownRequested()) {
          lifecycle.markPhase('running');
        }
      });
    setImmediate(() => {
      enrichSentryContext();
    });

    log('info', `MobileBuildMCP server (version ${version}) started successfully`);
  } catch (error) {
    console.error('Fatal error in startMcpServer():', error);
    await lifecycle.shutdown('startup-failure', error);
  }
}
