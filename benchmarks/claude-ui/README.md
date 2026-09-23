# Claude UI benchmark harness

Local/manual harness for running Claude Code against configurable tool surfaces and auditing UI automation behavior. The default suite configuration targets the development MobileBuildMCP MCP server.

The harness:

- reads a suite YAML file from `benchmarks/claude-ui/suites/`
- reads the referenced prompt Markdown file from disk and feeds it to `claude -p`
- creates, boots, waits for, and opens a fresh temporary simulator before Claude launches for each suite run by default
- writes an isolated per-run MCP workspace config with the suite defaults and temporary `simulatorId` when MCP is enabled
- generates a Claude MCP config pointing at `node build/cli.js mcp` with `MOBILEBUILDMCP_CWD` set to that isolated workspace when MCP is enabled
- optionally preflights configured first-run prompts before Claude launches, outside the measured run
- deletes the temporary simulator at the end of the suite, best effort, using only the ID created by the harness
- writes artifacts under `out.nosync/claude-benchmarks/<suite>/<timestamp>/`
- runs the bundled `parse_claude_conversation.py` parser against Claude's stream JSONL
- audits tool counts, configured tracked tool calls, UI automation calls, wall clock, stumbles, and observed tool sequence differences
- prints a structured per-suite report and (for `--all`) an aggregate summary
- optionally prints machine-readable JSON with `--json`
- can render an existing `result.json` or artifact directory with `--from-result` without rerunning Claude

This is intentionally not part of the normal test suite because it launches Claude and drives local simulators/apps.

## Commands

Build first, then run a suite:

```bash
npm run build
npx tsx benchmarks/claude-ui/run.ts --suite weather
```

Shortcut:

```bash
npm run bench:claude-ui -- --suite weather
```

CLI-backed suites should use benchmark-local skills rather than global Claude/agent skills. Keep private/local CLI suites and assets under `benchmarks/claude-ui/local/`; that directory is ignored by git. For local CLI skills, point the suite at the local directory with `claude.pluginDirs`.

Do not rely on skills installed in `~/.claude`, `~/.agents`, or the repository root; the benchmark run can isolate Claude's working directory so only the suite's configured tool skill is visible.

Run every committed suite YAML plus any private local suites under `benchmarks/claude-ui/local/suites/`:

```bash
npm run bench:claude-ui -- --all
```

Print machine-readable output from a new run:

```bash
npm run bench:claude-ui -- --suite reminders --json
```

Request an exact Claude model for controlled comparisons:

```bash
npm run bench:claude-ui -- --suite weather --model claude-sonnet-4-7
npm run bench:claude-ui:mobilebuildmcp -- --model claude-sonnet-4-7
```

The `--model` CLI option overrides `claude.model` from the suite YAML for that run.

Render an existing result without rerunning Claude:

```bash
npm run bench:claude-ui -- --from-result out.nosync/claude-benchmarks/reminders/20260522T130926Z
npm run bench:claude-ui -- --from-result out.nosync/claude-benchmarks/reminders/20260522T130926Z/result.json --json
```

New runs use the bundled parser at `benchmarks/claude-ui/parse_claude_conversation.py`. Pass `--parser /path/to/parse_claude_conversation.py` or set `CLAUDE_UI_BENCHMARK_PARSER` only when testing a different parser. `--from-result` does not need a parser because it only re-renders existing artifacts.

## Suite YAML shape

```yaml
name: weather
prompt: ../prompts/weather.md
workingDirectory: example_projects/Weather
sessionDefaults:
  projectPath: Weather.xcodeproj
  scheme: Weather
  simulatorName: iPhone 17 Pro Max
temporarySimulator: true
firstRunPromptDismissals:
  labels:
    - Continue
    - Not Now
  timeoutSeconds: 12
baseline:
  totalToolCalls: 19
  trackedToolCalls: 18
  mcpToolCalls: 18
  uiAutomationCalls: 16
  wallClockSeconds: 125
  tools:
    snapshot_ui: 1
    tap: 9
baselineToolSequence:
  - session_show_defaults
  - build_run_sim
  - snapshot_ui
failurePatterns:
  - STALE_ELEMENT_REF
  - SNAPSHOT_MISSING
  - WAIT_TIMEOUT
ignoredFailurePatterns:
  - element_disabled
```

