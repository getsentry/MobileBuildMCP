import { describe, expect, it } from 'vitest';
import {
  assertCliSnapshotProcessResult,
  resolveCliJsonSnapshotErrorState,
  resolveCliJsonSnapshotOutcome,
} from '../harness.ts';
import { resolveMcpSnapshotOutcome } from '../mcp-harness.ts';
import type { StructuredOutputEnvelope } from '../../types/structured-output.ts';

const successEnvelope: StructuredOutputEnvelope<null> = {
  schema: 'mobilebuildmcp.output.error',
  schemaVersion: '1',
  didError: false,
  error: null,
  data: null,
};

const errorEnvelope: StructuredOutputEnvelope<null> = {
  ...successEnvelope,
  didError: true,
  error: 'Failed',
};

describe('CLI snapshot process result guard', () => {
  it('accepts completed domain invocations without process stderr', () => {
    expect(() =>
      assertCliSnapshotProcessResult(
        { error: undefined, signal: null, status: 1, stderr: '' },
        'tool',
      ),
    ).not.toThrow();
  });

  it('rejects process stderr so domain snapshots cannot hide user-visible noise', () => {
    expect(() =>
      assertCliSnapshotProcessResult(
        { error: undefined, signal: null, status: 0, stderr: 'warning\n' },
        'tool',
      ),
    ).toThrow('CLI process emitted unexpected stderr for tool:\nwarning');
  });

  it('rejects failed process execution before snapshot matching', () => {
    expect(() =>
      assertCliSnapshotProcessResult(
        { error: new Error('spawn failed'), signal: null, status: null, stderr: '' },
        'tool',
      ),
    ).toThrow('CLI process failed for tool: spawn failed');

    expect(() =>
      assertCliSnapshotProcessResult(
        { error: undefined, signal: 'SIGTERM', status: null, stderr: '' },
        'tool',
      ),
    ).toThrow('CLI process for tool was terminated by signal SIGTERM.');
  });
});

describe('JSON snapshot harness error state', () => {
  it('uses CLI process status and envelope.didError when they agree', () => {
    expect(resolveCliJsonSnapshotErrorState(0, successEnvelope, 'tool')).toBe(false);
    expect(resolveCliJsonSnapshotErrorState(1, errorEnvelope, 'tool')).toBe(true);
    expect(resolveCliJsonSnapshotOutcome(0, successEnvelope, 'tool')).toBe('success');
    expect(resolveCliJsonSnapshotOutcome(1, errorEnvelope, 'tool')).toBe('domain-error');
  });

  it('rejects null CLI process status', () => {
    expect(() => resolveCliJsonSnapshotErrorState(null, successEnvelope, 'tool')).toThrow(
      'CLI process exit status was null for tool; the process may have timed out or been killed by a signal.',
    );
  });

  it('rejects CLI process status and envelope.didError disagreement', () => {
    expect(() => resolveCliJsonSnapshotErrorState(1, successEnvelope, 'tool')).toThrow(
      'CLI process exit status (1) disagrees with envelope.didError (false)',
    );
    expect(() => resolveCliJsonSnapshotErrorState(0, errorEnvelope, 'tool')).toThrow(
      'CLI process exit status (0) disagrees with envelope.didError (true)',
    );
  });

  it('uses MCP transport isError and structuredContent.didError when they agree', () => {
    expect(resolveMcpSnapshotOutcome(false, false, 'tool')).toBe('success');
    expect(resolveMcpSnapshotOutcome(true, true, 'tool')).toBe('domain-error');
  });

  it('classifies an MCP error without a domain envelope as an infrastructure failure', () => {
    expect(resolveMcpSnapshotOutcome(true, undefined, 'tool')).toBe('infrastructure-error');
  });

  it('classifies MCP argument validation separately from infrastructure failures', () => {
    expect(
      resolveMcpSnapshotOutcome(
        true,
        undefined,
        'tool',
        'MCP error -32602: Input validation error: Invalid arguments for tool',
      ),
    ).toBe('validation-error');
  });

  it('rejects MCP transport isError and structuredContent.didError disagreement', () => {
    expect(() => resolveMcpSnapshotOutcome(true, false, 'tool')).toThrow(
      'MCP result.isError (true) disagrees with structuredContent.didError (false)',
    );
    expect(() => resolveMcpSnapshotOutcome(false, true, 'tool')).toThrow(
      'MCP result.isError (false) disagrees with structuredContent.didError (true)',
    );
    expect(() => resolveMcpSnapshotOutcome(undefined, true, 'tool')).toThrow(
      'MCP result.isError (undefined) disagrees with structuredContent.didError (true)',
    );
  });
});
