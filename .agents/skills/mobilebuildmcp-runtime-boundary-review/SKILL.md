---
name: mobilebuildmcp-runtime-boundary-review
description: Use when reviewing MobileBuildMCP runtime boundary changes across MCP, direct CLI invocation, daemon-routed tools, and Xcode IDE bridge routing.
---

# MobileBuildMCP Runtime Boundary Review

Review guardrails for runtime routing and invocation boundaries.

## Review scope

- Review-only by default.
- Do not edit product code unless the user explicitly requests implementation changes.

## Files to inspect

- `src/runtime/tool-catalog.ts`
- `src/runtime/tool-invoker.ts`
- `src/runtime/types.ts`
- `src/cli/**`
- `src/daemon/**`
- `manifests/tools/*.yaml`
- `manifests/workflows/*.yaml`
- `xcodebuildmcp.com/app/docs/_content/architecture-runtime-boundaries.mdx`
- `xcodebuildmcp.com/app/docs/_content/architecture-manifest-visibility.mdx`

## Guardrails

- MCP, CLI, and daemon paths use shared handlers.
- Stateful CLI tools route through daemon only when `routing.stateful` requires it.
- Do not treat daemon as a third manifest availability mode.
- Dynamic Xcode IDE tools keep daemon routing semantics.
- Catalog filtering respects availability, workflow selection, and predicates.
- Runtime failures surface via runtime/rendering status and fragments.
- Avoid silent fallbacks and parallel invocation paths.

## Validation

- `npm test -- src/runtime/__tests__/tool-invoker.test.ts`
- `npm run typecheck`
- `npx skill-check .agents/skills/mobilebuildmcp-runtime-boundary-review`
