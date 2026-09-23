---
name: mobilebuildmcp
description: Official skill for MobileBuildMCP. Use when doing iOS/macOS/watchOS/tvOS/visionOS work (build, test, run, debug, log, UI automation).
---

# MobileBuildMCP

Use MobileBuildMCP tools instead of raw `xcodebuild`, `xcrun`, or `simctl`.

Capabilities:
- Session defaults: Configure project, scheme, simulator, and device defaults to avoid repetitive parameters
- Project discovery: Find Xcode projects/workspaces, list schemes, inspect build settings
- Simulator workflows: Build, run, test, install, and launch apps on iOS simulators; manage simulator state (boot, erase, location, appearance)
- Device workflows: Build, test, install, and launch apps on physical devices with code signing
- macOS workflows: Build, run, and test macOS applications
- Log capture: Stream and capture logs from simulators and devices
- LLDB debugging: Attach debugger, set breakpoints, inspect stack traces and variables, execute LLDB commands
- UI automation: Capture screenshots, inspect view hierarchy with coordinates, perform taps/swipes/gestures, type text, press hardware buttons
- SwiftPM: Build, run, test, and manage Swift Package Manager projects
- Project scaffolding: Generate new iOS/macOS project templates

Only simulator workflow tools are enabled by default. If capabilities like device, macOS, debugging, or UI automation are not available, the user must configure MobileBuildMCP to enable them. See https://github.com/getsentry/xcodebuildmcp.com/blob/main/app/docs/_content/configuration.mdx for workflow configuration.

## Step 1: Establish Session Context

- Call `session_show_defaults` before the first build/run/test action in a session.
- Use `discover_projs` only when defaults show missing or incorrect project/workspace context.
- Do not run discovery speculatively or in parallel with `session_show_defaults`.
- For simulator run intent, prefer the combined build-and-run tool instead of separate build then run calls.
- Do not chain build-only then build-and-run unless the user explicitly requests both.

## Step 2: Understand Workflow-Scoped Tool Availability

- Not all tools are enabled by default; tool availability depends on enabled workflows.
- If a tool is expected but missing, check enabled workflows first.
- Update enabled workflows in `.mobilebuildmcp/config.yaml`, then ask user to reload/restart the session to surface refreshes.

## Step 3: Report Context Clearly

- Return the active defaults context used for execution (project/workspace, scheme, simulator/device).
- For failures, include the exact failing step and the next actionable command/tool call.
