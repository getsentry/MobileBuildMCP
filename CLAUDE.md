# Development Rules

## Code Quality
- No `any` types unless absolutely necessary
- Check node_modules for external API type definitions instead of guessing
- **NEVER use inline imports** - no `await import("./foo.js")`, no `import("pkg").Type` in type positions, no dynamic imports for types. Always use standard top-level imports.
- NEVER remove or downgrade code to fix type errors from outdated dependencies; upgrade the dependency instead
- Always ask before removing functionality or code that appears to be intentional
- Do not add fallback behavior by default. If required context, configuration, runtime state, or dependencies are missing, fail loudly and fix the caller/setup instead of silently switching to an alternate path. Add a fallback only when explicitly requested or when it is a documented product requirement.
- Review the complete merge-base diff and trace changed or reused helper contracts, including error and sentinel returns, through callers, consumers, tests, and operational configuration.
- Verify standard quality commands include every changed path and exercise exact entry points and argument variants; validate explicitly when they do not.
- For asynchronous, workflow, or process-boundary changes, enumerate lifecycle states, retries, supersession, and race transitions; test terminal outcomes and missing or optional metadata.

## Test Conventions
- Snapshot tests (`*.snapshot.test.ts`) must only assert generated tool output against fixtures. Move helper, parser, schema, setup, or behavior assertions to non-snapshot unit/integration tests.

## Commands
- NEVER commit unless user asks

## GitHub
When reading issues:
- Always read all comments on the issue
-
## Tools
- GitHub CLI for issues/PRs
- MCP `readOnlyHint` describes whether a tool mutates host/project state such as files, build artifacts, configuration, or external services. Simulator HID/UI actions that only tap, type, press, or gesture inside the simulator may remain `readOnlyHint: true`; do not flip them to `false` merely because app UI state changes.
- CLI design note: do not rely on CLI session-default writes. CLI is intentionally deterministic for CI/scripting and should use explicit command arguments as the primary input surface.
- When working on skill sources in `skills/`, use the `skill-creator` skill workflow.
- After modifying any skill source, run `npx skill-check <skill-directory>` and address all errors/warnings before handoff.
- Before handoff, run the matching manual Warden review for high-risk changes: runtime/CLI/daemon boundaries → `mobilebuildmcp-runtime-boundary-review`; test infrastructure or harnesses → `mobilebuildmcp-test-boundary-review`; tool manifests, schemas, or contracts → `mobilebuildmcp-tool-contract-review`. Invoke only applicable skills with `warden --skill <name>`.
-
## Multi-process filesystem state
- MobileBuildMCP explicitly supports multiple concurrent MCP server, daemon, CLI, test, and helper processes for the same or different workspaces.
- Shared filesystem state under `~/Library/Developer/MobileBuildMCP` must be multi-process safe.
- Use workspace-key scoped directories for workspace-owned state.
- Do not store runtime state under `~/.mobilebuildmcp`; `.mobilebuildmcp/config.yaml` is only project configuration.
- Use shared lock and atomic-write helpers for mutable shared files.
- Prefer one-record-per-file registries over shared aggregate files.
- Cleanup must verify ownership before deleting shared artifacts.
- User-facing artifact/log paths in final text or structured output must use `displayPath()` from `src/utils/build-preflight.ts`, so paths are cwd-relative when possible or `~/...` instead of absolute home paths. Keep stored files at their real absolute paths; only normalize response/display values.

## Style
- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- No fluff or cheerful filler text
- Technical prose only, be kind but direct (e.g., "Thanks @user" not "Thanks so much @user!")

## Docs
- Do not commit transient investigation notes, prompt exports, or scratch analysis docs after the work is complete.
- If an investigation leaves unresolved follow-up work, move it to a GitHub issue instead of preserving the transient doc in the branch.
- Structured output JSON schemas are auto-published to the website/public schema mirror when merged; do not manually update public schema copies unless explicitly asked.

