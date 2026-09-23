---
name: mobilebuildmcp-test-boundary-review
description: Use when reviewing MobileBuildMCP tests for correct unit, snapshot, schema, smoke, and external process boundaries.
---

# MobileBuildMCP Test Boundary Review

Review guardrails for test isolation, scope, and contract validation.

## Review scope

- Review-only by default.
- Do not edit product code unless the user explicitly requests implementation changes.

## Files to inspect

- `src/**/__tests__/**`
- `src/test-utils/**`
- `src/snapshot-tests/**`
- `scripts/**/__tests__/**`
- `package.json`
- `xcodebuildmcp.com/app/docs/_content/testing.mdx`
- `xcodebuildmcp.com/app/docs/_content/contributing.mdx`

## Guardrails

- Unit tests inject command/filesystem/external dependencies.
- Unit tests do not call real `xcodebuild`, `xcrun`, AXe, devices, or simulators.
- Prefer testing logic/executor functions over handler wrappers unless testing runtime integration.
- Use existing mock executor helpers.
- Treat snapshot updates as contract changes requiring review.
- Do not add fake e2e/snapshot state to force test success.
- Avoid unsafe TypeScript suppressions.

## Validation

- Run targeted Vitest command for touched tests.
- `npm test`
- `npm run typecheck`
- If fixtures/schemas changed: `npm run test:snapshots` and `npm run test:schema-fixtures`
- `npx skill-check .agents/skills/mobilebuildmcp-test-boundary-review`
