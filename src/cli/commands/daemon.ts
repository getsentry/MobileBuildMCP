import type { Argv } from 'yargs';
import { readFileSync } from 'node:fs';
import { DaemonClient } from '../daemon-client.ts';
import {
  ensureDaemonRunning,
  startDaemonForeground,
  DEFAULT_DAEMON_STARTUP_TIMEOUT_MS,
} from '../daemon-control.ts';
import {
  listDaemonRegistryEntries,
  readDaemonRegistryEntry,
} from '../../daemon/daemon-registry.ts';
import { coerceLogLevel } from '../../utils/logger.ts';

export interface DaemonCommandsOptions {
  defaultSocketPath: string;
  workspaceRoot: string;
  workspaceKey: string;
}

function writeLine(text: string): void {
  process.stdout.write(`${text}\n`);
}

/**
 * Register daemon management commands.
 */
export function registerDaemonCommands(app: Argv, opts: DaemonCommandsOptions): void {
  app.command(
    'daemon <action>',
    'Manage the mobilebuildmcp daemon',
    (yargs) => {
      return yargs
        .positional('action', {
          describe: 'Daemon action',
          choices: ['start', 'stop', 'status', 'restart', 'list', 'logs'] as const,
          demandOption: true,
        })
        .option('daemon-log-path', {
          type: 'string',
          describe: 'Override daemon log file path (start/restart only)',
        })
        .option('daemon-log-level', {
          type: 'string',
          describe: 'Set daemon log level (start/restart only)',
          choices: [
            'none',
            'emergency',
            'alert',
            'critical',
            'error',
            'warn',
            'notice',
            'info',
            'debug',
          ] as const,
          coerce: coerceLogLevel,
        })
        .option('tail', {
          type: 'number',
          default: 200,
          describe: 'Number of log lines to show (logs action)',
        })
        .option('foreground', {
          alias: 'f',
          type: 'boolean',
          default: false,
          describe: 'Run daemon in foreground (for debugging)',
        })
        .option('json', {
          type: 'boolean',
          default: false,
          describe: 'Output in JSON format (for list command)',
        })
        .option('all', {
          type: 'boolean',
          default: true,
          describe: 'Include stale daemons in list',
        });
    },
    async (argv) => {
      const action = argv.action as string;
      // Socket path comes from global --socket which defaults to workspace socket
      const socketPath = argv.socket as string;
      const client = new DaemonClient({ socketPath });

      const logPath = argv['daemon-log-path'] as string | undefined;
      const logLevel = argv['daemon-log-level'] as string | undefined;
      const tail = argv.tail as number | undefined;

      switch (action) {
        case 'status':
          await handleStatus(client, opts.workspaceRoot, opts.workspaceKey);
          break;
        case 'stop':
          await handleStop(client);
          break;
        case 'start':
          await handleStart(socketPath, opts.workspaceRoot, argv.foreground as boolean, {
            logPath,
            logLevel,
          });
          break;
        case 'restart':
          await handleRestart(client, socketPath, opts.workspaceRoot, argv.foreground as boolean, {
            logPath,
            logLevel,
          });
          break;
        case 'list':
          await handleList(argv.json as boolean, argv.all as boolean);
          break;
        case 'logs':
          await handleLogs(opts.workspaceKey, tail ?? 200);
          break;
      }
    },
  );
}

