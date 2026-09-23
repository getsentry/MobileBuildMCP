---
name: mobilebuildmcp-docs-command-review
description: Use when reviewing MobileBuildMCP changelog CLI command references for invalid current guidance while allowing historical migration examples.
allowed-tools: Read Grep Glob
---

# MobileBuildMCP Docs Command Review

Review changed changelog entries for CLI command references that would mislead users or agents.

## What to inspect

- `CHANGELOG.md`
- `manifests/tools/*.yaml` and `manifests/workflows/*.yaml` when you need to verify current CLI workflow/tool names
- `src/cli/**` only when command wiring is unclear from manifests

## Issue criteria

Report a finding only when a command reference is presented as current guidance and appears invalid for the current CLI surface.

### High severity

- A changelog bullet, example, or migration instruction tells users to run a removed or invalid `mobilebuildmcp` command as the current path.
- A Breaking change mentions a removed command but does not give a valid replacement.
- A command reference uses the wrong workflow/tool pairing in a way a user or agent would likely copy.

### Medium severity

- A command reference is ambiguous enough that users may not know whether it is historical or current.
- A migration example gives the right replacement but does not clearly label the old command as "Before", "old", "removed", or equivalent.

## Explicitly allowed

Do not report removed commands when they are clearly historical context, especially in:

- Breaking-change migration sections
- "Before" examples paired with valid "After" examples
- Already-released changelog sections describing past behavior

Example that should not be reported:

```markdown
Before:
mobilebuildmcp logging start-sim-log-cap

After:
mobilebuildmcp simulator build-and-run
```

## Output

For each finding, include:

- Severity
- File and line
- The command reference
- Why it reads as current guidance
- Suggested replacement wording or command

If all command references are historical or valid, report no findings.
