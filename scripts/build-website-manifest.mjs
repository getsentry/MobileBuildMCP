#!/usr/bin/env node
/**
 * Build the manifests.json snapshot consumed by getsentry/xcodebuildmcp.com.
 *
 * Reads manifests/workflows/*.yaml, manifests/tools/*.yaml, and package.json
 * from this repo, normalises them into the shape the website expects, and
 * writes JSON to the path passed via --out=.
 *
 * Usage:
 *   node scripts/build-website-manifest.mjs --out=<path> [--ref=<tag>]
 *
 * The output shape mirrors scripts/sync-mobilebuildmcp-manifests.mjs in the
 * website repo so the publish path can be flipped from pull (Monday cron PR)
 * to push (release-time direct commit) without changing consumers.
 */

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const args = { out: undefined, ref: undefined };
  for (const a of argv) {
    if (a.startsWith("--out=")) args.out = a.slice("--out=".length);
    else if (a.startsWith("--ref=")) args.ref = a.slice("--ref=".length);
    else if (a === "--help" || a === "-h") args.help = true;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function usage() {
  console.error(
    "Usage: build-website-manifest.mjs --out=<path> [--ref=<tag>]\n" +
      "  --out  Output JSON file path (required).\n" +
      "  --ref  Ref/tag to record in the snapshot. Defaults to v<package.json version>.",
  );
}

async function loadYamlDir(dir) {
  const entries = (await readdir(dir)).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  return Promise.all(
    entries.map(async (f) => parseYaml(await readFile(path.join(dir, f), "utf8"))),
  );
}

function normalizeTools(raw) {
  return raw
    .map((t) => ({
      id: t.id,
      mcpName: t.names?.mcp ?? t.id,
      cliName: t.names?.cli ?? null,
      description: t.description ?? "",
      title: t.annotations?.title ?? null,
      readOnly: Boolean(t.annotations?.readOnlyHint),
      destructive: Boolean(t.annotations?.destructiveHint),
      openWorld: Boolean(t.annotations?.openWorldHint),
      module: t.module ?? null,
      predicates: Array.isArray(t.predicates) ? t.predicates : [],
    }))
    .sort((a, b) => a.mcpName.localeCompare(b.mcpName));
}

function normalizeWorkflows(raw) {
  return raw
    .map((w) => ({
      id: w.id,
      title: w.title ?? w.id,
      description: w.description ?? "",
      defaultEnabled: Boolean(w.selection?.mcp?.defaultEnabled),
      tools: Array.isArray(w.tools) ? w.tools : [],
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  if (!args.out) {
    usage();
    process.exit(2);
  }

  const [workflows, tools, pkg] = await Promise.all([
    loadYamlDir(path.join(repoRoot, "manifests", "workflows")),
    loadYamlDir(path.join(repoRoot, "manifests", "tools")),
    readFile(path.join(repoRoot, "package.json"), "utf8").then(JSON.parse),
  ]);

  const ref = args.ref ?? `v${pkg.version}`;
  const snapshot = {
    source: `github:getsentry/MobileBuildMCP@${ref}`,
    ref,
    syncedAt: new Date().toISOString(),
    version: pkg.version,
    workflows: normalizeWorkflows(workflows),
    tools: normalizeTools(tools),
  };

  const outPath = path.resolve(args.out);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(snapshot, null, 2) + "\n", "utf8");

  console.log(
    `Wrote ${outPath}\n  ref: ${ref}\n  version: ${snapshot.version}\n  workflows: ${snapshot.workflows.length}\n  tools: ${snapshot.tools.length}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
