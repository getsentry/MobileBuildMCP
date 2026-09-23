# Bugbot Review Guide for MobileBuildMCP

## Project Snapshot

MobileBuildMCP is an MCP server exposing Xcode / Swift workflows as **tools** and **resources**.
Stack: TypeScript · Node.js · plugin-based auto-discovery (`src/mcp/tools`, `src/mcp/resources`).

For full details see [README.md](README.md) and [Architecture](https://github.com/getsentry/xcodebuildmcp.com/blob/main/app/docs/_content/architecture.mdx).

---

## 1. Security Checklist — Critical

* No hard-coded secrets, tokens or DSNs.
* MCP tool logic functions that orchestrate long-running processes with sub-processes (e.g., `xcodebuild`) must flow through `CommandExecutor` with validated arguments. Standalone utility modules that invoke simple, short-lived commands may use direct `child_process`/`fs` imports and standard vitest mocking.
* Paths must be sanitised via helpers in `src/utils/validation.ts`.
* Sentry breadcrumbs / logs must **NOT** include user PII.

---

## 2. Architecture Checklist — Critical

| Rule | Quick diff heuristic |
|------|----------------------|
| Dependency injection for tool logic | New `child_process` \| `fs` import in MCP tool logic ⇒ **warning** (check if process is complex/long-running) |
| Handler / Logic split | `handler` > 20 LOC or contains branching ⇒ **critical** |
| Plugin auto-registration | Manual `registerTool(...)` / `registerResource(...)` ⇒ **critical** |

Positive pattern skeleton:

```ts
// src/mcp/tools/foo-bar.ts
export async function fooBarLogic(
  params: FooBarParams,
  exec: CommandExecutor = getDefaultCommandExecutor(),
  fs: FileSystemExecutor = getDefaultFileSystemExecutor(),
) {
  // ...
}

export const handler = (p: FooBarParams) => fooBarLogic(p);
```

---

## 3. Testing Checklist

* **External-boundary rule for tool logic**: Use `createMockExecutor` / `createMockFileSystemExecutor` for complex process orchestration (xcodebuild, multi-step pipelines) in MCP tool logic functions.
* **Simple utilities**: Standalone utility modules with simple command calls can use direct imports and standard vitest mocking.
* **Internal mocking is allowed**: `vi.mock`, `vi.fn`, `vi.spyOn`, and `.mock*` are acceptable for internal modules/collaborators.
* Each tool must have tests covering happy-path **and** at least one failure path.
* Avoid the `any` type unless justified with an inline comment.

---

## 4. Documentation Checklist

* Tool manifests, schemas, and implementations must stay aligned when tools are added, removed, or renamed.
  *Diff heuristic*: tool changes without corresponding manifest/schema/fixture updates ⇒ **warning**.
* Public tool docs live at https://github.com/getsentry/xcodebuildmcp.com/blob/main/app/docs/_content/tools.mdx and are synced from release data; do not require static in-repo tools-doc parity.
* Update public docs when CLI parameters or tool names change.

---

## 5. Common Anti-Patterns (and fixes)

| Anti-pattern | Preferred approach |
|--------------|--------------------|
| Complex logic in `handler` | Move to `*Logic` function |
| Re-implementing logging | Use `src/utils/logger.ts` |
| Direct `fs` / `child_process` in tool logic orchestrating complex processes | Inject `FileSystemExecutor` / `CommandExecutor` |
| Chained re-exports | Export directly from source |

---

### How Bugbot Can Verify Rules

1. **External-boundary violations**: confirm tests use injected executors/filesystem for external side effects.
2. **DI compliance**: check direct `child_process` / `fs` imports in MCP tool logic; standalone utilities with simple commands are acceptable.
3. **Docs accuracy**: compare tool manifests, schemas, fixtures, and implementation changes; public tool docs are generated at https://github.com/getsentry/xcodebuildmcp.com/blob/main/app/docs/_content/tools.mdx.
4. **Style**: ensure ESLint and Prettier pass (`npm run lint`, `npm run format:check`).

---

Happy reviewing 🚀