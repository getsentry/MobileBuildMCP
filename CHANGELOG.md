# Changelog

## [Unreleased]

### Changed

- Renamed the project from XcodeBuildMCP to MobileBuildMCP. The npm package, CLI binaries (`mobilebuildmcp`, `mobilebuildmcp-doctor`), Homebrew formula, `MOBILEBUILDMCP_*` environment variables, `mobilebuildmcp://` resource URIs, `mobilebuildmcp.output.*` structured output schema IDs, the `.mobilebuildmcp/config.yaml` project config directory, and the `~/Library/Developer/MobileBuildMCP` state directory all use the new name. The `xcodebuildmcp.com` domain is retired: structured output schema `$id` URLs now use `https://raw.githubusercontent.com/getsentry/MobileBuildMCP/main/schemas/structured-output/`, documentation links point at the docs sources in the `getsentry/xcodebuildmcp.com` repository, and the MCP registry name is `io.github.getsentry/mobilebuildmcp`.
- Dictionary-shaped MCP inputs now use client-compatible wire representations ([#491](https://github.com/getsentry/XcodeBuildMCP/issues/491)). The `env` and `testRunnerEnv` inputs on build, launch, test, and session-default tools are arrays of `{ "key": "...", "value": "..." }` entries, while `xcode_ide_call_tool.arguments` is a JSON object string. MobileBuildMCP converts these values to their existing internal objects only after MCP input validation.

## [2.7.0]

### New! Xcode 27 Device Hub simulator support

UI automation tools now work fully with Xcode 27 simulators through Device Hub, including simulator window launching and keyboard controls. XcodeBuildMCP targets the selected simulator directly and uses locale-independent menu actions, while maintaining backward compatibility with Simulator.app on earlier Xcode versions.

### Breaking

#### Build and test structured results now use schema version 3

Build and test tools now return `schemaVersion: "3"` so prepared-test paths can be included in structured results. This affects MCP and CLI JSON consumers that validate `xcodebuildmcp.output.build-result` or `xcodebuildmcp.output.test-result` against version 2; consumers that only display or pass through tool results are unaffected.

If no action is taken, validators pinned to version 2 will reject new build and test results. Update them to accept the version 3 schemas, while retaining version 2 support when older XcodeBuildMCP releases remain in use.

Before:

```text
https://xcodebuildmcp.com/schemas/structured-output/xcodebuildmcp.output.build-result/2.schema.json
https://xcodebuildmcp.com/schemas/structured-output/xcodebuildmcp.output.test-result/2.schema.json
```

After:

```text
https://xcodebuildmcp.com/schemas/structured-output/xcodebuildmcp.output.build-result/3.schema.json
https://xcodebuildmcp.com/schemas/structured-output/xcodebuildmcp.output.test-result/3.schema.json
```

#### Unspecified build configurations now follow the scheme

Build, test, clean, and app-path commands now honor the scheme action's configuration when `configuration` is omitted instead of always using Debug. This fixes incorrect build settings for schemes that use another configuration, but scripts or agents that relied on the implicit Debug selection must now request it explicitly.

Before:

```bash
xcodebuildmcp simulator build --scheme MyApp --project-path ./MyApp.xcodeproj
```

After:

```bash
xcodebuildmcp simulator build \
  --scheme MyApp \
  --project-path ./MyApp.xcodeproj \
  --configuration Debug
```

For MCP calls, set `configuration: "Debug"` ([#443](https://github.com/getsentry/XcodeBuildMCP/issues/443), [#460](https://github.com/getsentry/XcodeBuildMCP/pull/460) by [@hujunfeng](https://github.com/hujunfeng)).

### Added

- Added `xcodebuildmcp purge` to inspect and clean workspace storage managed by XcodeBuildMCP. It defaults to the current workspace, supports reports and dry runs, and requires explicit opt-in before removing DerivedData.
- Added reusable `extraArgs` session defaults for build and test commands, so common `xcodebuild` flags and build settings can be configured once in project config or the active session. Per-call values override matching defaults, and `extraArgs: []` clears them for one call ([#463](https://github.com/getsentry/XcodeBuildMCP/pull/463) by [@jknlsn](https://github.com/jknlsn)). See [config.example.yaml](config.example.yaml).
- Added reusable test preparation to simulator, device, and macOS workflows. Build tools can produce a portable `.xctestproducts` package, and test tools can run it—or an advanced `.xctestrun` file—without rebuilding while still producing a fresh `.xcresult` ([#450](https://github.com/getsentry/XcodeBuildMCP/issues/450)). See [CLI examples](README.md#cli).

### Fixed

- Fixed MCP clients waiting 10–17 seconds for tools to become available, which could make short health checks report a failed connection ([#461](https://github.com/getsentry/XcodeBuildMCP/issues/461), [#468](https://github.com/getsentry/XcodeBuildMCP/pull/468) by [@Pitchfork-and-Torch](https://github.com/Pitchfork-and-Torch)).
- Fixed simulator commands selecting the wrong platform when a configured simulator is unavailable, especially for projects that support both iOS and visionOS. Setup now ignores unavailable simulators and records the selected platform.
- Fixed simulator and project discovery failures caused by malformed simulator data, projects with shared path prefixes, and compiler diagnostic filenames containing glob characters ([#424](https://github.com/getsentry/XcodeBuildMCP/issues/424)).
- Fixed `suppressWarnings` so warnings are omitted from final build, build-and-run, and test responses as well as live progress ([#447](https://github.com/getsentry/XcodeBuildMCP/issues/447), [#470](https://github.com/getsentry/XcodeBuildMCP/pull/470) by [@JoshKappler](https://github.com/JoshKappler)).
- Fixed multiple edge cases in iOS scaffolding, LLDB sessions, run-destination detection, concurrent operations, and physical-device name lookup that could produce incorrect project settings, mixed debugger output, missing destinations, or blocked responses ([#459](https://github.com/getsentry/XcodeBuildMCP/issues/459)).
- Fixed `stop_mac_app` app-name targeting so it no longer terminates unrelated processes whose later command-line arguments contain the app name, and rejects unsafe process IDs before execution ([#306](https://github.com/getsentry/XcodeBuildMCP/issues/306)).
- Fixed incremental builds with absolute DerivedData paths, long configuration arguments, changed build settings, or updated project files so generated build data is reused only when it is still valid ([#466](https://github.com/getsentry/XcodeBuildMCP/issues/466)).
- Fixed security risks by preventing environment-derived values from being interpreted as shell commands, verifying downloaded incremental-build tooling before execution, and restricting CI and release workflows to read-only repository access.

Various other internal improvements to stability, performance, and code quality.

## [2.6.2]

### Fixed

- Fixed `xcodebuildmcp upgrade` so update checks use the latest GitHub release as the canonical target instead of stale package-manager metadata, ensuring multi-version upgrades show release notes for the actual target version.

## [2.6.1]

### Fixed

- Fixed tab bar item discovery so agents can switch `UITabBar` items ([#439](https://github.com/getsentry/XcodeBuildMCP/issues/439), [#441](https://github.com/getsentry/XcodeBuildMCP/pull/441)).

## [2.6.0]

### New! Runtime UI automation

UI automation now hands your agent reusable context instead of just confirming an action ran. After a tap, swipe, type, wait, or batch, the result includes a compact snapshot of the foreground UI with stable element references and a screen hash, so the agent can pick the next control directly rather than taking another screenshot or re-running a full snapshot. Candidate controls are ranked from real accessibility data, and suggested next steps point at concrete element references instead of guessed coordinates.

In a deterministic Weather-app task, this cut wall-clock time by roughly 70%, token usage by roughly 68%, and total tool calls by roughly 76%.

New tools and options:

- `wait_for_ui` polls the UI until a predicate is satisfied — existence, enabled state, focus, visible text, or settled layout.
- `batch` performs a sequence of element-reference actions in one call, so agents can run several same-screen taps without a snapshot round-trip between each step.
- `drag` performs element-reference drag gestures for expanding sheets and scrolling real list regions without coordinate guessing.
- `snapshot_ui` now returns stable element references and a screen hash. Pass `sinceScreenHash` (MCP) / `--since-screen-hash` (CLI) to skip a full snapshot when the screen has not changed.
- `type_text` accepts `replaceExisting` to replace a field's current value instead of appending to it.

See [Tools Reference](https://xcodebuildmcp.com/docs/tools).

### Added

- Added follow-up `nextSteps` to machine-readable results so agents can act on suggested next actions without scraping prose. MCP `structuredContent` carries MCP tool-call hints and CLI `--output json` carries shell command lines. Result schemas that include `nextSteps` move to schema version 2; version 1 schema files remain available for existing validators. See [Output Formats](https://xcodebuildmcp.com/docs/output-formats).
- Added an opt-in `XCODEBUILDMCP_HEADLESS_LAUNCH` mode for automated runs that should not steal macOS focus: macOS apps launch in the background, the Simulator window is not brought to the foreground (the simulator runtime still boots), and keyboard-shortcut actions fail fast with a clear foreground-focus requirement. See [Environment Variables](https://xcodebuildmcp.com/docs/env-vars).

### Fixed

- Fixed structured output so MCP clients that validate tool results can load every structured-output tool again. Published schemas are now self-contained, resolving validation failures such as `PointerToNowhere` in JSON Schema 2020-12 validators that do not re-base references across embedded schemas ([#419](https://github.com/getsentry/XcodeBuildMCP/issues/419), [#423](https://github.com/getsentry/XcodeBuildMCP/pull/423) by [@Subharup-31](https://github.com/Subharup-31)).
- Clarified `debug_attach_sim` PID attach arguments so the schema documents that `pid` must be used without `bundleId` or `waitFor`, and invalid `pid` + `waitFor: true` calls now fail validation before LLDB is invoked ([#417](https://github.com/getsentry/XcodeBuildMCP/issues/417)).
- Fixed simulator-name session defaults in the CLI so a name-only default resolves to a simulator ID for tools that take an ID, resolves before simulator lifecycle operations, and does not add conflicting simulator arguments to tools that already accept a name.
- Fixed CLI JSON output so simulator-name resolution failures return the structured error envelope instead of plain stderr, and a launch failure during resolution is no longer reported as a macOS launch failure.
- Fixed `type_text` so characters AXe cannot type, such as accented or other international characters, fail with a clear recoverable error before the field is focused instead of a generic typing failure.
- Fixed CLI numeric array flags so comma-separated values such as `--key-codes 23,18,14` are parsed as numbers instead of failing validation.

Various other internal improvements to stability, performance, and code quality.

## [2.5.2]

### Changed

- Updated the bundled AXe binary used by UI automation tools to 1.7.0.

### Fixed

- Fixed a log-capture vulnerability where a crafted `bundleId` or custom subsystem filter could broaden simulator log streams to capture output from other apps or Apple system subsystems. Bundle IDs and subsystem filters are now validated against a strict allowlist before reaching the predicate ([#407](https://github.com/getsentry/XcodeBuildMCP/pull/407) by [@sebastiondev](https://github.com/sebastiondev)).
- Fixed `debug_attach_sim` so an explicit `pid` overrides an inherited `bundleId` session default before mutual-exclusion validation ([#410](https://github.com/getsentry/XcodeBuildMCP/issues/410)).

## [2.5.1]

### Fixed

- Fixed portable macOS/Homebrew installs missing structured output schemas, which prevented MCP clients from loading tools.

## [2.5.0]

### Breaking

#### Standalone log-capture tools removed

The old `logging` workflow and its standalone log-capture tools (`start_sim_log_cap`, `stop_sim_log_cap`, `start_device_log_cap`, `stop_device_log_cap`, and `launch_app_logs_sim`) have been removed. This affects users, scripts, and agents that call those tool names directly.

Use the launch or build-and-run tools instead. They return runtime log paths as part of the normal result, so agents no longer need a separate start/stop log-capture sequence.

Before:

```bash
xcodebuildmcp logging start-sim-log-cap --simulator-id <UDID> --bundle-id com.example.MyApp
xcodebuildmcp simulator launch-app --simulator-id <UDID> --bundle-id com.example.MyApp
xcodebuildmcp logging stop-sim-log-cap --pid <PID>
```

After:

```bash
xcodebuildmcp simulator build-and-run --scheme MyApp --project-path ./MyApp.xcodeproj

# Or, for an app that is already installed on a simulator:
xcodebuildmcp simulator launch-app --simulator-id <UDID> --bundle-id com.example.MyApp
```

For MCP clients, use `build_run_sim` or `launch_app_sim` and read the returned runtime log path.

#### Runtime launch arguments now use `launchArgs`

Build-and-run and launch-only tools now separate build settings from app launch arguments. This affects users, scripts, and agents that previously passed runtime arguments through `extraArgs` or the launch-only `args` input.

If you do nothing, app runtime arguments may not reach the launched process, and launch-only calls that still use `args` will fail validation. Move app arguments to `launchArgs`; keep `extraArgs` only for `xcodebuild` flags and build setting overrides.

Before:

```bash
xcodebuildmcp simulator build-and-run --json '{
  "scheme": "MyApp",
  "projectPath": "./MyApp.xcodeproj",
  "extraArgs": ["--uitesting"]
}'
```

After:

```bash
xcodebuildmcp simulator build-and-run --json '{
  "scheme": "MyApp",
  "projectPath": "./MyApp.xcodeproj",
  "launchArgs": ["--uitesting"]
}'
```

Launch-only tools use the same input:

```bash
xcodebuildmcp simulator launch-app --json '{
  "simulatorId": "<UDID>",
  "bundleId": "com.example.MyApp",
  "launchArgs": ["--uitesting"]
}'
```

For MCP clients, use `launchArgs` on `build_run_sim`, `build_run_device`, `build_run_macos`, `launch_app_sim`, `launch_app_device`, and `launch_mac_app`. See [CLI](https://xcodebuildmcp.com/docs/cli#build-and-run-in-one-step).

### New! Structured outputs

XcodeBuildMCP now returns structured, machine-readable results across supported MCP clients and the CLI. Agents and scripts no longer have to scrape prose to find build status, log paths, bundle IDs, process IDs, test failures, or app paths. The human-readable text remains available, but every supported result now has a consistent envelope with the same fields:

```json
{
  "schema": "xcodebuildmcp.output.build-run-result",
  "schemaVersion": "1",
  "didError": false,
  "error": null,
  "data": { }
}
```

For agents, this reduces token usage and makes tool results easier to act on reliably. Instead of rereading a full text transcript to find the build log, runtime log, or launched process, the agent can jump straight to fields such as `data.artifacts.buildLogPath`, `data.artifacts.runtimeLogPath`, `data.artifacts.osLogPath`, `data.artifacts.appPath`, `data.artifacts.bundleId`, and `data.artifacts.processId`.

#### MCP clients

MCP clients that support structured tool results receive `structuredContent` alongside the existing text response. The text remains useful for humans and older clients; supported clients can use the structured fields directly.

Example Build & Run result shape:

```json
{
  "schema": "xcodebuildmcp.output.build-run-result",
  "schemaVersion": "1",
  "didError": false,
  "error": null,
  "data": {
    "summary": { "status": "SUCCEEDED", "durationMs": 1234, "target": "simulator" },
    "artifacts": {
      "appPath": "~/Library/Developer/XcodeBuildMCP/DerivedData/.../CalculatorApp.app",
      "bundleId": "io.sentry.calculatorapp",
      "processId": 99999,
      "buildLogPath": "~/Library/Developer/XcodeBuildMCP/logs/build_run_sim_...log",
      "runtimeLogPath": "~/Library/Developer/XcodeBuildMCP/logs/io.sentry.calculatorapp_...log",
      "osLogPath": "~/Library/Developer/XcodeBuildMCP/logs/io.sentry.calculatorapp_oslog_...log"
    }
  }
}
```

#### CLI JSON output

The CLI now supports `--output text|json|jsonl|raw` for tool commands. `text` remains the default. Use `--output json` when a script, CI job, or agent needs one final result document:

```bash
xcodebuildmcp simulator build-and-run --output json
```

```json
{
  "schema": "xcodebuildmcp.output.build-run-result",
  "schemaVersion": "1",
  "didError": false,
  "error": null,
  "data": {
    "request": { "scheme": "CalculatorApp", "platform": "iOS Simulator" },
    "summary": { "status": "SUCCEEDED", "durationMs": 1234, "target": "simulator" },
    "artifacts": { "buildLogPath": "~/Library/Developer/XcodeBuildMCP/logs/build_run_sim_...log" },
    "diagnostics": { "warnings": [], "errors": [] }
  }
}
```

Use `--output jsonl` for live progress as newline-delimited JSON, one event per line:

```jsonl
{"event":"build-result.invocation","operation":"BUILD","request":{"scheme":"CalculatorApp","platform":"iOS Simulator"}}
{"event":"build-result.build-stage","operation":"BUILD","stage":"COMPILING","message":"Compiling CalculatorApp"}
{"event":"build-result.build-summary","operation":"BUILD","status":"SUCCEEDED","durationMs":3421}
```

Failures use the same envelope as successes, so callers can rely on `didError`, `error`, `data.summary`, `data.diagnostics`, and test-specific fields like `testCases` and `testFailures` instead of handling every command differently.

#### Published schemas

The structured result contracts are published as JSON Schema and can be used to validate output or generate types:

```text
https://xcodebuildmcp.com/schemas/structured-output/<schema-name>/<version>.schema.json
```

For example: [`xcodebuildmcp.output.build-run-result` v1](https://xcodebuildmcp.com/schemas/structured-output/xcodebuildmcp.output.build-run-result/1.schema.json). See [Output Formats](https://xcodebuildmcp.com/docs/output-formats) for the full reference.

### Added

- Added `xcodebuildmcp upgrade` to check for available updates and upgrade in place, with `--check` for report-only use and `--yes`/`-y` for non-interactive upgrades.
- Added a platform-aware `xcodebuildmcp setup` wizard: choose macOS, iOS, tvOS, watchOS, or visionOS up front; get platform-appropriate workflow recommendations; skip simulator/device prompts for macOS-only projects; and reuse previous choices when re-running setup. Single-platform setups also include the platform in generated config and `--format mcp-json` output. See [Setup](https://xcodebuildmcp.com/docs/setup) ([#365](https://github.com/getsentry/XcodeBuildMCP/pull/365), based on work by [@ichoosetoaccept](https://github.com/ichoosetoaccept)).
- Added `XCODEBUILDMCP_CWD` so MCP clients that cannot choose the server's start directory can still point project config discovery and relative-path resolution at the right workspace. See [Environment Variables](https://xcodebuildmcp.com/docs/env-vars#general-settings).
- Added per-test timing output, so agents and scripts can identify slow tests without opening the full test report. JSON and structured results include a `testCases` list, and text output can show per-test durations with `showTestTiming` or `XCODEBUILDMCP_SHOW_TEST_TIMING=1` ([#339](https://github.com/getsentry/XcodeBuildMCP/pull/339) by [@codeman9](https://github.com/codeman9)).
- Added default result bundles for simulator, device, macOS, and Swift Package test runs, so agents can inspect detailed test artifacts without manually choosing a result bundle path.
- Added opt-in idle shutdown for unused MCP server processes via `XCODEBUILDMCP_MCP_IDLE_TIMEOUT_MS`, reducing leftover background processes for clients that keep server sessions open ([#398](https://github.com/getsentry/XcodeBuildMCP/pull/398)). See [Environment Variables](https://xcodebuildmcp.com/docs/env-vars#mcp-idle-shutdown).
- Added `toggle_software_keyboard` and `toggle_connect_hardware_keyboard` tools for showing/hiding the iOS Simulator software keyboard and connecting/disconnecting the Mac hardware keyboard. See [Tools Reference](https://xcodebuildmcp.com/docs/tools) ([#346](https://github.com/getsentry/XcodeBuildMCP/issues/346), [#347](https://github.com/getsentry/XcodeBuildMCP/pull/347) by [@yjmeqt](https://github.com/yjmeqt)).
- Added tvOS, watchOS, and visionOS support to `build_device`, so physical-device builds are no longer limited to iOS. See [Device Code Signing](https://xcodebuildmcp.com/docs/device-signing) ([#352](https://github.com/getsentry/XcodeBuildMCP/pull/352) by [@bitxeno](https://github.com/bitxeno)).

### Changed

- CLI build and test commands now show live progress while they are running instead of waiting until the command finishes. See [Output Formats](https://xcodebuildmcp.com/docs/output-formats).
- CLI text output now shows file paths in a more readable `Files:` list by default. Use `--file-path-render-style tree`, `filePathRenderStyle`, or `XCODEBUILDMCP_FILE_PATH_RENDER_STYLE` if you prefer the compact tree layout used by MCP text responses ([#402](https://github.com/getsentry/XcodeBuildMCP/pull/402)). See [Output Formats](https://xcodebuildmcp.com/docs/output-formats#output-text).
- Xcode IDE tool results are now shorter in final output, with full details still accessible when needed. CLI JSON and JSONL output now work for Xcode IDE tool calls too ([#396](https://github.com/getsentry/XcodeBuildMCP/pull/396)).
- Runtime log capture is more reliable across restarts, cleans itself up when apps stop or the server shuts down, and avoids stopping active log streams from another workspace ([#382](https://github.com/getsentry/XcodeBuildMCP/issues/382)).
- XcodeBuildMCP now cleans up old logs and temporary build artifacts more reliably without disrupting concurrent active sessions ([#391](https://github.com/getsentry/XcodeBuildMCP/pull/391)).
- Builds and tests now use an isolated DerivedData location per workspace or project when you have not set `derivedDataPath`, reducing cross-project build conflicts while keeping explicit `derivedDataPath` settings unchanged ([#340](https://github.com/getsentry/XcodeBuildMCP/issues/340), [#341](https://github.com/getsentry/XcodeBuildMCP/pull/341) by [@codeman9](https://github.com/codeman9)).
- Long-form documentation has moved to [xcodebuildmcp.com/docs](https://xcodebuildmcp.com/docs), with the README focused on installation, setup, and quick links to the hosted guides.

### Fixed

- Fixed shell-injection vulnerabilities when user-provided values were passed to Apple developer tools, log-capture queries, bundle ID extraction, and macOS launch flows ([#289](https://github.com/getsentry/XcodeBuildMCP/pull/289) by [@sebastiondev](https://github.com/sebastiondev), [#390](https://github.com/getsentry/XcodeBuildMCP/pull/390) by [@voidborne-d](https://github.com/voidborne-d)).
- Fixed a path traversal vulnerability that could allow reading files outside the expected scope.
- Fixed portable macOS installs missing a required runtime dependency, which could make packaged installs fail when commands needed file matching.
- Fixed configured paths that begin with `~` or `~/` so project, workspace, DerivedData, AXe, and template paths resolve under the user's home directory instead of creating literal `~` folders. Absolute configured paths are now normalized before use ([#283](https://github.com/getsentry/XcodeBuildMCP/issues/283), supersedes [#301](https://github.com/getsentry/XcodeBuildMCP/pull/301) by [@trmquang93](https://github.com/trmquang93)).
- Fixed device build next-step guidance so agents no longer suggest unsupported `--device-id` or `deviceId` arguments ([#287](https://github.com/getsentry/XcodeBuildMCP/issues/287), [#300](https://github.com/getsentry/XcodeBuildMCP/pull/300) by [@trmquang93](https://github.com/trmquang93), [#350](https://github.com/getsentry/XcodeBuildMCP/pull/350) by [@MukundaKatta](https://github.com/MukundaKatta)).
- Fixed Xcode IDE manual disconnect immediately reconnecting after the user explicitly disconnected it ([#343](https://github.com/getsentry/XcodeBuildMCP/issues/343), [#344](https://github.com/getsentry/XcodeBuildMCP/pull/344) by [@shaun0927](https://github.com/shaun0927)).
- Fixed simulator defaults refresh so stale simulator IDs are reconciled when both a simulator name and ID are configured, without rewriting shared project config files unnecessarily ([#357](https://github.com/getsentry/XcodeBuildMCP/issues/357)).
- Fixed session profile output so the `persisted` field accurately reflects whether a profile switch was saved.
- Fixed long-running commands that could hang even after completing.
- Fixed build and test failures after command startup returning incomplete output; they now finish with a clear error result and log paths.
- Fixed final text and JSON results changing unexpectedly when commands also stream live progress ([#360](https://github.com/getsentry/XcodeBuildMCP/issues/360)).
- Fixed test result output so agents can find xcresult bundle paths after simulator, device, macOS, and Swift Package test runs ([#397](https://github.com/getsentry/XcodeBuildMCP/pull/397)).
- Fixed test summaries and progress output so CLI tests no longer show false compiler errors, mixed Swift Testing/XCTest suites are counted accurately, parameterized Swift Testing cases are not overcounted, and simulator test progress stays visible while tests run ([#383](https://github.com/getsentry/XcodeBuildMCP/issues/383), [#392](https://github.com/getsentry/XcodeBuildMCP/issues/392)).
- Fixed device tool calls that use session defaults so they no longer fail when platform is omitted.

Various other internal improvements to stability, performance, and code quality.

## [2.3.2]

### Fixed

- Improved reliability of internal telemetry during shutdown ([#302](https://github.com/getsentry/XcodeBuildMCP/pull/302)).

## [2.3.1]

### Fixed

- Fixed unnecessary tool confirmation prompts in MCP clients (such as Codex) that treat missing approval annotations as high-risk defaults ([#297](https://github.com/getsentry/XcodeBuildMCP/pull/297)).

## [2.3.0]

### Added

- Added environment variable support for session defaults (e.g. `XCODEBUILDMCP_WORKSPACE_PATH`, `XCODEBUILDMCP_SCHEME`, `XCODEBUILDMCP_PLATFORM`) so MCP clients can supply startup defaults in their config without a project config file ([#268](https://github.com/getsentry/XcodeBuildMCP/pull/268) by [@detailobsessed](https://github.com/detailobsessed)). See [docs/CONFIGURATION.md](docs/CONFIGURATION.md#environment-variables).
- Added `--format mcp-json` flag to `xcodebuildmcp setup` that exports an env-based MCP client config block instead of writing `config.yaml` ([#268](https://github.com/getsentry/XcodeBuildMCP/pull/268) by [@detailobsessed](https://github.com/detailobsessed)).

### Changed

- Clarified configuration layering: `session_set_defaults` overrides `config.yaml`, which overrides environment variables. See [docs/CONFIGURATION.md](docs/CONFIGURATION.md) ([#268](https://github.com/getsentry/XcodeBuildMCP/pull/268) by [@detailobsessed](https://github.com/detailobsessed)).
- Improved `xcodebuildmcp setup` reliability when optional targets (like physical devices) are unavailable.

### Fixed

- Fixed `.xcodebuildmcp/config.yaml` being modified on startup when simulator metadata was refreshed ([#230](https://github.com/getsentry/XcodeBuildMCP/issues/230)).
- Fixed orphaned MCP server processes that could remain running after the client disconnects ([#273](https://github.com/getsentry/XcodeBuildMCP/issues/273)).
- Fixed `list-schemes` CLI command missing `--project-path` and `--workspace-path` flags ([#271](https://github.com/getsentry/XcodeBuildMCP/pull/271)).
- Fixed Xcode IDE workflow tools not working when invoked from the CLI.
- Fixed Swift Package tools not properly waiting for process exit when stopping.

## [2.2.1]

- Fix AXe bundling issue.

## [2.2.0]

### Added

- Added `get_coverage_report` and `get_file_coverage` tools for inspecting code coverage from test results — view per-target summaries or drill into function-level coverage and uncovered line ranges for specific files ([#240](https://github.com/getsentry/XcodeBuildMCP/pull/240) by [@irangareddy](https://github.com/irangareddy)). See [docs/TOOLS.md](docs/TOOLS.md).
- Added a unified build-and-run command for physical devices, matching the existing simulator workflow so agents can build and launch device apps in a single step.
- Added an interactive setup wizard via `xcodebuildmcp setup` that walks you through creating or updating `.xcodebuildmcp/config.yaml` — select workflows, pick a simulator, set your scheme and project, and configure debug options without editing YAML by hand. Non-interactive mode remains available for CI and scripting. See [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

  ```bash
  xcodebuildmcp setup
  ```
- Added `AGENTS.md` generation to the `init` command, providing prescriptive agent workflow instructions for your project.
- Added support for custom workflows in `.xcodebuildmcp/config.yaml`. Define your own workflow names and map them to an explicit list of tools, then reference them from `enabledWorkflows` like any built-in workflow. This lets you limit the tools your agent sees to exactly the ones you need. See [docs/CONFIGURATION.md](docs/CONFIGURATION.md#custom-workflows).

  ```yaml
  enabledWorkflows: ["my-workflow"]
  customWorkflows:
    my-workflow:
      - build_run_sim
      - record_sim_video
      - screenshot
  ```
- Added AdaL CLI setup instructions ([#242](https://github.com/getsentry/XcodeBuildMCP/pull/242) by [@Abdulrahmansoliman](https://github.com/Abdulrahmansoliman)).

### Changed

- CLI now auto-fills tool arguments from session defaults. If your config file sets a scheme, project path, or simulator, every CLI command picks those up automatically — no need to repeat `--scheme`, `--project-path`, and similar flags on every invocation. See [docs/CLI.md](docs/CLI.md).

  ```yaml
  # .xcodebuildmcp/config.yaml
  sessionDefaults:
    scheme: MyApp
    projectPath: ./MyApp.xcodeproj
    simulatorName: iPhone 17 Pro
  ```

  ```bash
  # Before: every command needed explicit flags
  xcodebuildmcp simulator build --scheme MyApp --project-path ./MyApp.xcodeproj

  # Now: flags are filled from session defaults
  xcodebuildmcp simulator build
  ```

  This also works with session defaults profiles, which is especially useful for monorepos. Define a profile per sub-project and the CLI uses the active profile's values. Override the profile for a single command with `--profile`. See [docs/SESSION_DEFAULTS.md](docs/SESSION_DEFAULTS.md#namespaced-profiles).

  ```yaml
  # .xcodebuildmcp/config.yaml
  schemaVersion: 1
  sessionDefaultsProfiles:
    calculator:
      workspacePath: ./iOS_Calculator/CalculatorApp.xcworkspace
      scheme: CalculatorApp
      simulatorName: iPhone 17 Pro
    ios-test:
      projectPath: ./iOS/MCPTest.xcodeproj
      scheme: MCPTest
      simulatorName: iPhone 17 Pro
    spm:
      projectPath: ./spm
      scheme: spm
  activeSessionDefaultsProfile: calculator
  ```

  ```bash
  # Build using the active profile (calculator)
  xcodebuildmcp simulator build-and-run

  # Build a different sub-project without switching the active profile
  xcodebuildmcp simulator build-and-run --profile ios-test
  ```
- Default simulator updated from iPhone 16 to iPhone 17.
- Tool annotations now more accurately classify operations, reducing unnecessary confirmation prompts in MCP clients that respect annotations ([#253](https://github.com/getsentry/XcodeBuildMCP/pull/253) by [@saschagordner](https://github.com/saschagordner)).
- Improved agent workflow guidance with more prescriptive instructions for common tasks.
- Bundled AXe updated to 1.5.2.

### Fixed

- Fixed Swift Package tools (`swift_package_build`, `swift_package_test`, `swift_package_clean`) hiding compiler diagnostics when stderr was empty ([#255](https://github.com/getsentry/XcodeBuildMCP/pull/255) by [@doovers](https://github.com/doovers)).
- Fixed stderr warnings (e.g. "multiple matching destinations") hiding actual test failures by prioritizing xcresult output when available ([#254](https://github.com/getsentry/XcodeBuildMCP/pull/254) by [@czottmann](https://github.com/czottmann)).

Various other internal improvements to stability, performance, and code quality.

## [2.1.0]

### Added

- Added `xcodebuildmcp init` CLI command to install agent skills, replacing the standalone `install-skill.sh` script. Supports auto-detection of AI clients (Claude Code, Cursor, Codex), `--print` for unsupported clients, and `--uninstall` for removal. See [docs/SKILLS.md](docs/SKILLS.md#install).
- Added namespaced session defaults profiles, letting you save and switch between different project/scheme/simulator configurations without reconfiguring each time. See [docs/SESSION_DEFAULTS.md](docs/SESSION_DEFAULTS.md#namespaced-profiles).
- Added support for persisting custom environment variables in session defaults ([#235](https://github.com/getsentry/XcodeBuildMCP/pull/235) by [@kamal](https://github.com/kamal)). See [docs/SESSION_DEFAULTS.md](docs/SESSION_DEFAULTS.md#persisting-defaults).
- Added Kiro client setup instructions ([#222](https://github.com/getsentry/XcodeBuildMCP/pull/222) by [@manojmahapatra](https://github.com/manojmahapatra)).

### Added

- Added `get_coverage_report` tool to show per-target code coverage from xcresult bundles ([#227](https://github.com/getsentry/XcodeBuildMCP/issues/227))
- Added `get_file_coverage` tool to show function-level coverage and uncovered line ranges for specific files ([#227](https://github.com/getsentry/XcodeBuildMCP/issues/227))

### Changed

- Faster MCP startup when the Xcode IDE workflow is enabled — tools are available sooner after connecting ([#210](https://github.com/getsentry/XcodeBuildMCP/issues/210)). See [docs/XCODE_IDE_MCPBRIDGE.md](docs/XCODE_IDE_MCPBRIDGE.md).
- Agents now use the combined build-and-run tool for simulator run intents, avoiding a redundant separate build step.
- Improved next-step suggestions so agents receive more accurate follow-up actions after each tool call.
- Updated UI automation tap guidance to prefer label and ID targets, reducing agent errors.

### Fixed

- Fixed false positive error and warning detection when build output contained echoed source code ([#218](https://github.com/getsentry/XcodeBuildMCP/pull/218) by [@nebooz](https://github.com/nebooz)).
- Fixed outdated tool names and parameters in the CLI skill file ([#217](https://github.com/getsentry/XcodeBuildMCP/pull/217) by [@pocketpixels](https://github.com/pocketpixels)).
- Fixed Sentry telemetry scope to capture only internal runtime failures, removing unnecessary data collection ([#204](https://github.com/getsentry/XcodeBuildMCP/issues/204)).
- Fixed a shell injection vulnerability in the release workflow ([#229](https://github.com/getsentry/XcodeBuildMCP/pull/229)).
- Improved privacy redaction in the `doctor` command to better protect project names and paths in default output.

### Removed

- Removed `scripts/install-skill.sh` in favour of `xcodebuildmcp init`.

Various other internal improvements to stability, performance, and code quality.

## [2.0.7]

### Changed

- XcodeBuildMCP has moved to the [getsentry](https://github.com/getsentry) GitHub organization. Homebrew users should switch to the new tap: `brew untap cameroncooke/xcodebuildmcp && brew tap getsentry/xcodebuildmcp`. npm and npx users are unaffected.

## [2.0.5] - 2026-02-10

### Added

- Homebrew installation (`brew tap getsentry/xcodebuildmcp && brew install xcodebuildmcp`) — installs a self-contained binary with no Node.js dependency.

### Removed

- Smithery distribution channel.

## [2.0.0]

### New! CLI

XcodeBuildMCP now includes a first-class CLI for direct terminal usage, scripting, and CI workflows. All the same tools available via MCP are accessible from the command line.

```bash
npm install -g xcodebuildmcp@beta
xcodebuildmcp tools # List available tools
xcodebuildmcp simulator build-and-run --scheme MyApp --project-path ./MyApp.xcodeproj
```

Stateful operations (log capture, debugging, video recording) are backed by a per-workspace background process that starts automatically and shuts down after idle. See [docs/CLI.md](docs/CLI.md) for full documentation.

### New! Configuration File

Project-level configuration via `.xcodebuildmcp/config.yaml` replaces the need for environment variables. Set your project path, scheme, simulator, enabled workflows, debug settings, and more in one place. Environment variables still work but the config file takes precedence.

```yaml
schemaVersion: 1
enabledWorkflows:
  - simulator
  - ui-automation
  - debugging
sessionDefaults:
  scheme: MyApp
  projectPath: ./MyApp.xcodeproj
  simulatorName: iPhone 17
```

See [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for the full reference.

### New! Xcode IDE Integration

XcodeBuildMCP can now proxy tools from Xcode 26.3's built-in MCP bridge, giving your agent access to Xcode IDE capabilities like Preview rendering, the Issue Navigator, and documentation search. Enable the `xcode-ide` workflow to use this. Setup instructions for both Codex Agent and Claude Code Agent in Xcode are included. See [docs/XCODE_IDE_MCPBRIDGE.md](docs/XCODE_IDE_MCPBRIDGE.md) for details.

### Added

- **LLDB Debugging**: Attach a debugger to simulator apps, set breakpoints, inspect variables, view the call stack, and run LLDB commands — all through your agent. Supports both DAP and LLDB-CLI backends. See [docs/TOOLS.md](docs/TOOLS.md) for the debugging tools.
- **Session default persistence**: Session defaults can now be saved to the config file with `persist: true`, so your preferred project, scheme, and simulator are remembered across sessions.
- **Log subsystem filtering**: Filter simulator log capture by subsystem — choose `app` (default), `all`, `swiftui` (for `Self._printChanges()` output), or a custom list of subsystems.
- **Agent skills**: Optional skill files that prime your agent with usage instructions for the MCP server or CLI. Install via the provided shell script or manually. See [docs/SKILLS.md](docs/SKILLS.md).
- **MCP tool annotations**: All tools now include MCP-standard annotations (read-only vs. destructive, idempotent, etc.) for clients that support them.
- **Simulator name resolution**: Session defaults now accept a simulator name and automatically resolve it to a device ID.
- **Launch environment variables**: Launch tools now accept an optional `env` object so you can pass runtime environment variables when starting apps on simulator or device.

### Changed

- Simulator tools are now the default workflow. Previously all workflows loaded by default, increasing context usage.
- Bundled AXe updated to 1.3.0.
- Landscape screenshots now orient correctly.
- Simulator platform detection and default refresh behavior are more reliable, so simulator commands stay aligned with your current defaults as they change.

### Fixed

- Fixed incremental builds corrupting arguments when strings contained substrings matching build flags.
- Fixed build path handling so relative project, workspace, and derived data paths resolve correctly even when commands run from different working directories.
- Fixed working-directory leakage in incremental build setup that could affect concurrent requests.
- Fixed simulator screenshot matching for similarly named devices (for example, `iPhone 15` and `iPhone 15 Pro`).

## [1.15.1] - 2025-12-20

### Changed
- Add suppressWarnings to suppress warnings from the build tools.
- Update AXe to 1.2.0
- Update tap tool to accept label/id as tap targets.

## [1.15.0] - 2025-12-15

### Added
- Add support for in-memory session defaults.

### Changed
- Various bug fixes and improvements

## [1.14.0] - 2025-09-22
- Add video capture tool for simulators

## [1.13.1] - 2025-09-21
- Add simulator erase content and settings tool

## [1.12.3] - 2025-08-22
- Pass environment variables to test runs on device, simulator, and macOS via an optional testRunnerEnv input (auto-prefixed as TEST_RUNNER_).

## [1.12.2] - 2025-08-21
### Fixed
- **Clean tool**: Fixed issue where clean would fail for simulators

## [1.12.1] - 2025-08-18
### Improved
- **Sentry Logging**: No longer logs domain errors to Sentry, now only logs MCP server errors.

## [1.12.0] - 2025-08-17
### Added
- Unify project/workspace and sim id/name tools into a single tools reducing the number of tools from 81 to 59, this helps reduce the client agent's context window size by 27%!
- **Selective Workflow Loading**: New `XCODEBUILDMCP_ENABLED_WORKFLOWS` environment variable allows loading only specific workflow groups in static mode, reducing context window usage for clients that don't support MCP sampling (Thanks to @codeman9 for their first contribution!)
- Rename `diagnosics` tool and cli to `doctor`
- Add Sentry instrumentation to track MCP usage statistics (can be disabled by setting `XCODEBUILDMCP_SENTRY_DISABLED=true`)
- Add support for MCP setLevel handler to allow clients to control the log level of the MCP server

## [v1.11.2] - 2025-08-08
- Fixed "registerTools is not a function" errors during package upgrades

## [v1.11.1] - 2025-08-07
- Improved tool discovery to be more accurate and context-aware

## [v1.11.0] - 2025-08-07
- Major refactor/rewrite to improve code quality and maintainability in preparation for future development
- Added support for dynamic tools (VSCode only for now)
- Added support for MCP Resources (devices, simulators, environment info)
- Workaround for https://github.com/cameroncooke/XcodeBuildMCP/issues/66 and https://github.com/anthropics/claude-code/issues/1804 issues where Claude Code would only see the first text content from tool responses

## [v1.10.0] - 2025-06-10
### Added
- **App Lifecycle Management**: New tools for stopping running applications
  - `stop_app_device`: Stop apps running on physical Apple devices (iPhone, iPad, Apple Watch, Apple TV, Apple Vision Pro)
  - `stop_app_sim`: Stop apps running on iOS/watchOS/tvOS/visionOS simulators
  - `stop_mac_app`: Stop macOS applications by name or process ID
- **Enhanced Launch Tools**: Device launch tools now return process IDs for better app management
- **Bundled AXe Distribution**: AXe binary and frameworks now included in npm package for zero-setup UI automation

### Fixed
- **WiFi Device Detection**: Improved detection of Apple devices connected over WiFi networks
- **Device Connectivity**: Better handling of paired devices with different connection states

### Improved
- **Simplified Installation**: No separate AXe installation required - everything works out of the box

## [v1.9.0] - 2025-06-09
- Added support for hardware devices over USB and Wi-Fi
- New tools for Apple device deployment:
  - `install_app_device`
  - `launch_app_device`
- Updated all simulator and device tools to be platform-agnostic, supporting all Apple platforms (iOS, iPadOS, watchOS, tvOS, visionOS)
- Changed `get_ios_bundle_id` to `get_app_bundle_id` with support for all Apple platforms

## [v1.8.0] - 2025-06-07
- Added support for running tests on macOS, iOS simulators, and iOS devices
- New tools for testing:
  - `test_macos_workspace`
  - `test_macos_project`
  - `test_ios_simulator_name_workspace`
  - `test_ios_simulator_name_project`
  - `test_ios_simulator_id_workspace`
  - `test_ios_simulator_id_project`
  - `test_ios_device_workspace`
  - `test_ios_device_project`

## [v1.7.0] - 2025-06-04
- Added support for Swift Package Manager (SPM)
- New tools for Swift Package Manager:
  - `swift_package_build`
  - `swift_package_clean`
  - `swift_package_test`
  - `swift_package_run`
  - `swift_package_list`
  - `swift_package_stop`

## [v1.6.1] - 2025-06-03
- Improve UI tool hints

## [v1.6.0] - 2025-06-03
- Moved project templates to external GitHub repositories for independent versioning
- Added support for downloading templates from GitHub releases
- Added local template override support via environment variables
- Added `scaffold_ios_project` and `scaffold_macos_project` tools for creating new projects
- Centralized template version management in package.json for easier updates

## [v1.5.0] - 2025-06-01
- UI automation is no longer in beta!
- Added support for AXe UI automation
- Revised default installation instructions to prefer npx instead of mise

## [v1.4.0] - 2025-05-11
- Merge the incremental build beta branch into main
- Add preferXcodebuild argument to build tools with improved error handling allowing the agent to force the use of xcodebuild over xcodemake for complex projects. It also adds a hint when incremental builds fail due to non-compiler errors, enabling the agent to automatically switch to xcodebuild for a recovery build attempt, improving reliability.

## [v1.3.7] - 2025-05-08
- Fix Claude Code issue due to long tool names

## [v1.4.0-beta.3] - 2025-05-07
- Fixed issue where incremental builds would only work for "Debug" build configurations
-
## [v1.4.0-beta.2] - 2025-05-07
- Same as beta 1 but has the latest features from the main release channel

## [v1.4.0-beta.1] - 2025-05-05
- Added experimental support for incremental builds (requires opt-in)

## [v1.3.6] - 2025-05-07
- Added support for enabling/disabling tools via environment variables

## [v1.3.5] - 2025-05-05
- Fixed the text input UI automation tool
- Improve the UI automation tool hints to reduce agent tool call errors
- Improved the project discovery tool to reduce agent tool call errors
- Added instructions for installing idb client manually

## [v1.3.4] - 2025-05-04
- Improved Sentry integration

## [v1.3.3] - 2025-05-04
- Added Sentry opt-out functionality

## [v1.3.1] - 2025-05-03
- Added Sentry integration for error reporting

## [v1.3.0] - 2025-04-28

- Added support for interacting with the simulator (tap, swipe etc.)
- Added support for capturing simulator screenshots

Please note that the UI automation features are an early preview and currently in beta your mileage may vary.

## [v1.2.4] - 2025-04-24
- Improved xcodebuild reporting of warnings and errors in tool response
- Refactor build utils and remove redundant code

## [v1.2.3] - 2025-04-23
- Added support for skipping macro validation

## [v1.2.2] - 2025-04-23
- Improved log readability with version information for easier debugging
- Enhanced overall stability and performance

## [v1.2.1] - 2025-04-23
- General stability improvements and bug fixes

## [v1.2.0] - 2025-04-14
### Added
- New simulator log capture feature: Easily view and debug your app's logs while running in the simulator
- Automatic project discovery: XcodeBuildMCP now finds your Xcode projects and workspaces automatically
- Support for both Intel and Apple Silicon Macs in macOS builds

### Improved
- Cleaner, more readable build output with better error messages
- Faster build times and more reliable build process
- Enhanced documentation with clearer usage examples

## [v1.1.0] - 2025-04-05
### Added
- Real-time build progress reporting
- Separate tools for iOS and macOS builds
- Better workspace and project support

### Improved
- Simplified build commands with better parameter handling
- More reliable clean operations for both projects and workspaces

## [v1.0.2] - 2025-04-02
- Improved documentation with better examples and clearer instructions
- Easier version tracking for compatibility checks

## [v1.0.1] - 2025-04-02
- Initial release of XcodeBuildMCP
- Basic support for building iOS and macOS applications
