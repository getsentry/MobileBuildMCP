import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  spinner: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
  })),
  log: {
    info: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    step: vi.fn(),
    message: vi.fn(),
    warn: vi.fn(),
  },
  note: vi.fn(),
  confirm: vi.fn().mockResolvedValue(true),
  isCancel: vi.fn(() => false),
}));

import * as clack from '@clack/prompts';
import {
  runUpgradeCommand,
  parseVersion,
  compareVersions,
  detectInstallMethodFromPaths,
  truncateReleaseNotes,
  type ReleaseNotes,
  type UpgradeDependencies,
  type InstallMethod,
  type LatestRelease,
} from '../upgrade.ts';

const mockedConfirm = vi.mocked(clack.confirm);
const mockedIsCancel = vi.mocked(clack.isCancel);

// --- Fixtures ---

function createMockReleaseNotes(overrides?: Partial<ReleaseNotes>): ReleaseNotes {
  return {
    body: 'Bug fixes and improvements.',
    htmlUrl: 'https://github.com/getsentry/MobileBuildMCP/releases/tag/v3.0.0',
    name: 'Release 3.0.0',
    publishedAt: '2025-01-15T12:00:00Z',
    ...overrides,
  };
}

function createMockLatestRelease(overrides?: Partial<LatestRelease>): LatestRelease {
  return {
    tag: 'v3.0.0',
    version: '3.0.0',
    ...overrides,
  };
}

function mockGitHubLatestRelease(tagName: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        tag_name: tagName,
      }),
    ),
  );
}

function homebrewMethod(): InstallMethod {
  return {
    kind: 'homebrew',
    manualCommand: 'brew update && brew upgrade mobilebuildmcp',
    autoCommands: [
      ['brew', 'update'],
      ['brew', 'upgrade', 'mobilebuildmcp'],
    ],
  };
}

function npmGlobalMethod(): InstallMethod {
  return {
    kind: 'npm-global',
    manualCommand: 'npm install -g mobilebuildmcp@latest',
    autoCommands: [['npm', 'install', '-g', 'mobilebuildmcp@latest']],
  };
}

function npxMethod(): InstallMethod {
  return {
    kind: 'npx',
    manualInstructions: [
      'npx always fetches the latest version by default when using @latest.',
      'If you pinned a specific version, update the version in your MCP client config.',
    ],
  };
}

function unknownMethod(): InstallMethod {
  return {
    kind: 'unknown',
    manualInstructions: [
      'Homebrew:   brew update && brew upgrade mobilebuildmcp',
      'npm:        npm install -g mobilebuildmcp@latest',
      'npx:        npx always fetches the latest when using @latest',
    ],
  };
}

function baseDeps(overrides?: Partial<UpgradeDependencies>): Partial<UpgradeDependencies> {
  return {
    currentVersion: '2.0.0',
    packageName: 'mobilebuildmcp',
    repositoryOwner: 'getsentry',
    repositoryName: 'MobileBuildMCP',
    fetchLatestRelease: vi.fn(async () => createMockLatestRelease()),
    fetchReleaseNotesForTag: vi.fn(async () => createMockReleaseNotes()),
    detectInstallMethod: vi.fn(() => homebrewMethod()),
    spawnUpgradeProcess: vi.fn(async () => 0),
    isInteractive: vi.fn(() => false),
    ...overrides,
  };
}

function collectStdout(spy: MockInstance): string {
  return spy.mock.calls.map((c) => String(c[0])).join('');
}

function collectStderr(spy: MockInstance): string {
  return spy.mock.calls.map((c) => String(c[0])).join('');
}

// --- Tests ---

