import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const sourceDir = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(sourceDir, '../../..');
export const suitesDir = path.join(repoRoot, 'benchmarks/claude-ui/suites');
export const localSuitesDir = path.join(repoRoot, 'benchmarks/claude-ui/local/suites');
export const bundledParserPath = path.join(
  repoRoot,
  'benchmarks/claude-ui/parse_claude_conversation.py',
);
export const serverName = 'mobilebuildmcp-dev';
export const mcpToolPrefix = `mcp__${serverName}__`;
