---
name: mobilebuildmcp-tool-contract-review
description: Use when reviewing MobileBuildMCP tool contract changes across implementation, manifests, workflow membership, output schema metadata, and next-step templates.
---

# MobileBuildMCP Tool Contract Review

Review guardrails for tool contract changes across implementation, manifests, and workflow exposure.

## Review scope

- Review-only by default.
- Do not edit product code unless the user explicitly requests implementation changes.

## Files to inspect

- `src/mcp/tools/**`
- `manifests/tools/*.yaml`
- `manifests/workflows/*.yaml`
- `src/core/manifest/schema.ts`
- `src/runtime/tool-catalog.ts`
- `src/runtime/types.ts`
- `xcodebuildmcp.com/app/docs/_content/tool-authoring.mdx`
- `xcodebuildmcp.com/app/docs/_content/architecture-manifest-visibility.mdx`

## Guardrails

- Manifest `id` matches filename.
- Manifest `module` points to implementation path without extension.
- Tool module exports named `schema` and `handler`.
- `names.mcp` remains globally unique.
- `names.cli` stays workflow-local and consistent with CLI docs/fixtures.
- Tool appears in at least one workflow unless intentionally hidden by availability.
- `outputSchema` is present for tools that set `ctx.structuredOutput`.
- `nextSteps.toolId` references existing manifest tool IDs.
- Avoid parallel legacy paths or duplicate implementation paths.

## Validation

- `npm run typecheck`
- `npm test -- src/core/manifest/__tests__/schema.test.ts`
- `npm test -- src/runtime/__tests__/tool-invoker.test.ts`
- `npx skill-check .agents/skills/mobilebuildmcp-tool-contract-review`