describe('upgrade command', () => {
  let stdoutSpy: MockInstance;
  let stderrSpy: MockInstance;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    mockedConfirm.mockResolvedValue(true);
    mockedIsCancel.mockReturnValue(false);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // ── Pure helpers ──────────────────────────────────────────────────────

  describe('parseVersion', () => {
    it('parses standard version', () => {
      expect(parseVersion('1.2.3')).toEqual({
        major: 1,
        minor: 2,
        patch: 3,
        prerelease: undefined,
      });
    });

    it('strips leading v', () => {
      expect(parseVersion('v1.2.3')).toEqual({
        major: 1,
        minor: 2,
        patch: 3,
        prerelease: undefined,
      });
    });

    it('parses prerelease suffix', () => {
      expect(parseVersion('1.2.3-beta.1')).toEqual({
        major: 1,
        minor: 2,
        patch: 3,
        prerelease: 'beta.1',
      });
    });

    it('ignores build metadata', () => {
      expect(parseVersion('1.2.3+build.42')).toEqual({
        major: 1,
        minor: 2,
        patch: 3,
        prerelease: undefined,
      });
    });

    it('parses prerelease with build metadata', () => {
      expect(parseVersion('1.2.3-rc.1+build')).toEqual({
        major: 1,
        minor: 2,
        patch: 3,
        prerelease: 'rc.1',
      });
    });

    it('parses prerelease with hyphenated identifier', () => {
      expect(parseVersion('1.0.0-alpha-1')).toEqual({
        major: 1,
        minor: 0,
        patch: 0,
        prerelease: 'alpha-1',
      });
    });

    it('parses hyphenated prerelease with hyphenated build metadata', () => {
      expect(parseVersion('1.0.0-rc-1+build-hash')).toEqual({
        major: 1,
        minor: 0,
        patch: 0,
        prerelease: 'rc-1',
      });
    });

    it.each([['not-a-version'], ['1.2'], [''], ['1.2.3.4'], ['abc.def.ghi']])(
      'returns undefined for malformed input %j',
      (input) => {
        expect(parseVersion(input)).toBeUndefined();
      },
    );
  });

  describe('compareVersions', () => {
    it('detects equal versions', () => {
      expect(
        compareVersions(
          { major: 1, minor: 2, patch: 3, prerelease: undefined },
          { major: 1, minor: 2, patch: 3, prerelease: undefined },
        ),
      ).toBe('equal');
    });

    it('detects older by major', () => {
      expect(
        compareVersions(
          { major: 1, minor: 0, patch: 0, prerelease: undefined },
          { major: 2, minor: 0, patch: 0, prerelease: undefined },
        ),
      ).toBe('older');
    });

    it('detects newer by minor', () => {
      expect(
        compareVersions(
          { major: 1, minor: 5, patch: 0, prerelease: undefined },
          { major: 1, minor: 3, patch: 0, prerelease: undefined },
        ),
      ).toBe('newer');
    });

    it('detects older by patch', () => {
      expect(
        compareVersions(
          { major: 1, minor: 2, patch: 3, prerelease: undefined },
          { major: 1, minor: 2, patch: 5, prerelease: undefined },
        ),
      ).toBe('older');
    });

    it('prerelease is older than release at same version', () => {
      expect(
        compareVersions(
          { major: 1, minor: 0, patch: 0, prerelease: 'beta.1' },
          { major: 1, minor: 0, patch: 0, prerelease: undefined },
        ),
      ).toBe('older');
    });

    it('release is newer than prerelease at same version', () => {
      expect(
        compareVersions(
          { major: 1, minor: 0, patch: 0, prerelease: undefined },
          { major: 1, minor: 0, patch: 0, prerelease: 'beta.1' },
        ),
      ).toBe('newer');
    });

    it('compares numeric prerelease identifiers numerically', () => {
      expect(
        compareVersions(
          { major: 1, minor: 0, patch: 0, prerelease: 'beta.2' },
          { major: 1, minor: 0, patch: 0, prerelease: 'beta.10' },
        ),
      ).toBe('older');
    });

    it('compares string prerelease identifiers lexicographically', () => {
      expect(
        compareVersions(
          { major: 1, minor: 0, patch: 0, prerelease: 'alpha' },
          { major: 1, minor: 0, patch: 0, prerelease: 'beta' },
        ),
      ).toBe('older');
    });

    it('compares prerelease identifiers in ASCII order (uppercase before lowercase)', () => {
      expect(
        compareVersions(
          { major: 1, minor: 0, patch: 0, prerelease: 'Alpha' },
          { major: 1, minor: 0, patch: 0, prerelease: 'alpha' },
        ),
      ).toBe('older');
    });

    it('numeric prerelease identifier is less than string identifier', () => {
      expect(
        compareVersions(
          { major: 1, minor: 0, patch: 0, prerelease: '1' },
          { major: 1, minor: 0, patch: 0, prerelease: 'alpha' },
        ),
      ).toBe('older');
    });

    it('fewer prerelease parts is less than more parts', () => {
      expect(
        compareVersions(
          { major: 1, minor: 0, patch: 0, prerelease: 'beta' },
          { major: 1, minor: 0, patch: 0, prerelease: 'beta.1' },
        ),
      ).toBe('older');
    });

    it('equal prerelease identifiers are equal', () => {
      expect(
        compareVersions(
          { major: 1, minor: 0, patch: 0, prerelease: 'rc.1' },
          { major: 1, minor: 0, patch: 0, prerelease: 'rc.1' },
        ),
      ).toBe('equal');
    });
  });

  describe('detectInstallMethodFromPaths', () => {
    it('detects homebrew on Intel Mac (/usr/local/Cellar)', () => {
      const method = detectInstallMethodFromPaths('mobilebuildmcp', [
        '/usr/local/Cellar/mobilebuildmcp/2.0.0/bin/mobilebuildmcp',
      ]);
      expect(method.kind).toBe('homebrew');
    });

    it('detects homebrew on Apple Silicon (/opt/homebrew/Cellar)', () => {
      const method = detectInstallMethodFromPaths('mobilebuildmcp', [
        '/opt/homebrew/Cellar/mobilebuildmcp/2.0.0/bin/mobilebuildmcp',
      ]);
      expect(method.kind).toBe('homebrew');
    });

    it('produces correct homebrew auto commands', () => {
      const method = detectInstallMethodFromPaths('mobilebuildmcp', [
        '/opt/homebrew/Cellar/mobilebuildmcp/2.0.0/bin/mobilebuildmcp',
      ]);
      expect(method.kind).toBe('homebrew');
      if (method.kind === 'homebrew') {
        expect(method.autoCommands).toEqual([
          ['brew', 'update'],
          ['brew', 'upgrade', 'mobilebuildmcp'],
        ]);
      }
    });

    it('detects npm-global install', () => {
      const method = detectInstallMethodFromPaths('mobilebuildmcp', [
        '/usr/local/lib/node_modules/mobilebuildmcp/build/cli.js',
      ]);
      expect(method.kind).toBe('npm-global');
      if (method.kind === 'npm-global') {
        expect(method.autoCommands).toEqual([['npm', 'install', '-g', 'mobilebuildmcp@latest']]);
      }
    });

    it('detects npx from _npx cache path', () => {
      const method = detectInstallMethodFromPaths('mobilebuildmcp', [
        '/Users/cam/.npm/_npx/abc123/node_modules/mobilebuildmcp/build/cli.js',
      ]);
      expect(method.kind).toBe('npx');
    });

    it('classifies npx before npm-global when path contains _npx and node_modules', () => {
      const method = detectInstallMethodFromPaths('mobilebuildmcp', [
        '/Users/cam/.npm/_npx/12345/node_modules/mobilebuildmcp/build/cli.js',
      ]);
      expect(method.kind).toBe('npx');
    });

    it('returns unknown for unrecognized paths', () => {
      const method = detectInstallMethodFromPaths('mobilebuildmcp', [
        '/some/custom/path/mobilebuildmcp',
      ]);
      expect(method.kind).toBe('unknown');
    });

    it('returns unknown for empty candidate list', () => {
      const method = detectInstallMethodFromPaths('mobilebuildmcp', []);
      expect(method.kind).toBe('unknown');
    });

    it('matches case-insensitively', () => {
      const method = detectInstallMethodFromPaths('mobilebuildmcp', [
        '/opt/Homebrew/Cellar/MobileBuildMCP/2.0.0/bin/mobilebuildmcp',
      ]);
      expect(method.kind).toBe('homebrew');
    });
  });

  describe('truncateReleaseNotes', () => {
    const url = 'https://example.com/release';

    it('returns full text when under both limits', () => {
      const body = 'Line 1\nLine 2\nLine 3';
      const result = truncateReleaseNotes(body, url);
      expect(result).not.toContain('(truncated)');
      expect(result).toContain('Line 1\nLine 2\nLine 3');
      expect(result).toContain(`Full release notes: ${url}`);
    });

    it('truncates at 20 lines', () => {
      const lines = Array.from({ length: 30 }, (_, i) => `Line ${i + 1}`);
      const body = lines.join('\n');
      const result = truncateReleaseNotes(body, url);
      expect(result).toContain('... (truncated)');
      expect(result).toContain('Line 20');
      expect(result).not.toContain('Line 21');
    });

    it('truncates at 2000 characters', () => {
      const longLine = 'x'.repeat(300);
      const lines = Array.from({ length: 10 }, () => longLine);
      const body = lines.join('\n');
      const result = truncateReleaseNotes(body, url);
      expect(result).toContain('... (truncated)');
      const beforeMarker = result.split('\n\n... (truncated)')[0];
      expect(beforeMarker.length).toBeLessThanOrEqual(2000);
    });

    it('returns only the URL for empty body', () => {
      const result = truncateReleaseNotes('', url);
      expect(result).toBe(`Full release notes: ${url}`);
    });

    it('normalizes CRLF line endings', () => {
      const body = 'Line 1\r\nLine 2\r\nLine 3';
      const result = truncateReleaseNotes(body, url);
      expect(result).toContain('Line 1\nLine 2\nLine 3');
      expect(result).not.toContain('\r');
    });
  });

  // ── Command flow ──────────────────────────────────────────────────────

  describe('runUpgradeCommand', () => {
    describe('up to date', () => {
      it('exits 0 when versions match (non-TTY)', async () => {
        const deps = baseDeps({
          currentVersion: '3.0.0',
          fetchLatestRelease: vi.fn(async () => createMockLatestRelease()),
        });

        const code = await runUpgradeCommand({ check: false, yes: false }, deps);
        expect(code).toBe(0);
        expect(collectStdout(stdoutSpy)).toContain('Already up to date');
      });

      it('exits 0 when versions match (TTY)', async () => {
        const deps = baseDeps({
          currentVersion: '3.0.0',
          fetchLatestRelease: vi.fn(async () => createMockLatestRelease()),
          isInteractive: vi.fn(() => true),
        });

        const code = await runUpgradeCommand({ check: false, yes: false }, deps);
        expect(code).toBe(0);
        expect(clack.log.success).toHaveBeenCalledWith(
          expect.stringContaining('Already up to date'),
        );
      });
    });

    describe('local version newer', () => {
      it('exits 0 without offering a downgrade', async () => {
        const spawnMock = vi.fn(async () => 0);
        const deps = baseDeps({
          currentVersion: '4.0.0',
          fetchLatestRelease: vi.fn(async () => createMockLatestRelease()),
          spawnUpgradeProcess: spawnMock,
        });

        const code = await runUpgradeCommand({ check: false, yes: false }, deps);
        expect(code).toBe(0);
        expect(collectStdout(stdoutSpy)).toContain('ahead of latest');
        expect(spawnMock).not.toHaveBeenCalled();
      });
    });

    describe('--check mode', () => {
      it('exits 0 and shows update info without upgrading (non-TTY)', async () => {
        const spawnMock = vi.fn(async () => 0);
        const deps = baseDeps({ spawnUpgradeProcess: spawnMock });

        const code = await runUpgradeCommand({ check: true, yes: false }, deps);
        expect(code).toBe(0);
        expect(collectStdout(stdoutSpy)).toContain('Update available');
        expect(spawnMock).not.toHaveBeenCalled();
      });

      it('exits 0 in TTY mode without prompting', async () => {
        const deps = baseDeps({ isInteractive: vi.fn(() => true) });

        const code = await runUpgradeCommand({ check: true, yes: false }, deps);
        expect(code).toBe(0);
        expect(clack.confirm).not.toHaveBeenCalled();
      });

      it('--check overrides --yes', async () => {
        const spawnMock = vi.fn(async () => 0);
        const deps = baseDeps({ spawnUpgradeProcess: spawnMock });

        const code = await runUpgradeCommand({ check: true, yes: true }, deps);
        expect(code).toBe(0);
        expect(spawnMock).not.toHaveBeenCalled();
      });
    });

    describe('homebrew install method', () => {
      it('runs upgrade with --yes and verifies exact argv arrays', async () => {
        const spawnMock = vi.fn(async () => 0);
        const deps = baseDeps({
          detectInstallMethod: vi.fn(() => homebrewMethod()),
          spawnUpgradeProcess: spawnMock,
        });

        const code = await runUpgradeCommand({ check: false, yes: true }, deps);
        expect(code).toBe(0);
        expect(spawnMock).toHaveBeenCalledWith([
          ['brew', 'update'],
          ['brew', 'upgrade', 'mobilebuildmcp'],
        ]);
      });

      it('prompts in TTY and runs upgrade when confirmed', async () => {
        mockedConfirm.mockResolvedValue(true);
        const spawnMock = vi.fn(async () => 0);
        const deps = baseDeps({
          isInteractive: vi.fn(() => true),
          detectInstallMethod: vi.fn(() => homebrewMethod()),
          spawnUpgradeProcess: spawnMock,
        });

        const code = await runUpgradeCommand({ check: false, yes: false }, deps);
        expect(code).toBe(0);
        expect(clack.confirm).toHaveBeenCalled();
        expect(spawnMock).toHaveBeenCalled();
      });

      it('exits 0 without running when TTY confirm is declined', async () => {
        mockedConfirm.mockResolvedValue(false);
        const spawnMock = vi.fn(async () => 0);
        const deps = baseDeps({
          isInteractive: vi.fn(() => true),
          detectInstallMethod: vi.fn(() => homebrewMethod()),
          spawnUpgradeProcess: spawnMock,
        });

        const code = await runUpgradeCommand({ check: false, yes: false }, deps);
        expect(code).toBe(0);
        expect(spawnMock).not.toHaveBeenCalled();
      });

      it('exits 0 without running when TTY confirm is cancelled', async () => {
        mockedConfirm.mockResolvedValue(Symbol('cancel') as unknown as boolean);
        mockedIsCancel.mockReturnValue(true);
        const spawnMock = vi.fn(async () => 0);
        const deps = baseDeps({
          isInteractive: vi.fn(() => true),
          detectInstallMethod: vi.fn(() => homebrewMethod()),
          spawnUpgradeProcess: spawnMock,
        });

        const code = await runUpgradeCommand({ check: false, yes: false }, deps);
        expect(code).toBe(0);
        expect(spawnMock).not.toHaveBeenCalled();
      });

      it('non-TTY without --yes exits 1 and suggests --yes', async () => {
        const spawnMock = vi.fn(async () => 0);
        const deps = baseDeps({
          detectInstallMethod: vi.fn(() => homebrewMethod()),
          spawnUpgradeProcess: spawnMock,
        });

        const code = await runUpgradeCommand({ check: false, yes: false }, deps);
        expect(code).toBe(1);
        expect(spawnMock).not.toHaveBeenCalled();
        expect(collectStdout(stdoutSpy)).toContain('--yes');
      });

      it('propagates non-zero exit code from upgrade process', async () => {
        const spawnMock = vi.fn(async () => 42);
        const deps = baseDeps({
          detectInstallMethod: vi.fn(() => homebrewMethod()),
          spawnUpgradeProcess: spawnMock,
        });

        const code = await runUpgradeCommand({ check: false, yes: true }, deps);
        expect(code).toBe(42);
      });
    });

    describe('npm-global install method', () => {
      it('runs upgrade with --yes and verifies exact argv array', async () => {
        const spawnMock = vi.fn(async () => 0);
        const deps = baseDeps({
          detectInstallMethod: vi.fn(() => npmGlobalMethod()),
          spawnUpgradeProcess: spawnMock,
        });

        const code = await runUpgradeCommand({ check: false, yes: true }, deps);
        expect(code).toBe(0);
        expect(spawnMock).toHaveBeenCalledWith([['npm', 'install', '-g', 'mobilebuildmcp@latest']]);
      });

      it('non-TTY without --yes exits 1', async () => {
        const spawnMock = vi.fn(async () => 0);
        const deps = baseDeps({
          detectInstallMethod: vi.fn(() => npmGlobalMethod()),
          spawnUpgradeProcess: spawnMock,
        });

        const code = await runUpgradeCommand({ check: false, yes: false }, deps);
        expect(code).toBe(1);
        expect(spawnMock).not.toHaveBeenCalled();
      });

      it('prompts in TTY and runs upgrade when confirmed', async () => {
        mockedConfirm.mockResolvedValue(true);
        const spawnMock = vi.fn(async () => 0);
        const deps = baseDeps({
          isInteractive: vi.fn(() => true),
          detectInstallMethod: vi.fn(() => npmGlobalMethod()),
          spawnUpgradeProcess: spawnMock,
        });

        const code = await runUpgradeCommand({ check: false, yes: false }, deps);
        expect(code).toBe(0);
        expect(spawnMock).toHaveBeenCalled();
      });
    });

    describe('npx install method', () => {
      it('exits 0 with --yes without spawning', async () => {
        const spawnMock = vi.fn(async () => 0);
        const deps = baseDeps({
          detectInstallMethod: vi.fn(() => npxMethod()),
          spawnUpgradeProcess: spawnMock,
        });

        const code = await runUpgradeCommand({ check: false, yes: true }, deps);
        expect(code).toBe(0);
        expect(spawnMock).not.toHaveBeenCalled();
      });

      it('explains ephemeral install limitation (non-TTY)', async () => {
        const deps = baseDeps({
          detectInstallMethod: vi.fn(() => npxMethod()),
        });

        const code = await runUpgradeCommand({ check: false, yes: false }, deps);
        expect(code).toBe(0);
        expect(collectStdout(stdoutSpy)).toContain('npx always fetches the latest');
      });

      it('explains ephemeral install limitation (TTY)', async () => {
        const deps = baseDeps({
          isInteractive: vi.fn(() => true),
          detectInstallMethod: vi.fn(() => npxMethod()),
        });

        const code = await runUpgradeCommand({ check: false, yes: false }, deps);
        expect(code).toBe(0);
        expect(clack.log.info).toHaveBeenCalledWith(
          expect.stringContaining('npx always fetches the latest'),
        );
      });
    });

    describe('unknown install method', () => {
      it('exits 0 and shows manual options', async () => {
        const spawnMock = vi.fn(async () => 0);
        const deps = baseDeps({
          detectInstallMethod: vi.fn(() => unknownMethod()),
          spawnUpgradeProcess: spawnMock,
        });

        const code = await runUpgradeCommand({ check: false, yes: false }, deps);
        expect(code).toBe(0);
        expect(spawnMock).not.toHaveBeenCalled();
        expect(collectStdout(stdoutSpy)).toContain('Could not detect install method');
      });

      it('no auto-run even with --yes', async () => {
        const spawnMock = vi.fn(async () => 0);
        const deps = baseDeps({
          detectInstallMethod: vi.fn(() => unknownMethod()),
          spawnUpgradeProcess: spawnMock,
        });

        const code = await runUpgradeCommand({ check: false, yes: true }, deps);
        expect(code).toBe(0);
        expect(spawnMock).not.toHaveBeenCalled();
      });
    });

    describe('channel lookup failures', () => {
      it('exits 1 on network error', async () => {
        const deps = baseDeps({
          fetchLatestRelease: vi.fn(async () => {
            throw new Error("couldn't determine latest version from npm: fetch failed");
          }),
        });

        const code = await runUpgradeCommand({ check: false, yes: false }, deps);
        expect(code).toBe(1);
        expect(collectStderr(stderrSpy)).toContain('fetch failed');
      });

      it('exits 1 on timeout', async () => {
        const deps = baseDeps({
          fetchLatestRelease: vi.fn(async () => {
            throw new Error("couldn't determine latest version from npm: request timed out");
          }),
        });

        const code = await runUpgradeCommand({ check: false, yes: false }, deps);
        expect(code).toBe(1);
        expect(collectStderr(stderrSpy)).toContain('timed out');
      });

      it('exits 1 on rate limit', async () => {
        const deps = baseDeps({
          fetchLatestRelease: vi.fn(async () => {
            throw new Error("couldn't determine latest version from GitHub: rate limit exceeded");
          }),
        });

        const code = await runUpgradeCommand({ check: false, yes: false }, deps);
        expect(code).toBe(1);
        expect(collectStderr(stderrSpy)).toContain('rate limit');
      });

      it('exits 1 on HTTP error', async () => {
        const deps = baseDeps({
          fetchLatestRelease: vi.fn(async () => {
            throw new Error("couldn't determine latest version from GitHub: HTTP 500");
          }),
        });

        const code = await runUpgradeCommand({ check: false, yes: false }, deps);
        expect(code).toBe(1);
        expect(collectStderr(stderrSpy)).toContain('HTTP 500');
      });

      it('exits 1 on missing tag_name', async () => {
        const deps = baseDeps({
          fetchLatestRelease: vi.fn(async () => {
            throw new Error("couldn't determine latest version from GitHub: missing tag_name");
          }),
        });

        const code = await runUpgradeCommand({ check: false, yes: false }, deps);
        expect(code).toBe(1);
        expect(collectStderr(stderrSpy)).toContain('missing tag_name');
      });

      it('shows manual upgrade command on failure when install method is known', async () => {
        const deps = baseDeps({
          fetchLatestRelease: vi.fn(async () => {
            throw new Error("couldn't determine latest version from Homebrew: network error");
          }),
          detectInstallMethod: vi.fn(() => homebrewMethod()),
        });

        const code = await runUpgradeCommand({ check: false, yes: false }, deps);
        expect(code).toBe(1);
        expect(collectStdout(stdoutSpy)).toContain('brew update && brew upgrade mobilebuildmcp');
      });

      it('shows failure info via clack in TTY mode', async () => {
        const deps = baseDeps({
          isInteractive: vi.fn(() => true),
          fetchLatestRelease: vi.fn(async () => {
            throw new Error("couldn't determine latest version from GitHub: missing tag_name");
          }),
        });

        const code = await runUpgradeCommand({ check: false, yes: false }, deps);
        expect(code).toBe(1);
        expect(clack.log.error).toHaveBeenCalledWith(expect.stringContaining('missing tag_name'));
      });
    });

    describe('version parse errors', () => {
      it('exits 1 when current version is malformed', async () => {
        const deps = baseDeps({
          currentVersion: 'bad',
        });

        const code = await runUpgradeCommand({ check: false, yes: false }, deps);
        expect(code).toBe(1);
        expect(collectStderr(stderrSpy)).toContain('Cannot compare versions');
      });

      it('exits 1 when latest version is malformed', async () => {
        const deps = baseDeps({
          fetchLatestRelease: vi.fn(async () =>
            createMockLatestRelease({ version: 'invalid', tag: 'invalid' }),
          ),
        });

        const code = await runUpgradeCommand({ check: false, yes: false }, deps);
        expect(code).toBe(1);
        expect(collectStderr(stderrSpy)).toContain('Cannot compare versions');
      });

      it('exits 1 via clack in TTY mode for malformed versions', async () => {
        const deps = baseDeps({
          isInteractive: vi.fn(() => true),
          currentVersion: 'garbage',
        });

        const code = await runUpgradeCommand({ check: false, yes: false }, deps);
        expect(code).toBe(1);
        expect(clack.log.error).toHaveBeenCalledWith(
          expect.stringContaining('Cannot compare versions'),
        );
      });
    });

    describe('release notes in output', () => {
      it('includes release notes and URL when update is available (non-TTY)', async () => {
        const deps = baseDeps({
          fetchReleaseNotesForTag: vi.fn(async () =>
            createMockReleaseNotes({ body: 'Fixed a critical bug.' }),
          ),
        });

        await runUpgradeCommand({ check: true, yes: false }, deps);
        const stdout = collectStdout(stdoutSpy);
        expect(stdout).toContain('Fixed a critical bug.');
        expect(stdout).toContain('Full release notes:');
      });

      it('includes published date when available', async () => {
        const deps = baseDeps({
          fetchReleaseNotesForTag: vi.fn(async () =>
            createMockReleaseNotes({ publishedAt: '2025-06-01T10:00:00Z' }),
          ),
        });

        await runUpgradeCommand({ check: true, yes: false }, deps);
        expect(collectStdout(stdoutSpy)).toContain('Published: 2025-06-01');
      });

      it('shows fallback URL when notes return null (tag not released)', async () => {
        const deps = baseDeps({
          fetchReleaseNotesForTag: vi.fn(async () => null),
        });

        await runUpgradeCommand({ check: true, yes: false }, deps);
        const stdout = collectStdout(stdoutSpy);
        expect(stdout).toContain('Release notes:');
        expect(stdout).toContain('github.com');
      });

      it('continues without notes when fetch throws (network failure)', async () => {
        const deps = baseDeps({
          fetchReleaseNotesForTag: vi.fn(async () => {
            throw new Error('network error');
          }),
        });

        const code = await runUpgradeCommand({ check: true, yes: false }, deps);
        expect(code).toBe(0);
        expect(collectStdout(stdoutSpy)).toContain('Update available');
        expect(collectStdout(stdoutSpy)).toContain('Release notes:');
      });
    });

    // ── Canonical latest release lookup ───────────────────────────────

    describe('canonical latest release lookup', () => {
      it.each([
        ['homebrew', homebrewMethod],
        ['npm-global', npmGlobalMethod],
        ['npx', npxMethod],
        ['unknown', unknownMethod],
      ] as const)('uses GitHub latest release for %s installs', async (_name, methodFactory) => {
        mockGitHubLatestRelease('v3.0.0');
        const deps: Partial<UpgradeDependencies> = {
          currentVersion: '2.0.0',
          packageName: 'mobilebuildmcp',
          repositoryOwner: 'getsentry',
          repositoryName: 'MobileBuildMCP',
          fetchReleaseNotesForTag: vi.fn(async (tag) =>
            createMockReleaseNotes({
              body: `Notes for ${tag}`,
              htmlUrl: `https://github.com/getsentry/MobileBuildMCP/releases/tag/${tag}`,
              name: `Release ${tag}`,
            }),
          ),
          detectInstallMethod: vi.fn(() => methodFactory()),
          spawnUpgradeProcess: vi.fn(async () => 0),
          isInteractive: vi.fn(() => false),
        };

        const code = await runUpgradeCommand({ check: true, yes: false }, deps);
        const stdout = collectStdout(stdoutSpy);

        expect(code).toBe(0);
        expect(stdout).toContain('Update available: 2.0.0 → 3.0.0');
        expect(stdout).toContain('Notes for v3.0.0');
        expect(stdout).not.toContain('1.6.0');
      });

      it('preserves the exact GitHub tag when fetching release notes', async () => {
        mockGitHubLatestRelease('3.0.0');
        const fetchReleaseNotesForTag = vi.fn(async (tag: string) =>
          createMockReleaseNotes({
            htmlUrl: `https://github.com/getsentry/MobileBuildMCP/releases/tag/${tag}`,
          }),
        );
        const deps: Partial<UpgradeDependencies> = {
          currentVersion: '2.0.0',
          packageName: 'mobilebuildmcp',
          repositoryOwner: 'getsentry',
          repositoryName: 'MobileBuildMCP',
          fetchReleaseNotesForTag,
          detectInstallMethod: vi.fn(() => homebrewMethod()),
          spawnUpgradeProcess: vi.fn(async () => 0),
          isInteractive: vi.fn(() => false),
        };

        const code = await runUpgradeCommand({ check: true, yes: false }, deps);

        expect(code).toBe(0);
        expect(fetchReleaseNotesForTag).toHaveBeenCalledWith('3.0.0');
        expect(collectStdout(stdoutSpy)).toContain('Update available: 2.0.0 → 3.0.0');
      });

      it.each([
        ['homebrew', homebrewMethod],
        ['npm-global', npmGlobalMethod],
        ['npx', npxMethod],
        ['unknown', unknownMethod],
      ] as const)(
        'reports GitHub latest lookup failures for %s installs',
        async (_name, methodFactory) => {
          vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response(null, { status: 500 })),
          );
          const deps: Partial<UpgradeDependencies> = {
            currentVersion: '2.0.0',
            packageName: 'mobilebuildmcp',
            repositoryOwner: 'getsentry',
            repositoryName: 'MobileBuildMCP',
            fetchReleaseNotesForTag: vi.fn(async () => createMockReleaseNotes()),
            detectInstallMethod: vi.fn(() => methodFactory()),
            spawnUpgradeProcess: vi.fn(async () => 0),
            isInteractive: vi.fn(() => false),
          };

          const code = await runUpgradeCommand({ check: false, yes: false }, deps);

          expect(code).toBe(1);
          expect(collectStderr(stderrSpy)).toContain('GitHub: HTTP 500');
        },
      );
    });
  });
});
