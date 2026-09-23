---
name: mobilebuildmcp-rendering-streaming-review
description: Use when reviewing MobileBuildMCP rendering, streaming fragment, next-step, and CLI output mode changes for boundary violations.
---

# MobileBuildMCP Rendering and Streaming Review

Review guardrails for rendering boundaries, streaming fragments, and output modes.

## Review scope

- Review-only by default.
- Do not edit product code unless the user explicitly requests implementation changes.

## Files to inspect

- `src/rendering/**`
- `src/types/domain-fragments.ts`
- `src/types/runtime-status.ts`
- `src/runtime/tool-invoker.ts`
- `src/runtime/__tests__/tool-invoker.test.ts`
- `xcodebuildmcp.com/app/docs/_content/architecture-rendering-output.mdx`
- `xcodebuildmcp.com/app/docs/_content/architecture-tool-lifecycle.mdx`
- `xcodebuildmcp.com/app/docs/_content/output-formats.mdx`

## Guardrails

- Tool handlers do not branch on CLI vs MCP output mode.
- Fragments represent progress, not final contract data.
- Final structured output remains canonical.
- Do not invent `json`/`jsonl` render strategies.
- Streaming tools emit typed fragments and one final structured result.
- Non-streaming tools do not emit unnecessary fragments.
- Keep `ctx.emit` and xcodebuild pipeline `emitFragment` contexts separate.
- Keep next-step rendering in runtime/rendering boundary.

## Validation

- `npm test -- src/runtime/__tests__/tool-invoker.test.ts`
- `npm run test:snapshots`
- `npm run typecheck`
- `npx skill-check .agents/skills/mobilebuildmcp-rendering-streaming-review`