### Changelog
Location: `CHANGELOG.md`

#### Format
Use these sections under `## [Unreleased]`:
- `### Added` - New features
- `### Changed` - Changes to existing functionality
- `### Fixed` - Bug fixes
- `### Removed` - Removed features
-
#### Rules
- Before adding entries, read the full `[Unreleased]` section to see which subsections already exist
- New entries ALWAYS go under `## [Unreleased]` section
- Append to existing subsections (e.g., `### Fixed`), do not create duplicates
- NEVER modify already-released version sections (e.g., `## [0.12.2]`)
- Each version section is immutable once released
- NEVER update snapshot fixtures unless asked to do so, these are integration tests, on failure assume code is wrong before questioning the fixture
-
#### Attribution
- **Internal changes (from issues)**: `Fixed foo bar ([#123](https://github.com/getsentry/MobileBuildMCP/issues/123))`
- **External contributions**: `Added feature X ([#456](https://github.com/getsentry/MobileBuildMCP/pull/456) by [@username](https://github.com/username))`


## Rendering and Streaming Contract
- Streaming fragments are transient live-progress output only. They may be displayed while a tool is running, but MUST NOT provide final settled MCP/JSON/CLI text.
- Final settled output MUST render from the final structured/domain result and next-step metadata. If final output needs data, add it to the final result type instead of reading it from fragments.
- Streaming-capable renderers may observe fragment callbacks only for live progress. Fragment handling must not affect final structured output or final settled text.

## Error Handling
- Structured errors (domain results with `didError`) are for domain errors only: failures in the user's build/test/device/simulator workflow (compile errors, test failures, missing destinations, etc.).
- System errors with the MCP server or CLI itself (invalid internal state, unresolvable configuration, infrastructure failures) must NOT be wrapped in structured domain results — let them surface as runtime tool errors so they are clearly distinguishable from workflow outcomes.

## Test Execution Rules
- **NEVER run the snapshot or smoke test suites without explicit user permission.** They are expensive (~7 min baseline, spawn real `xcodebuild`/`simctl`/`devicectl` processes and can wedge). This covers `npm run test:snapshot`, `npm run test:smoke`, and any direct `vitest run --config vitest.snapshot.config.ts` / `vitest.smoke.config.ts` invocation. Ask first, then run only if the user agrees.
- The default unit suite (`npm test` / `vitest run`), `npm run typecheck`, `npm run lint`, and `npm run build` are cheap and may be run freely without asking.
- When running long test suites (snapshot tests, smoke tests), ALWAYS write full output to a log file and read it afterwards. NEVER pipe through `tail` or `grep` directly — that loses output you may need to debug failures.
- Pattern: `DEVICE_ID=... npm run test:snapshot 2>&1 | tee /tmp/snapshot-results.txt` then read `/tmp/snapshot-results.txt` with the native read tool.
- If you need a summary, read the log file and grep/filter it — the full output is always preserved.
- Snapshot test command: `DEVICE_ID=<YOUR_DEVICE_ID> npm run test:snapshot`
- **Snapshot suite expected duration**: ~7 min baseline (measured at 423s). Anything longer than ~10 min should be treated as a likely hang, not a slow run.
  - Do NOT just kill the run — first inspect the process tree (`ps -ef | grep -E "vitest|xcodebuild|simctl|devicectl"`) to identify what's stuck.
  - Common hang causes: locked physical device, stale simulator state, `devicectl diagnose` waiting for password, orphaned daemon process.
  - Capture what you find before killing, so the root cause can be fixed rather than papered over.
- When asked to review changes or test failures, focus on regressions: behavior changes caused by the branch. Do not treat known/acceptable test flakes, environment setup issues, or nondeterministic tool output churn as regressions unless explicitly asked to investigate them.

## **CRITICAL** Tool Usage Rules **CRITICAL**
- NEVER use sed/cat to read a file or a range of a file. Always use the native read tool.
- You MUST read every file you modify in full before editing.