Baselines are recorded comparison data, not completion gates. Metric rows show the current observed value, the recorded baseline value, and the delta. Use baselines to compare against the best or representative successful run recorded so far, not as made-up correctness thresholds.

When recording new baselines, only write baseline values from clean successful runs. A clean run means Claude completed the task, Claude exited with status `0`, the parser exited with status `0`, there were no parse errors, and there were no unexpected terminal/process/task failures. Old-baseline metric drift does not disqualify a run.

Retry a suite up to three total attempts when trying to establish a baseline. If no attempt produces a clean successful run, remove that suite's `baseline:` block rather than leaving stale recorded data behind. Report `no clean baseline after 3 attempts / no baseline recorded` in your notes instead.

Tool sequence differences are reported as observed comparison data because real Claude runs can choose equally valid UI paths. Sequence differences do not affect task/process completion status.

`sessionDefaults` are written to a harness-owned config at `<run>/mcp-workspace/.mobilebuildmcp/config.yaml`. The generated Claude MCP config sets `MOBILEBUILDMCP_CWD` to `<run>/mcp-workspace`, so the dev MCP server reads only the benchmark config instead of any repo or example-project `.mobilebuildmcp/config.yaml`. Unknown keys fail fast. Relative path defaults such as `projectPath`, `workspacePath`, and `derivedDataPath` are resolved against the suite `workingDirectory` before being written because the MCP server cwd is the isolated workspace.

## Configuring Claude and tracked tools

Suites can override the Claude invocation without changing harness code. Omit this block for the default MobileBuildMCP MCP behavior.

```yaml
claude:
  model: claude-sonnet-4-7
  useMcpServer: false
  tools:
    - Bash
  allowedTools:
    - Bash(vendorcli *)
    - Bash(xcodebuild *)
  appendSystemPrompt: |
    Use the simulator from `$CLAUDE_UI_BENCHMARK_SIMULATOR_ID`.
    You may use the configured local CLI and xcodebuild directly.
  pluginDirs:
    - benchmarks/claude-ui/local/skills/vendor-cli
  isolatedWorkingDirectory: true
  extraArgs:
    - --setting-sources
    - project,local
toolAnalysis:
  matchers:
    - kind: bashCommand
      commandPrefix: vendorcli ui screen
      shortName: vendorcli.screen
      uiAutomation: true
    - kind: bashCommand
      commandPrefix: vendorcli ui tap
      shortName: vendorcli.tap
      uiAutomation: true
    - kind: bashCommand
      commandPrefix: xcodebuild
      shortName: xcodebuild
```

`claude.model` is the canonical suite-level model request. Do not put `--model` or `--model=<value>` in `claude.extraArgs`; the config parser rejects those forms so suite config and CLI overrides cannot disagree. Pass `--model <model>` to override the suite model for controlled comparison runs.

`claude.useMcpServer: false` writes an empty per-run MCP config and passes it with `--strict-mcp-config`, so project/user MCP servers cannot leak into CLI-only benchmark runs. The harness still prepares the simulator lifecycle and exports `CLAUDE_UI_BENCHMARK_SIMULATOR_ID`, `CLAUDE_UI_BENCHMARK_RUN_DIR`, and `CLAUDE_UI_BENCHMARK_WORKING_DIRECTORY` to Claude. `appendSystemPrompt` also supports `{simulatorId}`, `{runDirectory}`, and `{workingDirectory}` placeholders.

`claude.pluginDirs` is passed to Claude as one `--plugin-dir` argument per configured path, resolved from the repository root. Use this for suite-specific local/private CLI skills. `claude.isolatedWorkingDirectory: true` runs Claude from the per-run artifact directory instead of the suite working directory, which prevents repository/project skills from being discovered implicitly. When using an isolated working directory, include absolute `{workingDirectory}` paths in prompts for build commands or project files.

