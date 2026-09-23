---
name: mobilebuildmcp-structured-output-review
description: Use when reviewing MobileBuildMCP structured output schema changes, schema versioning, manifest outputSchema metadata, and JSON fixture compatibility.
---

# MobileBuildMCP Structured Output Review

Review guardrails for structured output schema correctness and compatibility.

## Review scope

- Review-only by default.
- Do not edit product code unless the user explicitly requests implementation changes.

## Files to inspect

- `schemas/structured-output/**`
- `src/core/structured-output-schema.ts`
- `src/core/__tests__/structured-output-schema.test.ts`
- `src/snapshot-tests/__fixtures__/json/**`
- `src/snapshot-tests/__tests__/json-fixture-schema.test.ts`
- `xcodebuildmcp.com/app/docs/_content/schema-versioning.mdx`
- `xcodebuildmcp.com/app/docs/_content/output-formats.mdx`

## Guardrails

- `schema` uses `mobilebuildmcp.output.<name>` format.
- `schemaVersion` uses integer strings only.
- Breaking schema changes create a new versioned schema file.
- Published schema versions are not removed or mutated incompatibly.
- Manifest `outputSchema` matches emitted `ctx.structuredOutput` payload.
- JSON fixtures validate against current schema contracts.
- `$ref` usage remains compatible with bundling in `structured-output-schema.ts`.

## Validation

- `npm run test:schema-fixtures`
- `npm test -- src/core/__tests__/structured-output-schema.test.ts`
- `npm run typecheck`
- `npx skill-check .agents/skills/mobilebuildmcp-structured-output-review`
