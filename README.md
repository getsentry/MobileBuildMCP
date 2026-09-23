A Model Context Protocol (MCP) server and CLI that provides tools for agent use when working on iOS and macOS projects.

[![CI](https://github.com/getsentry/MobileBuildMCP/actions/workflows/ci.yml/badge.svg)](https://github.com/getsentry/MobileBuildMCP/actions/workflows/ci.yml)
[![npm version](https://badge.fury.io/js/mobilebuildmcp.svg)](https://badge.fury.io/js/mobilebuildmcp) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT) [![Node.js](https://img.shields.io/badge/node->=18.x-brightgreen.svg)](https://nodejs.org/) [![Xcode 16](https://img.shields.io/badge/Xcode-16-blue.svg)](https://developer.apple.com/xcode/) [![macOS](https://img.shields.io/badge/platform-macOS-lightgrey.svg)](https://www.apple.com/macos/) [![MCP](https://img.shields.io/badge/MCP-Compatible-green.svg)](https://modelcontextprotocol.io/) [![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/getsentry/MobileBuildMCP) [![AgentAudit Security](https://img.shields.io/badge/AgentAudit-Safe-brightgreen?logo=data:image/svg%2Bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0id2hpdGUiIGQ9Ik0xMiAxTDMgNXY2YzAgNS41NSAzLjg0IDEwLjc0IDkgMTIgNS4xNi0xLjI2IDktNi40NSA5LTEyVjVsLTktNHoiLz48L3N2Zz4=)](https://www.agentaudit.dev/skills/xcodebuildmcp) [![pkg.pr.new](https://pkg.pr.new/badge/getsentry/MobileBuildMCP)](https://pkg.pr.new/~/getsentry/MobileBuildMCP)

## Installation

MobileBuildMCP ships as a single package with two modes: a **CLI** for direct terminal use and an **MCP server** for AI coding agents. Either install method gives you both.

### Option A — Homebrew

```bash
brew tap getsentry/xcodebuildmcp
brew install mobilebuildmcp
```

### Option B — npm (Node.js 18+)

```bash
npm install -g mobilebuildmcp@latest
```

Verify either install:
```bash
mobilebuildmcp --help
```

### Connect your MCP client

Drop-in config snippets for Cursor, Claude Code, Codex, can be found in the official docs page [MCP Clients](https://github.com/getsentry/xcodebuildmcp.com/blob/main/app/docs/_content/clients.mdx). Most clients can also run the MCP server on demand via `npx -y mobilebuildmcp@latest mcp` without a global install.

## Requirements

- macOS 14.5 or later
- Xcode 16.x or later
- Node.js 18.x or later (not required for Homebrew installation)

## Skills

MobileBuildMCP now includes two optional agent skills:

- **MCP Skill**: Primes the agent with instructions on how to use the MCP server's tools (optional when using the MCP server).

- **CLI Skill**: Primes the agent with instructions on how to navigate the CLI (recommended when using the CLI).


To install with a global binary:

```bash
mobilebuildmcp init
```

Or install directly via npx without a global install:

```bash
npx -y mobilebuildmcp@latest init
```

For further information on installing skills, see [Agent Skills](https://github.com/getsentry/xcodebuildmcp.com/blob/main/app/docs/_content/skills.mdx).

## Notes

- MobileBuildMCP requests xcodebuild to skip macro validation to avoid errors when building projects that use Swift Macros.
- Device tools require code signing to be configured in Xcode. See [Device Code Signing](https://github.com/getsentry/xcodebuildmcp.com/blob/main/app/docs/_content/device-signing.mdx).

## Privacy

MobileBuildMCP uses Sentry for internal runtime error telemetry only. For details and opt-out instructions, see [Privacy & Telemetry](https://github.com/getsentry/xcodebuildmcp.com/blob/main/app/docs/_content/privacy.mdx).

## CLI

MobileBuildMCP provides a unified command-line interface. The `mcp` subcommand starts the MCP server, while all other commands provide direct terminal access to tools:

```bash
# Install globally
npm install -g mobilebuildmcp@latest

# Start the MCP server (for MCP clients)
mobilebuildmcp mcp

# List available tools
mobilebuildmcp tools

# Build for simulator
mobilebuildmcp simulator build --scheme MyApp --project-path ./MyApp.xcodeproj

# Prepare portable test products without running tests
mobilebuildmcp simulator build --scheme MyApp --project-path ./MyApp.xcodeproj --simulator-name "iPhone 17" --build-for-testing --test-products-path ./MyApp.xctestproducts

# Run previously prepared test products
mobilebuildmcp simulator test --test-products-path ./MyApp.xctestproducts --simulator-name "iPhone 17"
```

Check for updates and upgrade in place:

```bash
mobilebuildmcp upgrade --check
mobilebuildmcp upgrade --yes
```

The CLI uses a per-workspace daemon for stateful operations (log capture, debugging, etc.) that auto-starts when needed. See the [CLI guide](https://github.com/getsentry/xcodebuildmcp.com/blob/main/app/docs/_content/cli.mdx) for full documentation.

## Documentation

- Installation: [https://github.com/getsentry/xcodebuildmcp.com/blob/main/app/docs/_content/installation.mdx](https://github.com/getsentry/xcodebuildmcp.com/blob/main/app/docs/_content/installation.mdx)
- Setup: [https://github.com/getsentry/xcodebuildmcp.com/blob/main/app/docs/_content/setup.mdx](https://github.com/getsentry/xcodebuildmcp.com/blob/main/app/docs/_content/setup.mdx)
- MCP clients: [https://github.com/getsentry/xcodebuildmcp.com/blob/main/app/docs/_content/clients.mdx](https://github.com/getsentry/xcodebuildmcp.com/blob/main/app/docs/_content/clients.mdx)
- CLI usage: [https://github.com/getsentry/xcodebuildmcp.com/blob/main/app/docs/_content/cli.mdx](https://github.com/getsentry/xcodebuildmcp.com/blob/main/app/docs/_content/cli.mdx)
- Configuration and options: [https://github.com/getsentry/xcodebuildmcp.com/blob/main/app/docs/_content/configuration.mdx](https://github.com/getsentry/xcodebuildmcp.com/blob/main/app/docs/_content/configuration.mdx)
- Tools reference: [https://github.com/getsentry/xcodebuildmcp.com/blob/main/app/docs/_content/tools.mdx](https://github.com/getsentry/xcodebuildmcp.com/blob/main/app/docs/_content/tools.mdx)
- Troubleshooting: [https://github.com/getsentry/xcodebuildmcp.com/blob/main/app/docs/_content/troubleshooting.mdx](https://github.com/getsentry/xcodebuildmcp.com/blob/main/app/docs/_content/troubleshooting.mdx)
- Privacy: [https://github.com/getsentry/xcodebuildmcp.com/blob/main/app/docs/_content/privacy.mdx](https://github.com/getsentry/xcodebuildmcp.com/blob/main/app/docs/_content/privacy.mdx)
- Skills: [https://github.com/getsentry/xcodebuildmcp.com/blob/main/app/docs/_content/skills.mdx](https://github.com/getsentry/xcodebuildmcp.com/blob/main/app/docs/_content/skills.mdx)
- Contributing: [https://github.com/getsentry/xcodebuildmcp.com/blob/main/app/docs/_content/contributing.mdx](https://github.com/getsentry/xcodebuildmcp.com/blob/main/app/docs/_content/contributing.mdx)

## Licence

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
For third-party licensing notices see the [THIRD_PARTY_LICENSES](THIRD_PARTY_LICENSES) file for details.
For npm package attributions see the [THIRD_PARTY_PACKAGE_LICENSES](THIRD_PARTY_PACKAGE_LICENSES.md) file for details.