`toolAnalysis.matchers` defines what the analyzer treats as benchmark-relevant. `namePrefix` matchers track MCP-style tool names and can strip the prefix or final `__` segment. `bashCommand` matchers track Claude `Bash` tool calls whose `command` starts with the configured prefix. `uiAutomation: true` marks a tracked command as UI automation; xcodebuild commands can be tracked without counting as UI automation.

`ignoredFailurePatterns` removes configured, known non-terminal tool-result errors from observed stumbles and from `failurePatterns` matches. Keep these patterns narrow and suite-specific. This is useful for CLI tools that return nonzero for exploratory probes while the agent can recover and still complete the user task.

Use `preflightCommands` when a CLI tool needs host setup outside Claude's measured run, such as starting its companion app or validating local health:

```yaml
preflightCommands:
  - open -a LocalBenchTool
  - sleep 3
  - vendorcli status
  - vendorcli ui inspect --udid "$CLAUDE_UI_BENCHMARK_SIMULATOR_ID"
  - vendorcli ui home --udid "$CLAUDE_UI_BENCHMARK_SIMULATOR_ID"
```

## Temporary simulator lifecycle

By default, each suite creates a fresh simulator before Claude launches. The harness uses `sessionDefaults.simulatorName` as the `simctl create` device type name, captures the returned simulator ID, boots that simulator, waits for `simctl bootstatus <id> -b`, opens Simulator.app to that device, applies a short UI-readiness delay, and writes the simulator ID as `sessionDefaults.simulatorId` in the isolated MCP workspace config. This makes Claude and the dev MCP server target a visible, booted, isolated simulator instead of reusing a previous run's state or spending benchmark calls on simulator boot/open setup.

Simulator setup is deliberately outside the benchmark measurement boundary. The measured `wallClockSeconds` starts when the harness spawns Claude and stops when Claude exits. Tool-call counts are parsed only from Claude's JSONL transcript. The result JSON still records temporary simulator `setupDurationSeconds` under `run.temporarySimulator` so setup cost is visible without being compared against Claude task-efficiency baselines.

Config contract:

- Omit `temporarySimulator` for the default behavior: create and later delete a temporary simulator.
- Set `temporarySimulator: false` with `sessionDefaults.simulatorName` to resolve, boot, open, and export an existing simulator by name without deleting it.
- Set `sessionDefaults.simulatorId` to use an existing simulator. In this case the harness does not create or delete a simulator.
- Do not set both `temporarySimulator: true` and `sessionDefaults.simulatorId`; the harness fails fast because deleting a user-provided simulator would be unsafe.

Temporary simulator setup is required when enabled. If creation, boot, bootstatus, or Simulator.app opening fails, the suite fails loudly before Claude starts. Deletion is best effort in a `finally` block: failures are logged but do not mask the benchmark result or original error.

`firstRunPromptDismissals` is an optional suite-level preflight for fresh simulator noise such as Apple first-run sheets. When configured, the harness launches `sessionDefaults.bundleId` before Claude starts, retries through transient UI-inspection failures, looks for any listed button labels, taps matching labels with AXe, then terminates the app. If the prompt state cannot be inspected or dismissed before `timeoutSeconds`, the suite fails before Claude starts. These preflight interactions are logged in `simulator-lifecycle.log`, but they are outside Claude's wall-clock measurement and do not appear in tool-call counts. Keep the labels generic and non-destructive, for example `Continue`, `Not Now`, or `OK`; do not configure sign-in, sync enablement, Settings, destructive, or data-deletion actions.

Lifecycle details are written to `simulator-lifecycle.log`, including the `create`, `boot`, `bootstatus`, `open`, readiness delay, optional first-run prompt preflight, and deletion steps. `claude-command.log` also records the simulator ID used for the run. The terminal report shows the temporary simulator ID plus setup duration as `setup ... before Claude` when a temporary simulator is used.

## Terminal report

Each suite renders as a structured report with a task-completion banner, aligned metric and tool tables, a stumbles section, and observed sequence differences. Baseline metric and sequence differences are observational. When run with `--all`, an aggregate summary follows the per-suite reports.

### Single suite

