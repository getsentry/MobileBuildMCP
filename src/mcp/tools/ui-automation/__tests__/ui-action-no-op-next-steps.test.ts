import { beforeEach, describe, expect, it } from 'vitest';
import type {
  AccessibilityNode,
  UiActionResultDomainResult,
} from '../../../../types/domain-results.ts';
import { sessionStore } from '../../../../utils/session-store.ts';
import { toStructuredEnvelope } from '../../../../utils/structured-output-envelope.ts';
import { createMockToolHandlerContext } from '../../../../test-utils/test-helpers.ts';
import {
  setUiActionStructuredOutput,
  setCaptureStructuredOutput,
  createUiActionSuccessResult,
  createCaptureSuccessResult,
} from '../shared/domain-result.ts';
import { createRuntimeSnapshotNextSteps } from '../shared/runtime-next-steps.ts';
import { getRuntimeSnapshot, recordRuntimeSnapshot } from '../shared/snapshot-ui-state.ts';
import { createRuntimeSnapshotRecord } from '../shared/runtime-snapshot.ts';
import { tapLogic } from '../tap.ts';
import {
  createMockAxeHelpers,
  createNode,
  createSequencedExecutor,
} from './ui-action-test-helpers.ts';

const simulatorId = '9A9F6BF3-A1F8-4AC7-8B32-37EDC7F4F511';

function createLocationsSheetNodes() {
  return [
    createNode({
      type: 'Application',
      role: 'AXApplication',
      AXLabel: 'Example',
      frame: { x: 0, y: 0, width: 402, height: 874 },
      children: [
        createNode({
          AXLabel: 'Background, Details',
          AXIdentifier: 'example.backgroundCard',
          frame: { x: 20, y: 120, width: 362, height: 72 },
        }),
        createNode({
          type: 'Button',
          role: 'AXButton',
          AXLabel: 'Sheet Grabber',
          frame: { x: 163, y: 57, width: 76, height: 25 },
        }),
        createNode({
          type: 'Button',
          role: 'AXButton',
          AXLabel: 'Edit',
          AXIdentifier: 'example.locationsSheet',
          frame: { x: 24, y: 96, width: 60, height: 44 },
        }),
        createNode({
          type: 'Button',
          role: 'AXButton',
          AXLabel: 'Close',
          AXIdentifier: 'example.locationsSheet',
          frame: { x: 330, y: 96, width: 44, height: 44 },
        }),
        createNode({
          type: 'TextField',
          role: 'AXTextField',
          AXLabel: undefined,
          AXValue: 'Search for a city, airport, or country',
          AXIdentifier: 'example.locationsSheet',
          frame: { x: 20, y: 150, width: 362, height: 44 },
        }),
        createNode({
          AXLabel: 'London, England, United Kingdom',
          AXValue: 'saved',
          frame: { x: 20, y: 218, width: 362, height: 72 },
        }),
        createNode({
          AXLabel: 'Portland, 1:24 PM · Light Rain',
          frame: { x: 20, y: 326, width: 362, height: 72 },
        }),
        createNode({
          AXLabel: 'Aspen, 2:24 PM · Light Snow',
          frame: { x: 20, y: 415, width: 362, height: 72 },
        }),
      ],
    }),
  ];
}

function createSearchResultBeforeAddNodes() {
  return [
    createNode({
      type: 'Application',
      role: 'AXApplication',
      AXLabel: 'Example',
      frame: { x: 0, y: 0, width: 402, height: 874 },
      children: [
        createNode({
          type: 'Button',
          role: 'AXButton',
          AXLabel: 'Sheet Grabber',
          frame: { x: 163, y: 57, width: 76, height: 25 },
        }),
        createNode({
          type: 'Button',
          role: 'AXButton',
          AXLabel: 'Close',
          AXIdentifier: 'example.locationsSheet',
          frame: { x: 330, y: 96, width: 44, height: 44 },
        }),
        createNode({
          type: 'Button',
          role: 'AXButton',
          AXLabel: 'Clear search',
          AXIdentifier: 'example.locationsSheet',
          frame: { x: 330, y: 150, width: 44, height: 44 },
        }),
        createNode({
          type: 'TextField',
          role: 'AXTextField',
          AXValue: 'London',
          AXIdentifier: 'example.locationsSheet',
          frame: { x: 20, y: 150, width: 300, height: 44 },
        }),
        createNode({
          AXLabel: 'London, England, United Kingdom, 9:24 PM · Light Rain',
          AXValue: 'not saved',
          frame: { x: 20, y: 218, width: 280, height: 72 },
        }),
        createNode({
          type: 'Button',
          role: 'AXButton',
          AXLabel: 'Add',
          AXIdentifier: 'example.locationsSheet',
          frame: { x: 322, y: 232, width: 60, height: 44 },
        }),
      ],
    }),
  ];
}

