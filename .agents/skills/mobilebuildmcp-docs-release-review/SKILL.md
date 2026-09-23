---
name: mobilebuildmcp-docs-release-review
description: Use when reviewing MobileBuildMCP documentation, CLI command references, website manifest generation, changelog, release notes, and release script changes.
---

# MobileBuildMCP Docs and Release Review

Review guardrails for documentation, generated references, and release flow consistency.

## Review scope

- Review-only by default.
- Do not edit product code unless the user explicitly requests implementation changes.

## Files to inspect

- `README.md`
- `CHANGELOG.md` when present
- `scripts/build-website-manifest.mjs`
- `scripts/generate-github-release-notes.mjs`
- `scripts/release.sh`
- `package.json`
- `xcodebuildmcp.com/app/docs/_content/**`

## Guardrails

- CLI examples match generated CLI catalog/commands.
- Docs do not reference unavailable tools or workflows.
- User-facing behavior changes include changelog updates.
- Release notes derive from a valid changelog section.
- README install snippets align with release script tag replacement.
- Website manifest generation preserves expected normalized fields.
- Docs explain runtime/contracts without deprecated patterns.
- Keep docs-only work from introducing product behavior changes.
- CLI command references in changelog entries are reviewed by `mobilebuildmcp-docs-command-review`.

## Validation

- `npm run build`
- Release notes check when touched:
  - `node scripts/generate-github-release-notes.mjs --version <version> --changelog CHANGELOG.md`
- `npx skill-check .agents/skills/mobilebuildmcp-docs-release-review`
