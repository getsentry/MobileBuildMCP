import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../../core/resource-root.ts', () => ({
  getResourceRoot: vi.fn(),
}));

vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:os')>();
  return {
    ...original,
    homedir: vi.fn(original.homedir),
  };
});

import { getResourceRoot } from '../../../core/resource-root.ts';
import { homedir } from 'node:os';

const mockedGetResourceRoot = vi.mocked(getResourceRoot);
const mockedHomedir = vi.mocked(homedir);
const agentsGuidanceLine =
  '- If using MobileBuildMCP, use the installed MobileBuildMCP skill before calling MobileBuildMCP tools.';
const legacyAgentsGuidanceLine =
  '- If using MobileBuildMCP, first find and read the installed MobileBuildMCP skill before calling MobileBuildMCP tools.';

function loadInitModule() {
  return import('../init.ts');
}

function parseJsonOutput(stdoutSpy: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  const output = stdoutSpy.mock.calls.map((call) => String(call[0] ?? '')).join('');
  return JSON.parse(output.trim()) as Record<string, unknown>;
}

describe('init command', () => {
  let tempDir: string;
  let fakeResourceRoot: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mobilebuildmcp-init-'));
    fakeResourceRoot = join(tempDir, 'resource-root');
    mkdirSync(join(fakeResourceRoot, 'skills', 'mobilebuildmcp'), { recursive: true });
    mkdirSync(join(fakeResourceRoot, 'skills', 'mobilebuildmcp-cli'), { recursive: true });
    writeFileSync(
      join(fakeResourceRoot, 'skills', 'mobilebuildmcp', 'SKILL.md'),
      '# MCP Skill Content',
      'utf8',
    );
    writeFileSync(
      join(fakeResourceRoot, 'skills', 'mobilebuildmcp-cli', 'SKILL.md'),
      '# CLI Skill Content',
      'utf8',
    );
    mockedGetResourceRoot.mockReturnValue(fakeResourceRoot);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('registerInitCommand', () => {
    it('exports registerInitCommand function', async () => {
      const mod = await loadInitModule();
      expect(typeof mod.registerInitCommand).toBe('function');
    });
  });

  describe('skill installation', () => {
    it('installs CLI skill to a destination directory', async () => {
      const dest = join(tempDir, 'skills');
      mkdirSync(dest, { recursive: true });

      const yargs = (await import('yargs')).default;
      const mod = await loadInitModule();

      const app = yargs(['init', '--dest', dest, '--skill', 'cli']).scriptName('');
      mod.registerInitCommand(app);

      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      await app.parseAsync();

      const installed = join(dest, 'mobilebuildmcp-cli', 'SKILL.md');
      expect(existsSync(installed)).toBe(true);
      expect(readFileSync(installed, 'utf8')).toBe('# CLI Skill Content');

      const output = parseJsonOutput(stdoutSpy);
      expect(output.action).toBe('install');
      expect(output.skillType).toBe('cli');
      expect(output.message).toBe('Installed MobileBuildMCP CLI skill');
      expect(output.installed).toEqual([{ client: 'Custom', location: installed }]);

      stdoutSpy.mockRestore();
    });

    it('installs MCP skill to a destination directory', async () => {
      const dest = join(tempDir, 'skills');
      mkdirSync(dest, { recursive: true });

      const yargs = (await import('yargs')).default;
      const mod = await loadInitModule();

      const app = yargs(['init', '--dest', dest, '--skill', 'mcp']).scriptName('');
      mod.registerInitCommand(app);

      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      await app.parseAsync();

      const installed = join(dest, 'mobilebuildmcp', 'SKILL.md');
      expect(existsSync(installed)).toBe(true);
      expect(readFileSync(installed, 'utf8')).toBe('# MCP Skill Content');

      const output = parseJsonOutput(stdoutSpy);
      expect(output.action).toBe('install');
      expect(output.skillType).toBe('mcp');
      expect(output.message).toBe('Installed MobileBuildMCP (MCP server) skill');

      stdoutSpy.mockRestore();
    });

    it('defaults to CLI skill when --skill is omitted', async () => {
      const dest = join(tempDir, 'skills');
      mkdirSync(dest, { recursive: true });

      const yargs = (await import('yargs')).default;
      const mod = await loadInitModule();

      const app = yargs(['init', '--dest', dest]).scriptName('');
      mod.registerInitCommand(app);

      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      await app.parseAsync();

      expect(existsSync(join(dest, 'mobilebuildmcp-cli', 'SKILL.md'))).toBe(true);
      expect(existsSync(join(dest, 'mobilebuildmcp', 'SKILL.md'))).toBe(false);

      stdoutSpy.mockRestore();
    });

    it('expands ~ in --dest to home directory', async () => {
      const fakeHome = join(tempDir, 'home');
      mkdirSync(fakeHome, { recursive: true });
      mockedHomedir.mockReturnValue(fakeHome);

      const yargs = (await import('yargs')).default;
      const mod = await loadInitModule();

      const app = yargs(['init', '--dest', '~/skills', '--skill', 'cli']).scriptName('');
      mod.registerInitCommand(app);

      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      await app.parseAsync();

      const installed = join(fakeHome, 'skills', 'mobilebuildmcp-cli', 'SKILL.md');
      expect(existsSync(installed)).toBe(true);

      stdoutSpy.mockRestore();
    });

    it('skips Claude for MCP skill in auto-detect mode', async () => {
      const fakeHome = join(tempDir, 'home-auto-skip-claude');
      mkdirSync(join(fakeHome, '.claude'), { recursive: true });
      mkdirSync(join(fakeHome, '.agents'), { recursive: true });
      mockedHomedir.mockReturnValue(fakeHome);

      const yargs = (await import('yargs')).default;
      const mod = await loadInitModule();

      const app = yargs(['init', '--skill', 'mcp', '--client', 'auto']).scriptName('');
      mod.registerInitCommand(app);

      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      await app.parseAsync();

      expect(existsSync(join(fakeHome, '.claude', 'skills', 'mobilebuildmcp', 'SKILL.md'))).toBe(
        false,
      );
      expect(existsSync(join(fakeHome, '.agents', 'skills', 'mobilebuildmcp', 'SKILL.md'))).toBe(
        true,
      );

      const output = parseJsonOutput(stdoutSpy);
      expect(output.action).toBe('install');
      expect(output.skillType).toBe('mcp');
      expect(output.skipped).toEqual([
        {
          client: 'Claude Code',
          reason: 'MCP skill is unnecessary because Claude Code already uses server instructions.',
        },
      ]);

      stdoutSpy.mockRestore();
    });

    it('errors with skip reason when only Claude is detected for MCP auto-install', async () => {
      const fakeHome = join(tempDir, 'home-only-claude');
      mkdirSync(join(fakeHome, '.claude'), { recursive: true });
      mockedHomedir.mockReturnValue(fakeHome);

      const yargs = (await import('yargs')).default;
      const mod = await loadInitModule();

      const app = yargs(['init', '--skill', 'mcp', '--client', 'auto']).scriptName('').fail(false);
      mod.registerInitCommand(app);

      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      await expect(app.parseAsync()).rejects.toThrow(
        'No eligible install targets after applying skill policy. Skipped: Claude Code: MCP skill is unnecessary because Claude Code already uses server instructions.',
      );

      const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(output).toContain(
        'Skipped Claude Code: MCP skill is unnecessary because Claude Code already uses server instructions.',
      );

      stdoutSpy.mockRestore();
    });

    it('allows explicit Claude MCP install with --client claude', async () => {
      const fakeHome = join(tempDir, 'home-explicit-claude');
      mkdirSync(join(fakeHome, '.claude'), { recursive: true });
      mockedHomedir.mockReturnValue(fakeHome);

      const yargs = (await import('yargs')).default;
      const mod = await loadInitModule();

      const app = yargs(['init', '--client', 'claude', '--skill', 'mcp']).scriptName('');
      mod.registerInitCommand(app);

      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      await app.parseAsync();

      expect(existsSync(join(fakeHome, '.claude', 'skills', 'mobilebuildmcp', 'SKILL.md'))).toBe(
        true,
      );

      const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(output).not.toContain('Skipped Claude Code');

      stdoutSpy.mockRestore();
    });
  });

  describe('conflict handling', () => {
    it('removes conflicting skill with --remove-conflict', async () => {
      const dest = join(tempDir, 'skills');
      const conflictDir = join(dest, 'mobilebuildmcp');
      mkdirSync(conflictDir, { recursive: true });
      writeFileSync(join(conflictDir, 'SKILL.md'), 'old mcp skill', 'utf8');

      const yargs = (await import('yargs')).default;
      const mod = await loadInitModule();

      const app = yargs(['init', '--dest', dest, '--skill', 'cli', '--remove-conflict']).scriptName(
        '',
      );
      mod.registerInitCommand(app);

      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      await app.parseAsync();

      expect(existsSync(conflictDir)).toBe(false);
      expect(existsSync(join(dest, 'mobilebuildmcp-cli', 'SKILL.md'))).toBe(true);

      stdoutSpy.mockRestore();
    });

    it('errors on conflict in non-interactive mode without --remove-conflict', async () => {
      const dest = join(tempDir, 'skills');
      const conflictDir = join(dest, 'mobilebuildmcp');
      mkdirSync(conflictDir, { recursive: true });
      writeFileSync(join(conflictDir, 'SKILL.md'), 'old mcp skill', 'utf8');

      const originalIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

      const yargs = (await import('yargs')).default;
      const mod = await loadInitModule();

      const app = yargs(['init', '--dest', dest, '--skill', 'cli']).scriptName('').fail(false);
      mod.registerInitCommand(app);

      await expect(app.parseAsync()).rejects.toThrow('conflicting mcp skill found');

      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    });
  });

  describe('--force', () => {
    it('overwrites existing installation with --force', async () => {
      const dest = join(tempDir, 'skills');
      const existingDir = join(dest, 'mobilebuildmcp-cli');
      mkdirSync(existingDir, { recursive: true });
      writeFileSync(join(existingDir, 'SKILL.md'), 'old content', 'utf8');

      const yargs = (await import('yargs')).default;
      const mod = await loadInitModule();

      const app = yargs(['init', '--dest', dest, '--skill', 'cli', '--force']).scriptName('');
      mod.registerInitCommand(app);

      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      await app.parseAsync();

      expect(readFileSync(join(existingDir, 'SKILL.md'), 'utf8')).toBe('# CLI Skill Content');

      stdoutSpy.mockRestore();
    });
  });

  describe('--uninstall', () => {
    it('removes all installed skill directories', async () => {
      const dest = join(tempDir, 'skills');
      const cliSkillDir = join(dest, 'mobilebuildmcp-cli');
      const mcpSkillDir = join(dest, 'mobilebuildmcp');
      mkdirSync(cliSkillDir, { recursive: true });
      mkdirSync(mcpSkillDir, { recursive: true });
      writeFileSync(join(cliSkillDir, 'SKILL.md'), 'cli content', 'utf8');
      writeFileSync(join(mcpSkillDir, 'SKILL.md'), 'mcp content', 'utf8');

      const yargs = (await import('yargs')).default;
      const mod = await loadInitModule();

      const app = yargs(['init', '--dest', dest, '--uninstall']).scriptName('');
      mod.registerInitCommand(app);

      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      await app.parseAsync();

      expect(existsSync(cliSkillDir)).toBe(false);
      expect(existsSync(mcpSkillDir)).toBe(false);

      const output = parseJsonOutput(stdoutSpy);
      expect(output.action).toBe('uninstall');
      expect(output.message).toBe('Uninstalled skill directories');
      expect(output.removed).toHaveLength(2);
      expect(output.removed).toEqual(
        expect.arrayContaining([
          { client: 'Custom', variant: 'mobilebuildmcp-cli', path: cliSkillDir },
          { client: 'Custom', variant: 'mobilebuildmcp', path: mcpSkillDir },
        ]),
      );

      stdoutSpy.mockRestore();
    });

    it('reports when no skill is installed', async () => {
      const dest = join(tempDir, 'skills');
      mkdirSync(dest, { recursive: true });

      const yargs = (await import('yargs')).default;
      const mod = await loadInitModule();

      const app = yargs(['init', '--dest', dest, '--uninstall']).scriptName('');
      mod.registerInitCommand(app);

      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      await app.parseAsync();

      const output = parseJsonOutput(stdoutSpy);
      expect(output.action).toBe('uninstall');
      expect(output.message).toBe('No installed skill directories found to remove.');
      expect(output.removed).toEqual([]);

      stdoutSpy.mockRestore();
    });

    it('gracefully reports no installed skills when auto-detect finds no clients', async () => {
      const emptyHome = join(tempDir, 'empty-home-uninstall');
      mkdirSync(emptyHome, { recursive: true });
      mockedHomedir.mockReturnValue(emptyHome);

      const yargs = (await import('yargs')).default;
      const mod = await loadInitModule();

      const app = yargs(['init', '--uninstall']).scriptName('').fail(false);
      mod.registerInitCommand(app);

      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      await app.parseAsync();

      const output = parseJsonOutput(stdoutSpy);
      expect(output.action).toBe('uninstall');
      expect(output.message).toBe('No installed skill directories found to remove.');
      expect(output.removed).toEqual([]);

      stdoutSpy.mockRestore();
    });
  });

  describe('--print', () => {
    it('prints CLI skill content to stdout', async () => {
      const yargs = (await import('yargs')).default;
      const mod = await loadInitModule();

      const app = yargs(['init', '--print', '--skill', 'cli']).scriptName('');
      mod.registerInitCommand(app);

      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      await app.parseAsync();

      const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(output).toBe('# CLI Skill Content');

      stdoutSpy.mockRestore();
    });

    it('prints MCP skill content to stdout', async () => {
      const yargs = (await import('yargs')).default;
      const mod = await loadInitModule();

      const app = yargs(['init', '--print', '--skill', 'mcp']).scriptName('');
      mod.registerInitCommand(app);

      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      await app.parseAsync();

      const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(output).toBe('# MCP Skill Content');

      stdoutSpy.mockRestore();
    });

    it('does not create any skill directories when using --print', async () => {
      const emptyHome = join(tempDir, 'print-home');
      mkdirSync(emptyHome, { recursive: true });
      mockedHomedir.mockReturnValue(emptyHome);

      const yargs = (await import('yargs')).default;
      const mod = await loadInitModule();

      const app = yargs(['init', '--print']).scriptName('');
      mod.registerInitCommand(app);

      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      await app.parseAsync();

      expect(existsSync(join(emptyHome, '.claude', 'skills'))).toBe(false);
      expect(existsSync(join(emptyHome, '.agents', 'skills'))).toBe(false);

      stdoutSpy.mockRestore();
    });
  });

  describe('AGENTS.md guidance on skill install', () => {
    it('creates project-level AGENTS.md when missing', async () => {
      const dest = join(tempDir, 'skills');
      const projectRoot = join(tempDir, 'project-create');
      mkdirSync(dest, { recursive: true });
      mkdirSync(projectRoot, { recursive: true });

      const yargs = (await import('yargs')).default;
      const mod = await loadInitModule();

      const app = yargs(['init', '--dest', dest, '--skill', 'cli']).scriptName('');
      mod.registerInitCommand(app, { workspaceRoot: projectRoot });

      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      await app.parseAsync();

      const agentsPath = join(projectRoot, 'AGENTS.md');
      expect(existsSync(agentsPath)).toBe(true);
      expect(readFileSync(agentsPath, 'utf8')).toContain(agentsGuidanceLine);

      const output = parseJsonOutput(stdoutSpy);
      expect(output.action).toBe('install');
      expect(output.message).toBe('Installed MobileBuildMCP CLI skill');
      expect(output.agentsGuidance).toEqual({
        status: 'created',
        path: agentsPath,
      });

      stdoutSpy.mockRestore();
    });

    it('shows diff and errors in non-interactive mode when AGENTS.md exists and --force is not set', async () => {
      const dest = join(tempDir, 'skills');
      const projectRoot = join(tempDir, 'project-non-interactive');
      mkdirSync(dest, { recursive: true });
      mkdirSync(projectRoot, { recursive: true });
      writeFileSync(join(projectRoot, 'AGENTS.md'), '# Existing\n', 'utf8');

      const originalIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

      const yargs = (await import('yargs')).default;
      const mod = await loadInitModule();

      const app = yargs(['init', '--dest', dest, '--skill', 'cli']).scriptName('').fail(false);
      mod.registerInitCommand(app, { workspaceRoot: projectRoot });

      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      await expect(app.parseAsync()).rejects.toThrow(
        'AGENTS.md exists and requires confirmation to update',
      );

      const output = parseJsonOutput(stdoutSpy);
      expect(output.action).toBe('install');
      expect(output.message).toBe('Installed MobileBuildMCP CLI skill');
      expect(output.agentsGuidance).toEqual({
        status: 'error',
        path: join(projectRoot, 'AGENTS.md'),
        error:
          'AGENTS.md exists and requires confirmation to update. Re-run with --force to apply the change in non-interactive mode.',
      });

      stdoutSpy.mockRestore();
      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    });

    it('updates existing AGENTS.md with --force without prompting', async () => {
      const dest = join(tempDir, 'skills');
      const projectRoot = join(tempDir, 'project-force');
      mkdirSync(dest, { recursive: true });
      mkdirSync(projectRoot, { recursive: true });
      writeFileSync(join(projectRoot, 'AGENTS.md'), '# Existing\n', 'utf8');

      const originalIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

      const yargs = (await import('yargs')).default;
      const mod = await loadInitModule();

      const app = yargs(['init', '--dest', dest, '--skill', 'cli', '--force']).scriptName('');
      mod.registerInitCommand(app, { workspaceRoot: projectRoot });

      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      await app.parseAsync();

      const agentsContent = readFileSync(join(projectRoot, 'AGENTS.md'), 'utf8');
      expect(agentsContent).toContain('# Existing');
      expect(agentsContent).toContain(agentsGuidanceLine);

      const output = parseJsonOutput(stdoutSpy);
      expect(output.action).toBe('install');
      expect(output.message).toBe('Installed MobileBuildMCP CLI skill');
      expect(output.agentsGuidance).toEqual({
        status: 'updated',
        path: join(projectRoot, 'AGENTS.md'),
      });

      stdoutSpy.mockRestore();
      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    });

    it('replaces legacy MobileBuildMCP guidance line without appending duplicate', async () => {
      const dest = join(tempDir, 'skills');
      const projectRoot = join(tempDir, 'project-legacy-guidance');
      mkdirSync(dest, { recursive: true });
      mkdirSync(projectRoot, { recursive: true });
      writeFileSync(
        join(projectRoot, 'AGENTS.md'),
        `# Existing\n\n${legacyAgentsGuidanceLine}\n`,
        'utf8',
      );

      const yargs = (await import('yargs')).default;
      const mod = await loadInitModule();

      const app = yargs(['init', '--dest', dest, '--skill', 'cli']).scriptName('');
      mod.registerInitCommand(app, { workspaceRoot: projectRoot });

      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      await app.parseAsync();

      const agentsContent = readFileSync(join(projectRoot, 'AGENTS.md'), 'utf8');
      expect(agentsContent).toContain(agentsGuidanceLine);
      expect(agentsContent).not.toContain(legacyAgentsGuidanceLine);
      expect(
        agentsContent.match(
          new RegExp(agentsGuidanceLine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
        )?.length,
      ).toBe(1);

      const output = parseJsonOutput(stdoutSpy);
      expect(output.action).toBe('install');
      expect(output.message).toBe('Installed MobileBuildMCP CLI skill');
      expect(output.agentsGuidance).toEqual({
        status: 'updated',
        path: join(projectRoot, 'AGENTS.md'),
      });

      stdoutSpy.mockRestore();
    });
  });

  describe('error cases', () => {
    it('errors when --dest points to filesystem root', async () => {
      const rootDest = '/';

      const yargs = (await import('yargs')).default;
      const mod = await loadInitModule();

      const app = yargs(['init', '--dest', rootDest, '--skill', 'cli']).scriptName('').fail(false);
      mod.registerInitCommand(app);

      await expect(app.parseAsync()).rejects.toThrow(
        'Refusing to use filesystem root as skills destination',
      );
    });

    it('errors when skill source file is missing', async () => {
      rmSync(join(fakeResourceRoot, 'skills', 'mobilebuildmcp-cli', 'SKILL.md'));

      const dest = join(tempDir, 'skills');
      mkdirSync(dest, { recursive: true });

      const yargs = (await import('yargs')).default;
      const mod = await loadInitModule();

      const app = yargs(['init', '--dest', dest, '--skill', 'cli']).scriptName('').fail(false);
      mod.registerInitCommand(app);

      await expect(app.parseAsync()).rejects.toThrow('Skill source not found');
    });

    it('does not delete conflicting skill when source file is missing', async () => {
      rmSync(join(fakeResourceRoot, 'skills', 'mobilebuildmcp-cli', 'SKILL.md'));

      const dest = join(tempDir, 'skills');
      const conflictDir = join(dest, 'mobilebuildmcp');
      mkdirSync(conflictDir, { recursive: true });
      writeFileSync(join(conflictDir, 'SKILL.md'), 'existing mcp skill', 'utf8');

      const yargs = (await import('yargs')).default;
      const mod = await loadInitModule();

      const app = yargs(['init', '--dest', dest, '--skill', 'cli', '--remove-conflict'])
        .scriptName('')
        .fail(false);
      mod.registerInitCommand(app);

      await expect(app.parseAsync()).rejects.toThrow('Skill source not found');
      expect(existsSync(conflictDir)).toBe(true);
      expect(readFileSync(join(conflictDir, 'SKILL.md'), 'utf8')).toBe('existing mcp skill');
    });

    it('errors in non-interactive mode without --client or --dest', async () => {
      const originalStdinIsTTY = process.stdin.isTTY;
      const originalStdoutIsTTY = process.stdout.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
      Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });

      const yargs = (await import('yargs')).default;
      const mod = await loadInitModule();

      const app = yargs(['init', '--skill', 'cli']).scriptName('').fail(false);
      mod.registerInitCommand(app);

      await expect(app.parseAsync()).rejects.toThrow(
        'Non-interactive mode requires --client or --dest for init',
      );

      Object.defineProperty(process.stdin, 'isTTY', {
        value: originalStdinIsTTY,
        configurable: true,
      });
      Object.defineProperty(process.stdout, 'isTTY', {
        value: originalStdoutIsTTY,
        configurable: true,
      });
    });

    it('errors when no clients detected with --client=auto and no --dest or --print', async () => {
      const emptyHome = join(tempDir, 'empty-home');
      mkdirSync(emptyHome, { recursive: true });
      mockedHomedir.mockReturnValue(emptyHome);

      const yargs = (await import('yargs')).default;
      const mod = await loadInitModule();

      const app = yargs(['init', '--skill', 'cli', '--client', 'auto']).scriptName('').fail(false);
      mod.registerInitCommand(app);

      await expect(app.parseAsync()).rejects.toThrow('No supported AI clients detected');
    });
  });
});