function createSavedSearchResultSheetNodes() {
  return [
    createNode({
      type: 'Application',
      role: 'AXApplication',
      AXLabel: 'Example',
      frame: { x: 0, y: 0, width: 402, height: 874 },
      children: [
        createNode({
          type: 'Button',
          role: 'AXButton',
          AXLabel: 'Sheet Grabber',
          frame: { x: 163, y: 57, width: 76, height: 25 },
        }),
        createNode({
          type: 'Button',
          role: 'AXButton',
          AXLabel: 'Close',
          AXIdentifier: 'example.locationsSheet',
          frame: { x: 330, y: 96, width: 44, height: 44 },
        }),
        createNode({
          type: 'Button',
          role: 'AXButton',
          AXLabel: 'Clear search',
          AXIdentifier: 'example.locationsSheet',
          frame: { x: 330, y: 150, width: 44, height: 44 },
        }),
        createNode({
          type: 'TextField',
          role: 'AXTextField',
          AXValue: 'London',
          AXIdentifier: 'example.locationsSheet',
          frame: { x: 20, y: 150, width: 300, height: 44 },
        }),
        createNode({
          AXLabel: 'London, England, United Kingdom, 9:24 PM · Light Rain',
          AXValue: 'saved',
          frame: { x: 20, y: 218, width: 362, height: 72 },
        }),
      ],
    }),
  ];
}

function currentSnapshot() {
  const snapshot = getRuntimeSnapshot(simulatorId);
  expect(snapshot).not.toBeNull();
  return snapshot!;
}

function compactCaptureList(
  envelope: ReturnType<typeof toStructuredEnvelope>,
  key: 'targets' | 'text' | 'evidence',
): string[] {
  const data = envelope.data;
  if (!data || typeof data !== 'object' || !('capture' in data)) {
    throw new Error('Expected structured output capture.');
  }

  const capture = (data as { capture?: unknown }).capture;
  if (!capture || typeof capture !== 'object' || !(key in capture)) {
    return [];
  }

  const entries = (capture as Record<typeof key, unknown>)[key];
  if (!Array.isArray(entries)) {
    throw new Error(`Expected compact runtime snapshot ${key} array.`);
  }

  return entries.filter((entry): entry is string => typeof entry === 'string');
}

function compactTargets(envelope: ReturnType<typeof toStructuredEnvelope>): string[] {
  return compactCaptureList(envelope, 'targets');
}

function compactText(envelope: ReturnType<typeof toStructuredEnvelope>): string[] {
  return compactCaptureList(envelope, 'text');
}

function compactEvidence(envelope: ReturnType<typeof toStructuredEnvelope>): string[] {
  return compactCaptureList(envelope, 'evidence');
}

function sameSheetExecutor() {
  return createSequencedExecutor([
    { success: true, output: 'ok' },
    { success: true, output: JSON.stringify({ elements: createLocationsSheetNodes() }) },
  ]).executor;
}

function addSearchResultExecutor() {
  return createSequencedExecutor([
    { success: true, output: 'ok' },
    {
      success: true,
      output: JSON.stringify({ elements: createSavedSearchResultSheetNodes() }),
    },
  ]).executor;
}

function recordSnapshot(nodes: AccessibilityNode[], capturedAtMs = Date.now()): void {
  recordRuntimeSnapshot(
    createRuntimeSnapshotRecord({ simulatorId, uiHierarchy: nodes, nowMs: capturedAtMs }),
  );
}