async function handleStatus(
  client: DaemonClient,
  workspaceRoot: string,
  workspaceKey: string,
): Promise<void> {
  try {
    const status = await client.status();
    writeLine('Daemon Status: Running');
    writeLine(`  PID: ${status.pid}`);
    writeLine(`  Workspace: ${status.workspaceRoot ?? workspaceRoot}`);
    writeLine(`  Socket: ${status.socketPath}`);
    if (status.logPath) {
      writeLine(`  Logs: ${status.logPath}`);
    }
    writeLine(`  Started: ${status.startedAt}`);
    writeLine(`  Tools: ${status.toolCount}`);
    writeLine(`  Workflows: ${status.enabledWorkflows.join(', ') || '(default)'}`);
  } catch (err) {
    if (err instanceof Error && err.message.includes('not running')) {
      writeLine('Daemon Status: Not running');
      writeLine(`  Workspace: ${workspaceRoot}`);
      const entry = readDaemonRegistryEntry(workspaceKey);
      if (entry?.logPath) {
        writeLine(`  Logs: ${entry.logPath}`);
      }
    } else {
      console.error('Error:', err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  }
}

async function handleStop(client: DaemonClient): Promise<void> {
  try {
    await client.stop();
    writeLine('Daemon stopped');
  } catch (err) {
    if (err instanceof Error && err.message.includes('not running')) {
      writeLine('Daemon is not running');
    } else {
      console.error('Error:', err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  }
}

async function handleStart(
  socketPath: string,
  workspaceRoot: string,
  foreground: boolean,
  logOpts: { logPath?: string; logLevel?: string },
): Promise<void> {
  const client = new DaemonClient({ socketPath });

  // Check if already running
  const isRunning = await client.isRunning();
  if (isRunning) {
    writeLine('Daemon is already running');
    return;
  }

  const envOverrides: Record<string, string> = {};
  if (logOpts.logPath) {
    envOverrides.MOBILEBUILDMCP_DAEMON_LOG_PATH = logOpts.logPath;
  }
  if (logOpts.logLevel) {
    envOverrides.MOBILEBUILDMCP_DAEMON_LOG_LEVEL = logOpts.logLevel;
  }

  if (foreground) {
    // Run in foreground (useful for debugging)
    writeLine('Starting daemon in foreground...');
    writeLine(`Workspace: ${workspaceRoot}`);
    writeLine(`Socket: ${socketPath}`);
    writeLine('Press Ctrl+C to stop\n');

    const exitCode = await startDaemonForeground({
      socketPath,
      workspaceRoot,
      env: Object.keys(envOverrides).length > 0 ? envOverrides : undefined,
    });
    process.exit(exitCode);
  } else {
    // Run in background with auto-start helper
    try {
      await ensureDaemonRunning({
        socketPath,
        workspaceRoot,
        startupTimeoutMs: DEFAULT_DAEMON_STARTUP_TIMEOUT_MS,
        env: Object.keys(envOverrides).length > 0 ? envOverrides : undefined,
      });
      writeLine('Daemon started');
      writeLine(`Workspace: ${workspaceRoot}`);
      writeLine(`Socket: ${socketPath}`);
    } catch (err) {
      console.error('Failed to start daemon:', err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  }
}

async function handleRestart(
  client: DaemonClient,
  socketPath: string,
  workspaceRoot: string,
  foreground: boolean,
  logOpts: { logPath?: string; logLevel?: string },
): Promise<void> {
  // Try to stop existing daemon
  try {
    const isRunning = await client.isRunning();
    if (isRunning) {
      writeLine('Stopping existing daemon...');
      await client.stop();
      // Wait for it to fully stop
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } catch {
    // Ignore errors during stop
  }

  // Start new daemon
  await handleStart(socketPath, workspaceRoot, foreground, logOpts);
}

interface DaemonListEntry {
  workspaceKey: string;
  workspaceRoot: string;
  socketPath: string;
  pid: number;
  startedAt: string;
  version: string;
  status: 'running' | 'stale';
}

async function handleLogs(workspaceKey: string, tail: number): Promise<void> {
  const entry = readDaemonRegistryEntry(workspaceKey);
  const logPath = entry?.logPath;

  if (!logPath) {
    writeLine('No daemon log path available for this workspace.');
    return;
  }

  let content = '';
  try {
    content = readFileSync(logPath, 'utf8');
  } catch (err) {
    console.error('Error:', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  const lines = content.split(/\r?\n/);
  const limited = lines.slice(Math.max(0, lines.length - Math.max(1, tail)));
  writeLine(limited.join('\n'));
}

async function handleList(jsonOutput: boolean, includeStale: boolean): Promise<void> {
  const registryEntries = listDaemonRegistryEntries();

  if (registryEntries.length === 0) {
    if (jsonOutput) {
      writeLine(JSON.stringify([]));
    } else {
      writeLine('No daemons found');
    }
    return;
  }

  // Check each daemon's status
  const entries: DaemonListEntry[] = [];

  for (const entry of registryEntries) {
    const client = new DaemonClient({
      socketPath: entry.socketPath,
      timeout: 1000, // Short timeout for status check
    });

    let status: 'running' | 'stale' = 'stale';
    try {
      await client.status();
      status = 'running';
    } catch {
      status = 'stale';
    }

    if (status === 'stale' && !includeStale) {
      continue;
    }

    entries.push({
      workspaceKey: entry.workspaceKey,
      workspaceRoot: entry.workspaceRoot,
      socketPath: entry.socketPath,
      pid: entry.pid,
      startedAt: entry.startedAt,
      version: entry.version,
      status,
    });
  }

  if (jsonOutput) {
    writeLine(JSON.stringify(entries, null, 2));
  } else {
    if (entries.length === 0) {
      writeLine('No daemons found');
      return;
    }

    writeLine('Daemons:\n');
    for (const entry of entries) {
      const statusLabel = entry.status === 'running' ? '[running]' : '[stale]';
      writeLine(`  ${statusLabel} ${entry.workspaceKey}`);
      writeLine(`    Workspace: ${entry.workspaceRoot}`);
      writeLine(`    PID: ${entry.pid}`);
      writeLine(`    Started: ${entry.startedAt}`);
      writeLine(`    Version: ${entry.version}`);
      writeLine('');
    }

    const runningCount = entries.filter((e) => e.status === 'running').length;
    const staleCount = entries.filter((e) => e.status === 'stale').length;
    writeLine(`Total: ${entries.length} (${runningCount} running, ${staleCount} stale)`);
  }
}
