/**
 * Logger Utility - Simple logging implementation for the application
 *
 * This utility module provides a lightweight logging system that directs log
 * messages to stderr rather than stdout, ensuring they don't interfere with
 * the MCP protocol communication which uses stdout.
 *
 * Responsibilities:
 * - Formatting log messages with timestamps and level indicators
 * - Directing all logs to stderr to avoid MCP protocol interference
 * - Supporting different log levels (info, warning, error, debug)
 * - Providing a simple, consistent logging interface throughout the application
 * - Sending error-level logs to Sentry for monitoring and alerting
 *
 * While intentionally minimal, this logger provides the essential functionality
 * needed for operational monitoring and debugging throughout the application.
 * It's used by virtually all other modules for status reporting and error logging.
 */

import { createWriteStream, type WriteStream } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { areProcessStdioWritesSuppressed, isSentryCaptureSealed } from './shutdown-state.ts';

function isSentryDisabledFromEnv(): boolean {
  return (
    process.env.SENTRY_DISABLED === 'true' || process.env.MOBILEBUILDMCP_SENTRY_DISABLED === 'true'
  );
}

function isSentryEnabled(): boolean {
  return !isSentryDisabledFromEnv();
}

// Log levels in order of severity (lower number = more severe)
const LOG_LEVELS = {
  none: -1,
  emergency: 0,
  alert: 1,
  critical: 2,
  error: 3,
  warn: 4,
  notice: 5,
  info: 6,
  debug: 7,
} as const;

export type LogLevel = keyof typeof LOG_LEVELS;

/**
 * Optional context for logging to control Sentry capture
 */
export interface LogContext {
  sentry?: boolean;
}

export function __shouldCaptureToSentryForTests(context?: LogContext): boolean {
  return context?.sentry === true && !isSentryCaptureSealed();
}

// Client-requested log level ("none" means no output unless explicitly enabled)
let clientLogLevel: LogLevel = 'none';

let logFileStream: WriteStream | null = null;
let logFilePath: string | null = null;

function isTestEnv(): boolean {
  return (
    process.env.VITEST === 'true' ||
    process.env.NODE_ENV === 'test' ||
    process.env.MOBILEBUILDMCP_SILENCE_LOGS === 'true'
  );
}

type SentryModule = typeof import('@sentry/node');
type SentryLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const require = createRequire(
  typeof __filename === 'string' ? __filename : resolve(process.cwd(), 'package.json'),
);
let cachedSentry: SentryModule | null = null;

function loadSentrySync(): SentryModule | null {
  if (!isSentryEnabled() || isTestEnv()) {
    return null;
  }
  if (cachedSentry) {
    return cachedSentry;
  }
  try {
    cachedSentry = require('@sentry/node') as SentryModule;
    return cachedSentry;
  } catch {
    return null;
  }
}

function withSentry(cb: (s: SentryModule) => void): void {
  const s = loadSentrySync();
  if (!s) {
    return;
  }
  try {
    cb(s);
  } catch {
    // Avoid throwing inside logger
  }
}

function mapLogLevelToSentry(level: string): SentryLogLevel {
  switch (level.toLowerCase()) {
    case 'emergency':
    case 'alert':
      return 'fatal';
    case 'critical':
    case 'error':
      return 'error';
    case 'warn':
      return 'warn';
    case 'debug':
      return 'debug';
    case 'notice':
    case 'info':
      return 'info';
    default:
      return 'info';
  }
}

export function __mapLogLevelToSentryForTests(level: string): SentryLogLevel {
  return mapLogLevelToSentry(level);
}

/**
 * Normalize an external log level string to the internal LogLevel type.
 * Handles the MCP protocol's 'warning' (mapped to internal 'warn') and
 * validates against known levels. Returns null for unrecognized values.
 */
export function normalizeLogLevel(raw: string): LogLevel | null {
  const lower = raw.trim().toLowerCase();
  const mapped = lower === 'warning' ? 'warn' : lower;
  if (mapped in LOG_LEVELS) {
    return mapped as LogLevel;
  }
  return null;
}

/**
 * Yargs coerce function for log-level options.
 * Maps the deprecated 'warning' value to 'warn' for backwards compatibility.
 */
export function coerceLogLevel(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return value.trim().toLowerCase() === 'warning' ? 'warn' : value;
}

/**
 * Set the minimum log level for client-requested filtering
 * @param level The minimum log level to output
 */
export function setLogLevel(level: LogLevel): void {
  clientLogLevel = level;
  log('debug', `Log level set to: ${level}`);
}

export function setLogFile(path: string | null): void {
  if (!path) {
    if (logFileStream) {
      try {
        logFileStream.end();
      } catch {
        // ignore
      }
    }
    logFileStream = null;
    logFilePath = null;
    return;
  }

  if (logFilePath === path && logFileStream) {
    return;
  }

  if (logFileStream) {
    try {
      logFileStream.end();
    } catch {
      // ignore
    }
  }

  try {
    const stream = createWriteStream(path, { flags: 'a' });
    stream.on('error', (error) => {
      if (stream !== logFileStream) return;
      logFileStream = null;
      logFilePath = null;
      const message = error instanceof Error ? error.message : String(error);
      const timestamp = new Date().toISOString();
      if (!areProcessStdioWritesSuppressed()) {
        console.error(`[${timestamp}] [ERROR] Log file disabled after error: ${message}`);
      }
    });
    logFileStream = stream;
    logFilePath = path;
    const timestamp = new Date().toISOString();
    logFileStream.write(`[${timestamp}] [INFO] Log file initialized\n`);
  } catch {
    logFileStream = null;
    logFilePath = null;
  }
}

/**
 * Get the current client-requested log level
 * @returns The current log level
 */
export function getLogLevel(): LogLevel {
  return clientLogLevel;
}

/**
 * Check if a log level should be output based on client settings
 * @param level The log level to check
 * @returns true if the message should be logged
 */
function shouldLog(level: string): boolean {
  if (isTestEnv() && !logFileStream) {
    return false;
  }

  if (clientLogLevel === 'none') {
    return false;
  }

  const levelKey = level.toLowerCase() as LogLevel;
  if (!(levelKey in LOG_LEVELS)) {
    return true;
  }

  return LOG_LEVELS[levelKey] <= LOG_LEVELS[clientLogLevel];
}

/**
 * Log a message with the specified level
 * @param level The log level (emergency, alert, critical, error, warning, notice, info, debug)
 * @param message The message to log
 * @param context Optional context to control Sentry capture and other behavior
 */
export function log(level: string, message: string, context?: LogContext): void {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}`;

  const captureToSentry = isSentryEnabled() && __shouldCaptureToSentryForTests(context);

  if (captureToSentry) {
    withSentry((s) => {
      const sentryLevel = mapLogLevelToSentry(level);
      const loggerMethod = s.logger?.[sentryLevel];
      if (typeof loggerMethod === 'function') {
        loggerMethod(message);
        return;
      }
      s.captureMessage(logMessage);
    });
  }

  if (logFileStream && clientLogLevel !== 'none') {
    try {
      logFileStream.write(`${logMessage}\n`);
    } catch {
      // ignore file logging failures
    }
  }

  if (!shouldLog(level)) {
    return;
  }

  // Uses stderr to avoid interfering with MCP protocol on stdout
  // https://modelcontextprotocol.io/docs/tools/debugging#server-side-logging
  if (areProcessStdioWritesSuppressed()) {
    return;
  }

  console.error(logMessage);
}