describe('UI action no-op next steps', () => {
  beforeEach(() => {
    sessionStore.clear();
  });

  it('filters background taps when a foreground sheet is active', () => {
    recordSnapshot(createLocationsSheetNodes());
    const snapshot = currentSnapshot().payload;
    const backgroundRef = snapshot.elements.find(
      (element) => element.identifier === 'example.backgroundCard',
    )?.ref;
    const closeRef = snapshot.elements.find((element) => element.label === 'Close')?.ref;

    const steps = createRuntimeSnapshotNextSteps({
      simulatorId,
      runtimeSnapshot: snapshot,
      includeRefreshAndWait: false,
    });

    expect(backgroundRef).toBeDefined();
    expect(closeRef).toBeDefined();
    expect(steps[0]?.tool).toBe('tap');
    expect(steps[0]?.params?.elementRef).not.toBe(backgroundRef);
    expect(
      steps.some((step) => step.tool === 'tap' && step.params?.elementRef === backgroundRef),
    ).toBe(false);
  });

  it('prefers Add over a not-saved foreground-sheet result row', () => {
    recordSnapshot(createSearchResultBeforeAddNodes());
    const snapshot = currentSnapshot().payload;
    const addRef = snapshot.elements.find((element) => element.label === 'Add')?.ref;
    const rowRef = snapshot.elements.find((element) => element.value === 'not saved')?.ref;
    expect(addRef).toBeDefined();
    expect(rowRef).toBeDefined();

    const steps = createRuntimeSnapshotNextSteps({
      simulatorId,
      runtimeSnapshot: snapshot,
      includeRefreshAndWait: false,
    });

    expect(steps[0]).toEqual({
      label: 'Tap an elementRef',
      tool: 'tap',
      params: { simulatorId, elementRef: addRef },
    });
    expect(steps.some((step) => step.tool === 'tap' && step.params?.elementRef === rowRef)).toBe(
      false,
    );

    const { ctx } = createMockToolHandlerContext();
    const result = createCaptureSuccessResult(simulatorId, { capture: snapshot });
    setCaptureStructuredOutput(ctx, result);
    const envelope = toStructuredEnvelope(result, 'mobilebuildmcp.output.capture-result', '2');

    expect(snapshot.elements.find((element) => element.ref === rowRef)?.actions).toContain('tap');
    expect(compactTargets(envelope).some((target) => target.startsWith(`${rowRef}|tap|`))).toBe(
      true,
    );
    expect(compactTargets(envelope).some((target) => target.startsWith(`${addRef}|tap|`))).toBe(
      true,
    );
    expect(compactText(envelope).some((line) => line.includes('not saved'))).toBe(false);
    expect(compactEvidence(envelope)).toEqual([]);
  });

  it('keeps completed foreground-sheet rows actionable in regular snapshot affordances', () => {
    recordSnapshot(createSavedSearchResultSheetNodes());
    const snapshot = currentSnapshot().payload;
    const savedRowRef = snapshot.elements.find((element) => element.value === 'saved')?.ref;
    const closeRef = snapshot.elements.find((element) => element.label === 'Close')?.ref;
    const clearSearchRef = snapshot.elements.find(
      (element) => element.label === 'Clear search',
    )?.ref;
    expect(savedRowRef).toBeDefined();
    expect(closeRef).toBeDefined();
    expect(clearSearchRef).toBeDefined();

    const steps = createRuntimeSnapshotNextSteps({
      simulatorId,
      runtimeSnapshot: snapshot,
      includeRefreshAndWait: false,
    });
    expect(steps[0]).toEqual({
      label: 'Tap an elementRef',
      tool: 'tap',
      params: { simulatorId, elementRef: savedRowRef },
    });

    const { ctx } = createMockToolHandlerContext();
    const result = createCaptureSuccessResult(simulatorId, { capture: snapshot });
    setCaptureStructuredOutput(ctx, result);
    const envelope = toStructuredEnvelope(result, 'mobilebuildmcp.output.capture-result', '2');

    expect(snapshot.elements.find((element) => element.ref === savedRowRef)?.actions).toContain(
      'tap',
    );
    expect(
      compactTargets(envelope).some((target) => target.startsWith(`${savedRowRef}|tap|`)),
    ).toBe(true);
    expect(
      compactTargets(envelope).some((target) => target.startsWith(`${clearSearchRef}|tap|`)),
    ).toBe(true);
    expect(compactTargets(envelope).some((target) => target.startsWith(`${closeRef}|tap|`))).toBe(
      true,
    );
    expect(compactText(envelope).some((line) => line.includes('saved'))).toBe(false);
  });

  it('does not demote a saved foreground-sheet result row after adding it', async () => {
    recordSnapshot(createSearchResultBeforeAddNodes());
    const addRef = currentSnapshot().payload.elements.find(
      (element) => element.label === 'Add',
    )?.ref;
    expect(addRef).toBeDefined();
    const { ctx, run } = createMockToolHandlerContext();

    await run(() =>
      tapLogic(
        { simulatorId, elementRef: addRef! },
        addSearchResultExecutor(),
        createMockAxeHelpers(),
      ),
    );

    const result = ctx.structuredOutput?.result as UiActionResultDomainResult;
    const capture = result.capture;
    if (!capture || !('elements' in capture)) {
      throw new Error('Expected runtime snapshot capture.');
    }
    const closeRef = capture.elements.find((element) => element.label === 'Close')?.ref;
    const clearSearchRef = capture.elements.find(
      (element) => element.label === 'Clear search',
    )?.ref;
    const savedRow = capture.elements.find((element) => element.value === 'saved');
    expect(closeRef).toBeDefined();
    expect(clearSearchRef).toBeDefined();
    expect(savedRow).toBeDefined();
    expect(savedRow?.actions).toContain('tap');
    expect(
      ctx.structuredOutput?.renderHints?.runtimeSnapshot?.suppressedTargetRefs,
    ).toBeUndefined();
    expect(ctx.nextSteps).toEqual([
      {
        label: 'Tap an elementRef',
        tool: 'tap',
        params: { simulatorId, elementRef: savedRow?.ref },
      },
    ]);
    const envelope = toStructuredEnvelope(result, 'mobilebuildmcp.output.ui-action-result', '2', {
      nextSteps: ctx.nextSteps,
    });
    expect(
      compactTargets(envelope).some((target) => target.startsWith(`${savedRow?.ref}|tap|`)),
    ).toBe(true);
    expect(
      compactTargets(envelope).some((target) => target.startsWith(`${clearSearchRef}|tap|`)),
    ).toBe(true);
    expect(compactTargets(envelope).some((target) => target.startsWith(`${closeRef}|tap|`))).toBe(
      true,
    );
    expect(compactText(envelope).some((line) => line.includes('saved'))).toBe(false);
  });

  it('does not repeat a no-op foreground row tap or promote dismiss over remaining content', async () => {
    recordSnapshot(createLocationsSheetNodes());
    const rowRef = currentSnapshot().payload.elements.find((element) =>
      element.label?.startsWith('London'),
    )?.ref;
    const remainingContentRef = currentSnapshot().payload.elements.find((element) =>
      element.label?.startsWith('Portland'),
    )?.ref;
    const closeRef = currentSnapshot().payload.elements.find(
      (element) => element.label === 'Close',
    )?.ref;
    expect(rowRef).toBeDefined();
    expect(remainingContentRef).toBeDefined();
    expect(closeRef).toBeDefined();
    const { ctx, run } = createMockToolHandlerContext();

    await run(() =>
      tapLogic({ simulatorId, elementRef: rowRef! }, sameSheetExecutor(), createMockAxeHelpers()),
    );

    expect(ctx.nextSteps?.[0]).toEqual({
      label: 'Tap an elementRef',
      tool: 'tap',
      params: { simulatorId, elementRef: remainingContentRef },
    });
    expect(ctx.nextSteps?.[0]?.params?.elementRef).not.toBe(closeRef);
    expect(ctx.nextSteps?.some((step) => step.tool === 'batch')).toBe(false);
    expect(
      ctx.nextSteps?.some((step) => step.tool === 'tap' && step.params?.elementRef === rowRef),
    ).toBe(false);
    expect(ctx.nextSteps?.some((step) => step.tool === 'swipe')).toBe(false);
  });

  it('keeps ordinary post-action next steps when the screen hash changes', () => {
    recordSnapshot(createLocationsSheetNodes());
    const previousSnapshot = currentSnapshot().payload;
    recordSnapshot([
      createNode({
        type: 'Button',
        role: 'AXButton',
        AXLabel: 'Continue',
        frame: { x: 20, y: 120, width: 200, height: 44 },
      }),
    ]);
    const changedSnapshot = currentSnapshot().payload;
    const result = createUiActionSuccessResult({ type: 'tap', elementRef: 'e5' }, simulatorId, [], {
      capture: changedSnapshot,
      previousRuntimeSnapshot: previousSnapshot,
    });
    const { ctx } = createMockToolHandlerContext();

    setUiActionStructuredOutput(ctx, result);

    expect(ctx.nextSteps).toEqual([
      {
        label: 'Tap an elementRef',
        tool: 'tap',
        params: { simulatorId, elementRef: 'e1' },
      },
    ]);
  });
});
