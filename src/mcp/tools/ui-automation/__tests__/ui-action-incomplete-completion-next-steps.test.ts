import { beforeEach, describe, expect, it } from 'vitest';
import type {
  AccessibilityNode,
  UiActionResultDomainResult,
} from '../../../../types/domain-results.ts';
import { sessionStore } from '../../../../utils/session-store.ts';
import { toStructuredEnvelope } from '../../../../utils/structured-output-envelope.ts';
import { createMockToolHandlerContext } from '../../../../test-utils/test-helpers.ts';
import { createCaptureSuccessResult } from '../shared/domain-result.ts';
import {
  createRuntimeSnapshotNextSteps,
  getForegroundCompletionSuppressedRuntimeTargetRefs,
} from '../shared/runtime-next-steps.ts';
import { getRuntimeSnapshot, recordRuntimeSnapshot } from '../shared/snapshot-ui-state.ts';
import { createRuntimeSnapshotRecord } from '../shared/runtime-snapshot.ts';
import { tapLogic } from '../tap.ts';
import {
  createMockAxeHelpers,
  createNode,
  createSequencedExecutor,
} from './ui-action-test-helpers.ts';

const simulatorId = '57F882E8-F858-4F57-98D4-8164D5915C43';

function createSearchResultBeforeCompletionNodes(): AccessibilityNode[] {
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
          AXIdentifier: 'example.searchSheet',
          frame: { x: 330, y: 96, width: 44, height: 44 },
        }),
        createNode({
          type: 'TextField',
          role: 'AXTextField',
          AXValue: 'Result query',
          AXIdentifier: 'example.searchSheet',
          frame: { x: 20, y: 150, width: 300, height: 44 },
        }),
        createNode({
          AXLabel: 'Example result, detail text',
          AXValue: 'not saved',
          frame: { x: 20, y: 218, width: 280, height: 72 },
        }),
        createNode({
          type: 'Button',
          role: 'AXButton',
          AXLabel: 'Add',
          AXIdentifier: 'example.searchSheet',
          frame: { x: 322, y: 232, width: 60, height: 44 },
        }),
      ],
    }),
  ];
}

function createMixedCompletionSheetNodes(): AccessibilityNode[] {
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
          AXIdentifier: 'example.searchSheet',
          frame: { x: 330, y: 96, width: 44, height: 44 },
        }),
        createNode({
          AXLabel: 'Existing result, detail text',
          AXValue: 'saved',
          frame: { x: 20, y: 218, width: 280, height: 72 },
        }),
        createNode({
          AXLabel: 'New result, detail text',
          AXValue: 'not saved',
          frame: { x: 20, y: 306, width: 280, height: 72 },
        }),
        createNode({
          type: 'Button',
          role: 'AXButton',
          AXLabel: 'Add',
          AXIdentifier: 'example.searchSheet',
          frame: { x: 322, y: 320, width: 60, height: 44 },
        }),
      ],
    }),
  ];
}

function recordSnapshot(nodes: AccessibilityNode[], capturedAtMs = Date.now()): void {
  recordRuntimeSnapshot(
    createRuntimeSnapshotRecord({ simulatorId, uiHierarchy: nodes, nowMs: capturedAtMs }),
  );
}

function currentSnapshot() {
  const snapshot = getRuntimeSnapshot(simulatorId);
  expect(snapshot).not.toBeNull();
  return snapshot!;
}