```text
────────────────────────────────────────────────────────────────────────
COMPLETED  weather                                             1m 38.6s
  suite     benchmarks/claude-ui/suites/weather.yml
  artifacts out.nosync/claude-benchmarks/weather/20260522T214044Z
  claude   model requested=claude-sonnet-4-7 observed=claude-sonnet-4-7 version=1.2.3
  exit      claude=0 parser=0

Metrics
  METRIC             ACTUAL  BASELINE   DELTA
  totalToolCalls         13        19      −6
  mcpToolCalls           12        18      −6
  uiAutomationCalls      10        16      −6
  wallClockSeconds    98.62    125.00  −26.38

Tool calls (baseline-observed)
  TOOL                   ACTUAL  BASELINE  DELTA
  session_show_defaults       1         1      0
  build_run_sim               1         1      0
  snapshot_ui                 1         1      0
  tap                         6         9     −3
  batch                       1         1      0

OBSERVED  stumbles: 0
```

### Sequence differences

When the tool sequence differs from the recorded sequence, the report includes unified-diff style hunks with baseline/actual index columns:

```text
OBSERVED  tool sequence: 4 missing from baseline, 0 additional
  @@ baseline[8..15] actual[8..11] @@
       8    8    tap
       9    9    tap
      10       − tap
       11   10    swipe
       12   11    tap
       13       − swipe
       14       − tap
       15       − tap
```

`−` lines are baseline calls Claude skipped; `+` lines are calls Claude made beyond the baseline sequence. Dim lines are surrounding context.

### Stumbles and inspect hints

When `stumbles` is non-zero the report lists the first few tool errors and pattern matches, and surfaces an `Inspect` block with the relevant artifact paths:

```text
INCOMPLETE  stumbles: 1
  • tool errors: 1
      boot_sim @ line 9: Boot failed: device not found

Inspect
  result.json   out.nosync/claude-benchmarks/reminders/20260522T213905Z/result.json
  transcript    out.nosync/claude-benchmarks/reminders/20260522T213905Z/claude.jsonl
  stderr        out.nosync/claude-benchmarks/reminders/20260522T213905Z/claude.stderr
  run dir       out.nosync/claude-benchmarks/reminders/20260522T213905Z
```

### Aggregate summary

After `--all` (or multi-result `--from-result`) the harness appends:

```text
════════════════════════════════════════════════════════════════════════
  Claude UI Benchmarks · Summary
════════════════════════════════════════════════════════════════════════
  Suites:    3 total · 2 completed · 1 incomplete
  Duration:  total 4m 49.8s · slowest reminders (1m 39.8s)
  Artifacts: out.nosync/claude-benchmarks/

  ✓ COMPLETED  weather    1m 38.6s  sequence delta: 4m/0a
  ! INCOMPLETE  reminders  1m 39.8s  1 stumble · sequence delta: 7m/4a
  ✓ COMPLETED  contacts   1m 31.4s  sequence delta: 2m/2a
════════════════════════════════════════════════════════════════════════
```

`Nm/Ka` denotes "N missing / K additional" calls vs. `baselineToolSequence`.

The renderer auto-detects TTY and adds ANSI color when stdout is a terminal and `NO_COLOR` is unset. Plain-text output (e.g. when piping to a file or under `NO_COLOR=1`) carries the same information without color codes.

`--json` output is unchanged by this renderer: the JSON payload remains a single `BenchmarkResult` for `--suite` / single-result `--from-result`, and an array for `--all` / multi-result `--from-result`.

## Artifacts

Each run writes:

- `prompt.md` — exact suite prompt fed to Claude
- `mcp-config.json` — generated Claude MCP config
- `mcp-workspace/.mobilebuildmcp/config.yaml` — isolated MCP server config with effective suite defaults
- `claude.jsonl` — Claude stream JSON output
- `claude.stderr` — Claude stderr
- `claude-command.log` — command, cwd, simulator ID, requested/observed model, `claude --version`, exit status, wall clock
- `simulator-lifecycle.log` — temporary simulator create, boot, bootstatus, open, readiness, deletion commands, and simulator ID
- `parsed/` — files written by `parse_claude_conversation.py`
- `parse.log` / `parse.log.stderr` — parser output
- `result.json` — full benchmark result, including requested model, observed model when Claude reports it, and `claude --version` output under `run.claude`
