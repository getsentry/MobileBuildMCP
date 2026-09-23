import { describe, expect, it } from 'vitest';
import { toStructuredEnvelope } from '../structured-output-envelope.ts';
import type {
  BuildResultDomainResult,
  CaptureResultDomainResult,
  DeviceListDomainResult,
} from '../../types/domain-results.ts';
import { COMPACT_RUNTIME_TARGET_LIMIT } from '../../types/ui-snapshot.ts';

describe('toStructuredEnvelope', () => {
  it('strips kind, didError, and error from the data payload', () => {
    const result: DeviceListDomainResult = {
      kind: 'device-list',
      didError: false,
      error: null,
      devices: [
        {
          name: 'iPhone 16',
          deviceId: 'DEVICE-1',
          platform: 'iOS',
          state: 'connected',
          isAvailable: true,
          osVersion: '18.0',
        },
      ],
    };

    expect(toStructuredEnvelope(result, 'mobilebuildmcp.output.device-list', '1')).toEqual({
      schema: 'mobilebuildmcp.output.device-list',
      schemaVersion: '1',
      didError: false,
      error: null,
      data: {
        devices: result.devices,
      },
    });
  });

  it('uses null data when the domain result has no schema payload fields', () => {
    const result: BuildResultDomainResult = {
      kind: 'build-result',
      didError: true,
      error: 'Build failed',
    };

    expect(toStructuredEnvelope(result, 'mobilebuildmcp.output.build-result', '1')).toEqual({
      schema: 'mobilebuildmcp.output.build-result',
      schemaVersion: '1',
      didError: true,
      error: 'Build failed',
      data: null,
    });
  });

  it('omits nextSteps when no next steps are provided', () => {
    const result: DeviceListDomainResult = {
      kind: 'device-list',
      didError: false,
      error: null,
      devices: [],
    };

    expect(
      toStructuredEnvelope(result, 'mobilebuildmcp.output.device-list', '1', {
        nextSteps: [],
      }),
    ).toEqual({
      schema: 'mobilebuildmcp.output.device-list',
      schemaVersion: '1',
      didError: false,
      error: null,
      data: { devices: [] },
    });
  });

  it('does not serialize next steps on error envelopes', () => {
    const result: BuildResultDomainResult = {
      kind: 'build-result',
      didError: true,
      error: 'Build failed',
    };

    expect(
      toStructuredEnvelope(result, 'mobilebuildmcp.output.error', '1', {
        nextSteps: [
          {
            label: 'Retry build',
            tool: 'build_sim',
            params: { simulatorId: 'SIMULATOR-1' },
          },
        ],
      }),
    ).toEqual({
      schema: 'mobilebuildmcp.output.error',
      schemaVersion: '1',
      didError: true,
      error: 'Build failed',
      data: null,
    });
  });

  it('compacts runtime snapshots inside the capture payload by default', () => {
    const result: CaptureResultDomainResult = {
      kind: 'capture-result',
      didError: false,
      error: null,
      summary: { status: 'SUCCEEDED' },
      artifacts: { simulatorId: 'SIMULATOR-1' },
      waitMatch: {
        predicate: 'exists',
        matches: [
          {
            ref: 'e2',
            role: 'button',
            label: 'Overview',
            identifier: 'app.primaryButton',
            frame: { x: 12, y: 81, width: 178, height: 33 },
            actions: ['tap', 'longPress', 'touch'],
          },
        ],
      },
      capture: {
        type: 'runtime-snapshot',
        protocol: 'rs/1',
        simulatorId: 'SIMULATOR-1',
        screenHash: 'screen-one',
        seq: 1,
        capturedAtMs: 1_000,
        expiresAtMs: 61_000,
        elements: [
          {
            ref: 'e1',
            role: 'application',
            label: 'Example',
            frame: { x: 0, y: 0, width: 390, height: 844 },
            actions: ['swipeWithin'],
          },
          {
            ref: 'e2',
            role: 'button',
            label: 'Overview',
            identifier: 'app.primaryButton',
            frame: { x: 12, y: 81, width: 178, height: 33 },
            actions: ['tap', 'longPress', 'touch'],
          },
          {
            ref: 'e3',
            role: 'text',
            label: 'Current reading',
            frame: { x: 24, y: 140, width: 80, height: 24 },
            state: { visible: true },
            actions: ['longPress', 'touch'],
          },
        ],
        actions: [
          { action: 'swipeWithin', elementRef: 'e1', label: 'Example' },
          { action: 'tap', elementRef: 'e2', label: 'Overview' },
        ],
      },
    };

    expect(toStructuredEnvelope(result, 'mobilebuildmcp.output.capture-result', '2')).toEqual({
      schema: 'mobilebuildmcp.output.capture-result',
      schemaVersion: '2',
      didError: false,
      error: null,
      data: {
        summary: { status: 'SUCCEEDED' },
        artifacts: { simulatorId: 'SIMULATOR-1' },
        capture: {
          type: 'runtime-snapshot',
          rs: '1',
          screenHash: 'screen-one',
          seq: 1,
          count: 3,
          targets: ['e2|tap|button|Overview||app.primaryButton'],
          scroll: ['e1|swipe|application|Example||'],
          text: ['e3|text|text|Current reading||'],
          udid: 'SIMULATOR-1',
        },
        waitMatch: {
          predicate: 'exists',
          matches: ['e2|tap|button|Overview||app.primaryButton'],
        },
      },
    });
  });

  it('preserves actionable targets in compact runtime snapshot output', () => {
    const result: CaptureResultDomainResult = {
      kind: 'capture-result',
      didError: false,
      error: null,
      summary: { status: 'SUCCEEDED' },
      artifacts: { simulatorId: 'SIMULATOR-1' },
      capture: {
        type: 'runtime-snapshot',
        protocol: 'rs/1',
        simulatorId: 'SIMULATOR-1',
        screenHash: 'screen-suppressed',
        seq: 2,
        capturedAtMs: 1_000,
        expiresAtMs: 61_000,
        elements: [
          {
            ref: 'e1',
            role: 'button',
            label: 'Add',
            frame: { x: 12, y: 81, width: 80, height: 44 },
            actions: ['tap'],
          },
          {
            ref: 'e2',
            role: 'button',
            label: 'London, England',
            value: 'not saved',
            frame: { x: 20, y: 140, width: 200, height: 72 },
            state: { visible: true },
            actions: ['tap'],
          },
          {
            ref: 'e3',
            role: 'text',
            label: 'Search results',
            frame: { x: 20, y: 100, width: 120, height: 24 },
            state: { visible: true },
            actions: [],
          },
        ],
        actions: [
          { action: 'tap', elementRef: 'e1', label: 'Add' },
          { action: 'tap', elementRef: 'e2', label: 'London, England' },
        ],
      },
    };

    const envelope = toStructuredEnvelope(result, 'mobilebuildmcp.output.capture-result', '2');
    const data = envelope.data as { capture: { targets: string[]; text: string[] } };

    expect(data.capture.targets).toEqual(
      expect.arrayContaining(['e1|tap|button|Add||', 'e2|tap|button|London, England|not saved|']),
    );
    expect(data.capture.text).toEqual(['e3|text|text|Search results||']);
  });

  it('caps compact runtime snapshot wait matches', () => {
    const matches = Array.from({ length: COMPACT_RUNTIME_TARGET_LIMIT + 16 }, (_, index) => ({
      ref: `e${index + 1}`,
      role: 'button' as const,
      label: `Match ${index + 1}`,
      frame: { x: 0, y: index, width: 100, height: 40 },
      actions: ['tap' as const],
    }));
    const result: CaptureResultDomainResult = {
      kind: 'capture-result',
      didError: false,
      error: null,
      summary: { status: 'SUCCEEDED' },
      artifacts: { simulatorId: 'SIMULATOR-1' },
      waitMatch: { predicate: 'exists', matches },
    };

    const envelope = toStructuredEnvelope(result, 'mobilebuildmcp.output.capture-result', '2');
    const data = envelope.data as { waitMatch: { matches: string[] } };

    expect(data.waitMatch.matches).toHaveLength(COMPACT_RUNTIME_TARGET_LIMIT);
    expect(data.waitMatch.matches[0]).toBe('e1|tap|button|Match 1||');
    expect(data.waitMatch.matches[COMPACT_RUNTIME_TARGET_LIMIT - 1]).toBe(
      `e${COMPACT_RUNTIME_TARGET_LIMIT}|tap|button|Match ${COMPACT_RUNTIME_TARGET_LIMIT}||`,
    );
  });

  it('caps compact runtime snapshot rows by category', () => {
    const targets = Array.from({ length: 80 }, (_, index) => ({
      ref: `e${index + 1}`,
      role: 'button' as const,
      label: `Target ${index + 1}`,
      frame: { x: 0, y: index, width: 100, height: 40 },
      actions: ['tap' as const],
    }));
    const scroll = Array.from({ length: 40 }, (_, index) => ({
      ref: `e${index + 81}`,
      role: 'scroll-view' as const,
      label: `Scroll ${index + 1}`,
      frame: { x: 0, y: index, width: 390, height: 600 },
      actions: ['swipeWithin' as const],
    }));
    const text = Array.from({ length: 70 }, (_, index) => ({
      ref: `e${index + 121}`,
      role: 'text' as const,
      label: `Text ${index + 1}`,
      frame: { x: 0, y: index, width: 100, height: 20 },
      state: { visible: true },
      actions: ['touch' as const],
    }));
    const result: CaptureResultDomainResult = {
      kind: 'capture-result',
      didError: false,
      error: null,
      summary: { status: 'SUCCEEDED' },
      artifacts: { simulatorId: 'SIMULATOR-1' },
      capture: {
        type: 'runtime-snapshot',
        protocol: 'rs/1',
        simulatorId: 'SIMULATOR-1',
        screenHash: 'large-screen',
        seq: 4,
        capturedAtMs: 1_000,
        expiresAtMs: 61_000,
        elements: [...targets, ...scroll, ...text],
        actions: [],
      },
    };

    const envelope = toStructuredEnvelope(result, 'mobilebuildmcp.output.capture-result', '2');
    const data = envelope.data as {
      capture: { targets: string[]; scroll: string[]; text?: string[] };
    };

    expect(data.capture.targets).toHaveLength(64);
    expect(data.capture.scroll).toHaveLength(32);
    expect(data.capture.text).toHaveLength(64);
  });

  it('compacts unchanged runtime snapshot captures by default', () => {
    const result: CaptureResultDomainResult = {
      kind: 'capture-result',
      didError: false,
      error: null,
      summary: { status: 'SUCCEEDED' },
      artifacts: { simulatorId: 'SIMULATOR-1' },
      capture: {
        type: 'runtime-snapshot-unchanged',
        protocol: 'rs/1',
        simulatorId: 'SIMULATOR-1',
        screenHash: 'screen-one',
        seq: 2,
      },
    };

    expect(toStructuredEnvelope(result, 'mobilebuildmcp.output.capture-result', '2')).toEqual({
      schema: 'mobilebuildmcp.output.capture-result',
      schemaVersion: '2',
      didError: false,
      error: null,
      data: {
        summary: { status: 'SUCCEEDED' },
        artifacts: { simulatorId: 'SIMULATOR-1' },
        capture: {
          type: 'runtime-snapshot-unchanged',
          rs: '1',
          screenHash: 'screen-one',
          seq: 2,
          unchanged: true,
          udid: 'SIMULATOR-1',
        },
      },
    });
  });

  it('orders compact runtime snapshot targets by usefulness', () => {
    const result: CaptureResultDomainResult = {
      kind: 'capture-result',
      didError: false,
      error: null,
      summary: { status: 'SUCCEEDED' },
      artifacts: { simulatorId: 'SIMULATOR-1' },
      capture: {
        type: 'runtime-snapshot',
        protocol: 'rs/1',
        simulatorId: 'SIMULATOR-1',
        screenHash: 'screen-two',
        seq: 2,
        capturedAtMs: 1_000,
        expiresAtMs: 61_000,
        elements: [
          {
            ref: 'e2',
            role: 'button',
            label: 'Sheet Grabber',
            value: 'Expanded',
            frame: { x: 0, y: 0, width: 100, height: 20 },
            actions: ['tap'],
          },
          {
            ref: 'e3',
            role: 'button',
            label: 'Settings',
            frame: { x: 320, y: 40, width: 40, height: 40 },
            actions: ['tap'],
          },
          {
            ref: 'e8',
            role: 'text-field',
            value: 'Portland',
            frame: { x: 20, y: 100, width: 200, height: 40 },
            actions: ['typeText'],
          },
          {
            ref: 'e9',
            role: 'button',
            label: 'Clear search',
            frame: { x: 230, y: 100, width: 40, height: 40 },
            actions: ['tap'],
          },
          {
            ref: 'e82',
            role: 'button',
            label: 'PRECIP., 78%, Next 24 hours',
            identifier: 'weather.precipitationCard',
            frame: { x: 20, y: 300, width: 340, height: 140 },
            actions: ['tap'],
          },
        ],
        actions: [],
      },
    };

    const envelope = toStructuredEnvelope(result, 'mobilebuildmcp.output.capture-result', '2');

    expect(envelope.data).toMatchObject({
      capture: {
        screenHash: 'screen-two',
        seq: 2,
        targets: [
          'e82|tap|button|PRECIP., 78%, Next 24 hours||weather.precipitationCard',
          'e8|typeText|text-field||Portland|',
          'e3|tap|button|Settings||',
          'e9|tap|button|Clear search||',
        ],
      },
    });
  });

  it('orders destructive compact runtime targets after useful targets', () => {
    const result: CaptureResultDomainResult = {
      kind: 'capture-result',
      didError: false,
      error: null,
      summary: { status: 'SUCCEEDED' },
      artifacts: { simulatorId: 'SIMULATOR-1' },
      capture: {
        type: 'runtime-snapshot',
        protocol: 'rs/1',
        simulatorId: 'SIMULATOR-1',
        screenHash: 'screen-hash',
        seq: 1,
        capturedAtMs: 1_000,
        expiresAtMs: 61_000,
        elements: [
          {
            ref: 'e1',
            role: 'button',
            label: 'Remove',
            identifier: 'trash',
            frame: { x: 300, y: 180, width: 40, height: 40 },
            actions: ['tap'],
          },
          {
            ref: 'e2',
            role: 'button',
            label: 'Portland, 1:24 PM · Light Rain',
            frame: { x: 20, y: 140, width: 300, height: 80 },
            actions: ['tap'],
          },
        ],
        actions: [
          { action: 'tap', elementRef: 'e1', label: 'Remove' },
          { action: 'tap', elementRef: 'e2', label: 'Portland, 1:24 PM · Light Rain' },
        ],
      },
    };

    const envelope = toStructuredEnvelope(result, 'mobilebuildmcp.output.capture-result', '2');
    const data = envelope.data as { capture: { targets: string[] } };

    expect(data.capture.targets).toEqual([
      'e2|tap|button|Portland, 1:24 PM · Light Rain||',
      'e1|tap|button|Remove||trash',
    ]);
  });

  it('orders unselected compact runtime segmented controls before selected controls', () => {
    const result: CaptureResultDomainResult = {
      kind: 'capture-result',
      didError: false,
      error: null,
      summary: { status: 'SUCCEEDED' },
      artifacts: { simulatorId: 'SIMULATOR-1' },
      capture: {
        type: 'runtime-snapshot',
        protocol: 'rs/1',
        simulatorId: 'SIMULATOR-1',
        screenHash: 'screen-hash',
        seq: 1,
        capturedAtMs: 1_000,
        expiresAtMs: 61_000,
        elements: [
          {
            ref: 'e9',
            role: 'button',
            label: '°F',
            value: 'selected',
            frame: { x: 20, y: 40, width: 70, height: 44 },
            actions: ['tap'],
          },
          {
            ref: 'e10',
            role: 'button',
            label: '°C',
            value: 'not selected',
            frame: { x: 100, y: 40, width: 70, height: 44 },
            actions: ['tap'],
          },
        ],
        actions: [
          { action: 'tap', elementRef: 'e9', label: '°F' },
          { action: 'tap', elementRef: 'e10', label: '°C' },
        ],
      },
    };

    const envelope = toStructuredEnvelope(result, 'mobilebuildmcp.output.capture-result', '2');
    const data = envelope.data as { capture: { targets: string[] } };

    expect(data.capture.targets).toEqual([
      'e10|tap|button|°C|not selected|',
      'e9|tap|button|°F|selected|',
    ]);
  });

  it('compacts runtime snapshot candidates inside recoverable UI errors by default', () => {
    const result: CaptureResultDomainResult = {
      kind: 'capture-result',
      didError: true,
      error: 'The wait selector matched multiple runtime UI elements.',
      summary: { status: 'FAILED' },
      artifacts: { simulatorId: 'SIMULATOR-1' },
      uiError: {
        code: 'TARGET_AMBIGUOUS',
        message: 'The wait selector matched multiple runtime UI elements.',
        recoveryHint: 'Provide a more specific selector.',
        candidates: [
          {
            ref: 'e8',
            role: 'text-field',
            value: 'Lisbon',
            identifier: 'weather.locationsSheet',
            frame: { x: 65, y: 482, width: 272, height: 18 },
            actions: ['tap', 'typeText', 'longPress', 'touch'],
          },
          {
            ref: 'e11',
            role: 'button',
            label: 'Lisbon, Portugal',
            value: 'saved',
            frame: { x: 40, y: 552, width: 89, height: 49 },
            actions: ['tap', 'longPress', 'touch'],
          },
        ],
      },
    };

    expect(toStructuredEnvelope(result, 'mobilebuildmcp.output.capture-result', '2')).toEqual({
      schema: 'mobilebuildmcp.output.capture-result',
      schemaVersion: '2',
      didError: true,
      error: 'The wait selector matched multiple runtime UI elements.',
      data: {
        summary: { status: 'FAILED' },
        artifacts: { simulatorId: 'SIMULATOR-1' },
        uiError: {
          code: 'TARGET_AMBIGUOUS',
          message: 'The wait selector matched multiple runtime UI elements.',
          recoveryHint: 'Provide a more specific selector.',
          candidates: [
            'e8|typeText|text-field||Lisbon|weather.locationsSheet',
            'e11|tap|button|Lisbon, Portugal|saved|',
          ],
        },
      },
    });
  });

  it('caps compact runtime snapshot candidates inside recoverable UI errors', () => {
    const candidates = Array.from({ length: COMPACT_RUNTIME_TARGET_LIMIT + 16 }, (_, index) => ({
      ref: `e${index + 1}`,
      role: 'button' as const,
      label: `Candidate ${index + 1}`,
      frame: { x: 0, y: index, width: 100, height: 40 },
      actions: ['tap' as const],
    }));
    const result: CaptureResultDomainResult = {
      kind: 'capture-result',
      didError: true,
      error: 'Element ref is not actionable.',
      summary: { status: 'FAILED' },
      artifacts: { simulatorId: 'SIMULATOR-1' },
      uiError: {
        code: 'TARGET_NOT_ACTIONABLE',
        message: 'Element ref is not actionable.',
        recoveryHint: 'Choose another elementRef.',
        elementRef: 'e404',
        candidates,
      },
    };

    const envelope = toStructuredEnvelope(result, 'mobilebuildmcp.output.capture-result', '2');
    const data = envelope.data as {
      uiError: { candidates: string[]; message: string; elementRef: string };
    };

    expect(data.uiError.message).toBe('Element ref is not actionable.');
    expect(data.uiError.elementRef).toBe('e404');
    expect(data.uiError.candidates).toHaveLength(COMPACT_RUNTIME_TARGET_LIMIT);
    expect(data.uiError.candidates[0]).toBe('e1|tap|button|Candidate 1||');
    expect(data.uiError.candidates[COMPACT_RUNTIME_TARGET_LIMIT - 1]).toBe(
      `e${COMPACT_RUNTIME_TARGET_LIMIT}|tap|button|Candidate ${COMPACT_RUNTIME_TARGET_LIMIT}||`,
    );
  });

  it('can keep full runtime snapshots and candidates for verbose callers', () => {
    const result: CaptureResultDomainResult = {
      kind: 'capture-result',
      didError: true,
      error: 'The wait selector matched multiple runtime UI elements.',
      summary: { status: 'FAILED' },
      artifacts: { simulatorId: 'SIMULATOR-1' },
      capture: {
        type: 'runtime-snapshot',
        protocol: 'rs/1',
        simulatorId: 'SIMULATOR-1',
        screenHash: 'screen-three',
        seq: 3,
        capturedAtMs: 1_000,
        expiresAtMs: 61_000,
        elements: [
          {
            ref: 'e1',
            role: 'application',
            label: 'Weather',
            frame: { x: 0, y: 0, width: 390, height: 844 },
            actions: ['swipeWithin'],
          },
        ],
        actions: [{ action: 'swipeWithin', elementRef: 'e1', label: 'Weather' }],
      },
      uiError: {
        code: 'TARGET_AMBIGUOUS',
        message: 'The wait selector matched multiple runtime UI elements.',
        recoveryHint: 'Provide a more specific selector.',
        candidates: [
          {
            ref: 'e1',
            role: 'application',
            label: 'Weather',
            frame: { x: 0, y: 0, width: 390, height: 844 },
            actions: ['swipeWithin'],
          },
        ],
      },
    };

    expect(
      toStructuredEnvelope(result, 'mobilebuildmcp.output.capture-result', '2', {
        runtimeSnapshot: 'full',
      }),
    ).toEqual({
      schema: 'mobilebuildmcp.output.capture-result',
      schemaVersion: '2',
      didError: true,
      error: 'The wait selector matched multiple runtime UI elements.',
      data: {
        summary: { status: 'FAILED' },
        artifacts: { simulatorId: 'SIMULATOR-1' },
        capture: result.capture,
        uiError: result.uiError,
      },
    });
  });
});