function sameSearchResultExecutor() {
  return createSequencedExecutor([
    { success: true, output: 'ok' },
    {
      success: true,
      output: JSON.stringify({ elements: createSearchResultBeforeCompletionNodes() }),
    },
  ]).executor;
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

describe('UI action incomplete completion next steps', () => {
  beforeEach(() => {
    sessionStore.clear();
  });

  it('prefers Add when foreground completion rows contain mixed complete and incomplete states', () => {
    recordSnapshot(createMixedCompletionSheetNodes());
    const snapshot = currentSnapshot().payload;
    const addRef = snapshot.elements.find((element) => element.label === 'Add')?.ref;
    const closeRef = snapshot.elements.find((element) => element.label === 'Close')?.ref;
    const savedRef = snapshot.elements.find((element) => element.value === 'saved')?.ref;
    const notSavedRef = snapshot.elements.find((element) => element.value === 'not saved')?.ref;
    expect(addRef).toBeDefined();
    expect(closeRef).toBeDefined();
    expect(savedRef).toBeDefined();
    expect(notSavedRef).toBeDefined();

    const steps = createRuntimeSnapshotNextSteps({
      simulatorId,
      runtimeSnapshot: snapshot,
      includeRefreshAndWait: false,
    });
    const suppressedRefs = getForegroundCompletionSuppressedRuntimeTargetRefs({
      simulatorId,
      runtimeSnapshot: snapshot,
    });

    expect(steps[0]).toEqual({
      label: 'Tap an elementRef',
      tool: 'tap',
      params: { simulatorId, elementRef: addRef },
    });
    expect(steps[0]?.params?.elementRef).not.toBe(closeRef);
    expect(suppressedRefs).toEqual([notSavedRef]);
    expect(suppressedRefs).not.toContain(savedRef);
  });

  it('keeps ordinary unsuppressed rows actionable in compact targets', () => {
    recordSnapshot(createSearchResultBeforeCompletionNodes());
    const snapshot = currentSnapshot().payload;
    const rowRef = snapshot.elements.find((element) => element.value === 'not saved')?.ref;
    expect(rowRef).toBeDefined();

    const result = createCaptureSuccessResult(simulatorId, { capture: snapshot });
    const envelope = toStructuredEnvelope(result, 'mobilebuildmcp.output.capture-result', '2');

    expect(compactTargets(envelope).some((target) => target.startsWith(`${rowRef}|tap|`))).toBe(
      true,
    );
  });

  it('does not repeat a no-op incomplete foreground row tap and prefers Add', async () => {
    recordSnapshot(createSearchResultBeforeCompletionNodes());
    const snapshot = currentSnapshot().payload;
    const rowRef = snapshot.elements.find((element) => element.value === 'not saved')?.ref;
    const addRef = snapshot.elements.find((element) => element.label === 'Add')?.ref;
    const closeRef = snapshot.elements.find((element) => element.label === 'Close')?.ref;
    expect(rowRef).toBeDefined();
    expect(addRef).toBeDefined();
    expect(closeRef).toBeDefined();
    const { ctx, run } = createMockToolHandlerContext();

    await run(() =>
      tapLogic(
        { simulatorId, elementRef: rowRef! },
        sameSearchResultExecutor(),
        createMockAxeHelpers(),
      ),
    );

    const result = ctx.structuredOutput?.result as UiActionResultDomainResult;
    const envelope = toStructuredEnvelope(result, 'mobilebuildmcp.output.ui-action-result', '2', {
      nextSteps: ctx.nextSteps,
    });

    expect(ctx.nextSteps?.[0]).toEqual({
      label: 'Tap an elementRef',
      tool: 'tap',
      params: { simulatorId, elementRef: addRef },
    });
    expect(ctx.nextSteps?.[0]?.params?.elementRef).not.toBe(closeRef);
    expect(compactTargets(envelope).some((target) => target.startsWith(`${rowRef}|tap|`))).toBe(
      true,
    );
    expect(compactTargets(envelope).some((target) => target.startsWith(`${addRef}|tap|`))).toBe(
      true,
    );
    expect(compactText(envelope).some((line) => line.includes('not saved'))).toBe(false);
    expect(compactEvidence(envelope)).toEqual([]);
  });

  it('keeps incomplete foreground status visible after a no-op Add tap', async () => {
    recordSnapshot(createSearchResultBeforeCompletionNodes());
    const snapshot = currentSnapshot().payload;
    const rowRef = snapshot.elements.find((element) => element.value === 'not saved')?.ref;
    const addRef = snapshot.elements.find((element) => element.label === 'Add')?.ref;
    expect(rowRef).toBeDefined();
    expect(addRef).toBeDefined();
    const { ctx, run } = createMockToolHandlerContext();

    await run(() =>
      tapLogic(
        { simulatorId, elementRef: addRef! },
        sameSearchResultExecutor(),
        createMockAxeHelpers(),
      ),
    );

    const result = ctx.structuredOutput?.result as UiActionResultDomainResult;
    const envelope = toStructuredEnvelope(result, 'mobilebuildmcp.output.ui-action-result', '2', {
      nextSteps: ctx.nextSteps,
    });

    expect(ctx.nextSteps?.[0]?.params?.elementRef).not.toBe(addRef);
    expect(
      ctx.structuredOutput?.renderHints?.runtimeSnapshot?.suppressedTargetRefs,
    ).toBeUndefined();
    expect(
      compactTargets(envelope).some(
        (target) => target.startsWith(`${rowRef}|tap|`) && target.includes('not saved'),
      ),
    ).toBe(true);
  });
});
