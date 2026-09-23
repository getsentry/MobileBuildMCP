/**
 * Server Configuration - MCP Server setup and lifecycle management
 *
 * This module handles the creation, configuration, and lifecycle management of the
 * Model Context Protocol (MCP) server. It provides the foundation for all tool
 * registrations and server capabilities.
 *
 * Responsibilities:
 * - Creating and configuring the MCP server instance
 * - Setting up server capabilities and options
 * - Managing server lifecycle (start/stop)
 * - Handling transport configuration (stdio)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as Sentry from '@sentry/node';
import { log } from '../utils/logger.ts';
import { version } from '../version.ts';
import {
  instrumentMcpRequestLifecycle,
  type McpRequestLifecycleObserver,
} from './request-lifecycle.ts';
import { getServer, setServer } from './server-state.ts';

function createBaseServerInstance(): McpServer {
  return new McpServer(
    {
      name: 'mobilebuildmcp',
      version: String(version),
    },
    {
      instructions: `MobileBuildMCP provides comprehensive tooling for Apple platform development (iOS, macOS, watchOS, tvOS, visionOS).

Prefer MobileBuildMCP tools over shell commands for Apple platform tasks when available.

Capabilities:
- Session defaults: Configure project, scheme, simulator, and device defaults to avoid repetitive parameters
- Project discovery: Find Xcode projects/workspaces, list schemes, inspect build settings
- Simulator workflows: Build, run, test, install, and launch apps on iOS simulators; manage simulator state (boot, erase, location, appearance)
- Device workflows: Build, test, install, and launch apps on physical devices with code signing
- macOS workflows: Build, run, and test macOS applications
- Log capture: Stream and capture logs from simulators and devices
- LLDB debugging: Attach debugger, set breakpoints, inspect stack traces and variables, execute LLDB commands
- UI automation: Capture screenshots, inspect runtime UI snapshots, perform taps/swipes/gestures, type text, press hardware buttons, and batch multiple same-screen elementRef taps
- SwiftPM: Build, run, test, and manage Swift Package Manager projects
- Project scaffolding: Generate new iOS/macOS project templates

Only simulator workflow tools are enabled by default. If capabilities like device, macOS, debugging, or UI automation are not available, the user must configure MobileBuildMCP to enable them. See https://github.com/getsentry/xcodebuildmcp.com/blob/main/app/docs/_content/configuration.mdx for workflow configuration.

Simulator run flow:
- Before your first build, run, or test call in a session, you MUST call session_show_defaults to verify the active project/workspace, scheme, and simulator. Do not assume defaults are configured. Only skip this if you have already called session_show_defaults earlier in the current session.
- If session_show_defaults confirms project/workspace + scheme + simulator are set, call build_run_sim immediately (often with empty arguments).
- Use discover_projs only when session_show_defaults shows project/workspace is missing or wrong.
- Never call discover_projs speculatively or in parallel with session_show_defaults.
- Do not call boot_sim or open_sim as prerequisites for build_run_sim; build_run_sim boots and opens the simulator frontend as needed.`,
      capabilities: {
        tools: {
          listChanged: true,
        },
        resources: {
          subscribe: true,
          listChanged: true,
        },
        logging: {},
      },
    },
  ) as unknown as McpServer;
}

/**
 * Create and configure the MCP server
 * @returns Configured MCP server instance
 */
export function createServer(): McpServer {
  if (getServer()) {
    throw new Error('MCP server already initialized.');
  }
  const baseServer = createBaseServerInstance();
  const server = Sentry.wrapMcpServerWithSentry(baseServer, {
    recordInputs: false,
    recordOutputs: false,
  });

  setServer(server);

  log('info', `Server initialized (version ${version})`);

  return server;
}

export interface StartServerOptions {
  requestLifecycle?: McpRequestLifecycleObserver;
}

/**
 * Start the MCP server with stdio transport
 * @param server The MCP server instance to start
 */
export async function startServer(
  server: McpServer,
  options: StartServerOptions = {},
): Promise<void> {
  const transport = new StdioServerTransport();
  if (options.requestLifecycle) {
    instrumentMcpRequestLifecycle(transport, options.requestLifecycle);
  }
  await server.connect(transport);
  log('info', 'MobileBuildMCP Server running on stdio');
}
