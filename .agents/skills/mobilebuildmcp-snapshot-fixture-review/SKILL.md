---
name: mobilebuildmcp-snapshot-fixture-review
description: Use when reviewing MobileBuildMCP snapshot fixture changes for MCP, CLI, and JSON output contract integrity.
---

# MobileBuildMCP Snapshot Fixture Review

Review guardrails for fixture and snapshot contract integrity.

## Review scope

- Review-only by default.
- Do not edit product code unless the user explicitly requests implementation changes.

## Files to inspect

- `src/snapshot-tests/__fixtures__/**`
- `src/snapshot-tests/contracts.ts`
- `src/snapshot-tests/fixture-io.ts`
- `src/snapshot-tests/__tests__/fixture-io.test.ts`
- `src/snapshot-tests/__tests__/json-normalize.test.ts`
- `src/snapshot-tests/__tests__/json-fixture-schema.test.ts`
- `xcodebuildmcp.com/app/docs/_content/testing.mdx`

## Guardrails

- Fixture updates map to intentional behavior changes.
- Do not update fixtures only to make tests pass.
- MCP, CLI, and JSON fixture updates stay aligned.
- JSON fixtures preserve stable structured output envelopes.
- Volatile values are normalized in code, not patched ad hoc in fixtures.
- Missing fixtures are generated through the snapshot update flow.
- Verify project-defined normalization sentinels in normalization code and tests before reporting
  them as implausible fixture values. In particular, `99999` is an intentional sentinel for
  volatile UI capture counts.
- Group every occurrence of the same root cause into one finding and list the affected fixtures.
  Do not emit separate findings for equivalent CLI, MCP, text, or JSON drift.
- Do not repeat a finding that is already resolved by the current diff.

## Review limits

- Review the changed fixtures and the directly relevant normalization or contract code only.
- Do not run snapshot or smoke suites as part of an automated PR review.
- Prefer one high-confidence cross-fixture finding over multiple speculative discrepancies.
