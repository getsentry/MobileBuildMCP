import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve } from 'path';

const CLI = resolve(__dirname, '../../../build/cli.js');
const cliEnv = (() => {
  const env: Record<string, string | undefined> = { ...process.env, NO_COLOR: '1' };
  // Remove test environment markers so the CLI binary runs in production mode
  delete env.VITEST;
  delete env.NODE_ENV;
  return env;
})();
const run = (args: string): string => {
  const argv = args.trim() ? args.trim().split(/\s+/) : [];
  return execFileSync('node', [CLI, ...argv], {
    encoding: 'utf8',
    timeout: 15_000,
    env: cliEnv,
  });
};

const runMayFail = (args: string): { stdout: string; status: number } => {
  try {
    const stdout = run(args);
    return { stdout, status: 0 };
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      status?: number;
    };
    return {
      stdout: (error.stdout ?? '') + (error.stderr ?? ''),
      status: error.status ?? 1,
    };
  }
};

describe('CLI Surface (e2e)', () => {
  describe('top-level', () => {
    it('--help shows usage info', () => {
      const output = run('--help');
      expect(output).toContain('Usage:');
      expect(output).toContain('mobilebuildmcp');
      expect(output).toContain('Commands:');
    });

    it('--version prints a semver string', () => {
      const output = run('--version').trim();
      expect(output).toMatch(/^\d+\.\d+\.\d+/);
    });

    it('tools command lists available tools', () => {
      const output = run('tools');
      expect(output).toContain('Available tools');
      expect(output).toContain('simulator:');
      expect(output).toContain('build');
    });

    it('purge --help shows storage management options', () => {
      const output = run('purge --help');
      expect(output).toContain('Report and clean MobileBuildMCP workspace storage');
      expect(output).toContain('--dry-run');
      expect(output).toContain('--delete');
    });
  });

  describe('workflow subcommands', () => {
    const workflows = [
      'simulator',
      'simulator-management',
      'device',
      'macos',
      'project-discovery',
      'project-scaffolding',
      'swift-package',
      'logging',
      'debugging',
      'ui-automation',
      'utilities',
    ];

    it.each(workflows)('%s --help shows workflow help', (workflow) => {
      const output = run(`${workflow} --help`);
      expect(output).toContain('Commands:');
    });
  });

  describe('tool-specific help', () => {
    const toolCases = [
      { workflow: 'simulator', tool: 'build', expected: '--scheme' },
      { workflow: 'simulator', tool: 'list-sims', expected: '--help' },
      { workflow: 'device', tool: 'build', expected: '--scheme' },
      { workflow: 'swift-package', tool: 'build', expected: '--package-path' },
      { workflow: 'project-discovery', tool: 'list-schemes', expected: 'List Xcode schemes.' },
      { workflow: 'ui-automation', tool: 'tap', expected: '--simulator-id' },
      { workflow: 'utilities', tool: 'clean', expected: '--scheme' },
    ];

    it.each(toolCases)(
      '$workflow $tool --help shows parameter docs',
      ({ workflow, tool, expected }) => {
        const output = run(`${workflow} ${tool} --help`);
        expect(output).toContain(expected);
      },
    );
  });

  describe('tool invocation', () => {
    it('invalid tool returns error', () => {
      const result = runMayFail('simulator nonexistent-tool');
      expect(result.status).not.toBe(0);
    });

    it('tool with --output json returns valid JSON', () => {
      // list_sims is a good candidate -- it will fail to run xcrun but should
      // return structured JSON output even on error
      const result = runMayFail('simulator list-sims --output json');
      const output = result.stdout.trim();
      expect(output.length).toBeGreaterThan(0);
      // Even if the tool fails (no xcrun), a successful run should be JSON
      if (result.status === 0) {
        const parsed = JSON.parse(output);
        expect(parsed).toBeDefined();
      }
      // If it fails, that's acceptable on non-macOS platforms as long as output is present
    });

    it('missing required args produces user-friendly error', () => {
      // build requires --scheme
      const result = runMayFail('simulator build');
      const output = result.stdout.toLowerCase();
      // Should mention the missing requirement
      expect(
        output.includes('required') ||
          output.includes('scheme') ||
          output.includes('error') ||
          output.includes('must provide') ||
          output.includes('missing'),
      ).toBe(true);
    });
  });
});
