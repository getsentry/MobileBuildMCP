import { describe, it, expect } from 'vitest';
import { normalizeSnapshotOutput } from '../../snapshot-tests/normalize.ts';

describe('normalizeSnapshotOutput tilde handling', () => {
  it('normalizes MobileBuildMCP ~/ paths to stable workspace-key placeholders', () => {
    const input =
      'Workspace Logs: ~/Library/Developer/MobileBuildMCP/workspaces/Weather-abc123def456/logs\n';
    const result = normalizeSnapshotOutput(input);
    expect(result).toContain(
      '~/Library/Developer/MobileBuildMCP/workspaces/MobileBuildMCP-<HASH>/logs',
    );
    expect(result).not.toContain('Weather-abc123def456');
  });

  it('preserves bare ~ outside path-like values', () => {
    const input = 'Home: ~\nDone\n';
    const result = normalizeSnapshotOutput(input);
    expect(result).toContain('Home: ~');
  });

  it('does not alter tildes that are part of approximate numbers', () => {
    const input = 'Approximately ~50 items\n';
    const result = normalizeSnapshotOutput(input);
    expect(result).toContain('~50');
  });

  it('normalizes duration while preserving progress lines and section breaks', () => {
    const input = [
      'Discovered 2 test(s):',
      '   ExampleTests/testOne',
      '› Linking',
      '› Running tests',
      '',
      '✅ 2 tests passed, 0 skipped (⏱️ 1.0s)',
      '',
    ].join('\n');

    const result = normalizeSnapshotOutput(input);

    expect(result).toContain(
      'Discovered 2 test(s):\n   ExampleTests/testOne\n› Linking\n› Running tests\n\n✅ 2 tests passed, 0 skipped (⏱️ <DURATION>)\n',
    );
  });

  it('normalizes workspace-scoped log paths without flattening the workspace layout', () => {
    const input = [
      'Build Logs: <HOME>/Library/Developer/MobileBuildMCP/workspaces/Weather-abc123def456/logs/build_sim_2026-05-02T12-00-00-000Z_pid1234_abcd1234.log',
      'Runtime Logs: <HOME>/Library/Developer/MobileBuildMCP/workspaces/Weather-abc123def456/logs/io.app_2026-05-02T12-00-00-000Z_helperpid1234_ownerpid5678_abcd1234.log',
      '',
    ].join('\n');

    const result = normalizeSnapshotOutput(input);

    expect(result).toContain(
      'Build Logs: ~/Library/Developer/MobileBuildMCP/workspaces/MobileBuildMCP-<HASH>/logs/build_sim_<TIMESTAMP>_pid<PID>.log',
    );
    expect(result).toContain(
      'Runtime Logs: ~/Library/Developer/MobileBuildMCP/workspaces/MobileBuildMCP-<HASH>/logs/io.app_<TIMESTAMP>_pid<PID>.log',
    );
  });

  it('normalizes workspace-scoped result bundle paths', () => {
    const input =
      'Result Bundle: <HOME>/Library/Developer/MobileBuildMCP/workspaces/Weather-abc123def456/result-bundles/test_macos_2026-05-07T09-58-46-123Z_pid1234_abcd1234.xcresult\n';

    const result = normalizeSnapshotOutput(input);

    expect(result).toContain(
      '~/Library/Developer/MobileBuildMCP/workspaces/MobileBuildMCP-<HASH>/result-bundles/test_macos_<TIMESTAMP>_pid<PID>.xcresult',
    );
    expect(result).not.toContain('Weather-abc123def456');
    expect(result).not.toContain('abcd1234');
  });

  it('normalizes workspace-scoped MobileBuildMCP DerivedData hashes', () => {
    const input =
      'Derived Data: <HOME>/Library/Developer/MobileBuildMCP/workspaces/Weather-abc123def456/DerivedData/CalculatorApp-22d700c6d603\n';

    const result = normalizeSnapshotOutput(input);

    expect(result).toContain(
      '~/Library/Developer/MobileBuildMCP/workspaces/MobileBuildMCP-<HASH>/DerivedData/CalculatorApp-<HASH>',
    );
    expect(result).not.toContain('Weather-abc123def456');
    expect(result).not.toContain('22d700c6d603');
  });

  it('normalizes workspace-scoped DerivedData root with no trailing path', () => {
    const input =
      'Derived Data: <HOME>/Library/Developer/MobileBuildMCP/workspaces/MobileBuildMCP-c5da0cbe19a7/DerivedData\n';

    const result = normalizeSnapshotOutput(input);

    expect(result).toContain(
      '~/Library/Developer/MobileBuildMCP/workspaces/MobileBuildMCP-<HASH>/DerivedData\n',
    );
    expect(result).not.toContain('c5da0cbe19a7');
  });
});
