#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';

const VERSION_HEADING_REGEX = /^##\s+\[([^\]]+)\](?:\s+-\s+.*)?\s*$/;

function normalizeVersion(value) {
  return value.trim().replace(/^v/, '');
}

function parseArgs(argv) {
  const args = {
    changelog: 'CHANGELOG.md',
    out: '',
    packageName: 'mobilebuildmcp',
    version: '',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === '--version') {
      if (!next) {
        throw new Error('Missing value for --version');
      }
      args.version = next;
      i += 1;
      continue;
    }

    if (arg === '--changelog') {
      if (!next) {
        throw new Error('Missing value for --changelog');
      }
      args.changelog = next;
      i += 1;
      continue;
    }

    if (arg === '--out') {
      if (!next) {
        throw new Error('Missing value for --out');
      }
      args.out = next;
      i += 1;
      continue;
    }

    if (arg === '--package') {
      if (!next) {
        throw new Error('Missing value for --package');
      }
      args.packageName = next;
      i += 1;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!args.version) {
    throw new Error('Missing required argument: --version');
  }

  return args;
}

function printHelp() {
  console.log(`Generate GitHub release notes from CHANGELOG.md.

Usage:
  node scripts/generate-github-release-notes.mjs --version <version> [options]

Options:
  --version <version>    Required release version (e.g. 2.0.0 or 2.0.0-beta.1)
  --changelog <path>     Changelog path (default: CHANGELOG.md)
  --out <path>           Output file path (default: stdout)
  --package <name>       Package name for install snippets (default: mobilebuildmcp)
  -h, --help             Show this help
`);
}

function extractChangelogSection(changelog, version) {
  const normalizedTarget = normalizeVersion(version);
  const lines = changelog.split(/\r?\n/);
  let sectionStartLine = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(VERSION_HEADING_REGEX);
    if (!match) {
      continue;
    }

    if (normalizeVersion(match[1]) === normalizedTarget) {
      sectionStartLine = index + 1;
      break;
    }
  }

  if (sectionStartLine === -1) {
    throw new Error(
      `Missing CHANGELOG section for version: ${normalizedTarget}\n` +
        `Add a heading like: ## [${normalizedTarget}] (or ## [v${normalizedTarget}] - YYYY-MM-DD)`,
    );
  }

  let sectionEndLine = lines.length;
  for (let index = sectionStartLine; index < lines.length; index += 1) {
    if (VERSION_HEADING_REGEX.test(lines[index])) {
      sectionEndLine = index;
      break;
    }
  }

  const section = lines.slice(sectionStartLine, sectionEndLine).join('\n').trim();
  if (!section) {
    throw new Error(`CHANGELOG section for version ${normalizedTarget} is empty`);
  }

  return section;
}

function buildInstallAndSetupSection(version, packageName) {
  const normalizedVersion = normalizeVersion(version);
  return [
    '### Option A — Homebrew (no Node.js required)',
    '',
    'Install:',
    '```bash',
    "brew tap getsentry/xcodebuildmcp",
    `brew install ${packageName}`,
    '```',
    '',
    'MCP config:',
    '```json',
    '"MobileBuildMCP": {',
    `  "command": "${packageName}",`,
    '  "args": ["mcp"]',
    '}',
    '```',
    '',
    '### Option B — npm / npx (Node.js 18+)',
    '',
    'Install:',
    '```bash',
    `npm install -g ${packageName}@latest`,
    '```',
    '',
    'MCP config:',
    '```json',
    '"MobileBuildMCP": {',
    '  "command": "npx",',
    `  "args": ["-y", "${packageName}@latest", "mcp"]`,
    '}',
    '```',
    '',
    `📦 **NPM Package**: https://www.npmjs.com/package/${packageName}/v/${normalizedVersion}`,
  ].join('\n');
}

function buildReleaseBody(version, changelogSection, packageName) {
  const normalizedVersion = normalizeVersion(version);
  const installAndSetup = buildInstallAndSetupSection(normalizedVersion, packageName);
  return [`## Release v${normalizedVersion}`, '', changelogSection, '', installAndSetup, ''].join(
    '\n',
  );
}

async function main() {
  try {
    const { changelog, out, packageName, version } = parseArgs(process.argv.slice(2));
    const changelogContent = await readFile(changelog, 'utf8').catch(() => {
      throw new Error(`Could not read CHANGELOG.md at ${changelog}`);
    });

    const section = extractChangelogSection(changelogContent, version);
    const body = buildReleaseBody(version, section, packageName);

    if (out) {
      await writeFile(out, body, 'utf8');
      return;
    }

    process.stdout.write(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`❌ ${message}\n`);
    process.exit(1);
  }
}

await main();
