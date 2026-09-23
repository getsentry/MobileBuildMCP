---
name: mobilebuildmcp-packaging-resource-review
description: Use when reviewing MobileBuildMCP packaging, resource-root, build artifact, bundled AXe, schema, manifest, and portable macOS distribution changes.
---

# MobileBuildMCP Packaging and Resource Review

Review guardrails for package/build/resource integrity and portable distribution.

## Review scope

- Review-only by default.
- Do not edit product code unless the user explicitly requests implementation changes.

## Files to inspect

- `package.json`
- `scripts/copy-build-assets.js`
- `scripts/package-macos-portable.sh`
- `scripts/build-website-manifest.mjs`
- `schemas/**`
- `manifests/**`
- `skills/**`
- `bundled/**` when present
- Resource-root utilities when touched

## Guardrails

- Published package `files` includes required runtime resources.
- Portable package includes `build`, `manifests`, `bundled`, `skills`, `package.json`, and production dependencies.
- AXe binary/framework expectations remain verified.
- Wrapper scripts preserve `MOBILEBUILDMCP_RESOURCE_ROOT` and `DYLD_FRAMEWORK_PATH`.
- Schemas and manifests stay available in installed and portable layouts.
- Do not assume build outputs exist before `npm run build`.
- Avoid network-dependent packaging behavior without verification/checksums.

## Validation

- `npm run build`
- Packaging-specific when touched:
  - `npm run package:macos -- --help` (if supported)
  - `npm run verify:portable` after artifact creation
- `npx skill-check .agents/skills/mobilebuildmcp-packaging-resource-review`
