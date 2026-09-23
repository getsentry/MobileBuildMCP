import { beforeEach, describe, expect, it } from 'vitest';
import type { AccessibilityNode } from '../../../../types/domain-results.ts';
import type { RuntimeSnapshotV1 } from '../../../../types/ui-snapshot.ts';
import { createRuntimeSnapshotNextSteps } from '../shared/runtime-next-steps.ts';
import {
  __resetRuntimeSnapshotStoreForTests,
  getRuntimeSnapshot,
} from '../shared/snapshot-ui-state.ts';
import { createNode, recordSnapshot, simulatorId } from './ui-action-test-helpers.ts';

function currentRuntimeSnapshot() {
  const snapshot = getRuntimeSnapshot(simulatorId);
  expect(snapshot).not.toBeNull();
  return snapshot!.payload;
}

function createScrollView(overrides: Partial<AccessibilityNode> = {}): AccessibilityNode {
  return createNode({
    type: 'ScrollView',
    role: 'AXScrollArea',
    frame: { x: 0, y: 0, width: 390, height: 844 },
    AXIdentifier: 'scroll-view',
    ...overrides,
  });
}

function nestNode(node: AccessibilityNode, depth: number): AccessibilityNode {
  let current = node;
  for (let index = 0; index < depth; index += 1) {
    current = createNode({
      type: 'Group',
      role: 'AXGroup',
      AXIdentifier: `container.${index}`,
      frame: current.frame,
      children: [current],
    });
  }
  return current;
}

describe('runtime snapshot next steps', () => {
  beforeEach(() => {
    __resetRuntimeSnapshotStoreForTests();
  });

  it('ignores expired stored metadata when creating next steps', () => {
    recordSnapshot(
      [
        createScrollView({
          AXIdentifier: 'example.expiredSheet',
          children: [
            createNode({ AXLabel: 'Close' }),
            createNode({
              type: 'TextField',
              role: 'AXTextField',
              AXLabel: 'Search',
            }),
            createNode({
              AXLabel: 'London, England',
              AXIdentifier: 'example.locationCard',
            }),
          ],
        }),
      ],
      0,
    );

    const storedSnapshot = getRuntimeSnapshot(simulatorId, 0);
    expect(storedSnapshot).not.toBeNull();
    const expiredSnapshot = storedSnapshot!.payload;

    const steps = createRuntimeSnapshotNextSteps({
      simulatorId,
      runtimeSnapshot: expiredSnapshot,
      includeRefreshAndWait: false,
    });

    expect(getRuntimeSnapshot(simulatorId)).toBeNull();
    expect(steps).toEqual([
      {
        label: 'Tap an elementRef',
        tool: 'tap',
        params: { simulatorId, elementRef: 'e4' },
      },
      {
        label: 'Scroll visible content',
        tool: 'swipe',
        params: {
          simulatorId,
          withinElementRef: 'e1',
          direction: 'up',
          distance: 0.5,
        },
      },
    ]);
  });

  it('prefers tap and scroll examples from the active foreground container', () => {
    recordSnapshot([
      createScrollView({
        AXIdentifier: 'weather.backgroundList',
        children: [
          createNode({
            AXLabel: 'Background, Details',
            AXIdentifier: 'weather.backgroundCard',
            frame: { x: 20, y: 120, width: 350, height: 80 },
          }),
        ],
      }),
      createScrollView({
        AXIdentifier: 'weather.settingsSheet',
        frame: { x: 0, y: 420, width: 390, height: 424 },
        children: [
          createNode({ AXLabel: 'Close', frame: { x: 310, y: 430, width: 60, height: 40 } }),
          createNode({
            type: 'TextField',
            role: 'AXTextField',
            AXLabel: 'Search',
            frame: { x: 20, y: 480, width: 350, height: 40 },
          }),
          createNode({
            AXLabel: 'London, England',
            AXIdentifier: 'weather.locationCard',
            frame: { x: 20, y: 540, width: 350, height: 80 },
          }),
        ],
      }),
    ]);

    const snapshot = currentRuntimeSnapshot();
    const foregroundScrollRef = snapshot.elements.find(
      (element) => element.identifier === 'weather.settingsSheet',
    )?.ref;
    const foregroundCardRef = snapshot.elements.find(
      (element) => element.identifier === 'weather.locationCard',
    )?.ref;

    const steps = createRuntimeSnapshotNextSteps({
      simulatorId,
      runtimeSnapshot: snapshot,
      includeRefreshAndWait: false,
    });

    expect(steps).toContainEqual({
      label: 'Tap an elementRef',
      tool: 'tap',
      params: { simulatorId, elementRef: foregroundCardRef },
    });
    expect(steps).toContainEqual({
      label: 'Scroll visible content',
      tool: 'swipe',
      params: {
        simulatorId,
        withinElementRef: foregroundScrollRef,
        direction: 'up',
        distance: 0.5,
      },
    });
  });

  it('uses a cell as a fallback scroll surface when roots are too broad', () => {
    const snapshot: RuntimeSnapshotV1 = {
      type: 'runtime-snapshot',
      protocol: 'rs/1',
      simulatorId,
      screenHash: 'cell-scroll-fallback',
      seq: 1,
      capturedAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
      actions: [],
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
          role: 'cell',
          label: 'Visible row',
          frame: { x: 20, y: 420, width: 350, height: 80 },
          actions: ['tap', 'swipeWithin'],
        },
      ],
    };

    const steps = createRuntimeSnapshotNextSteps({
      simulatorId,
      runtimeSnapshot: snapshot,
      includeRefreshAndWait: false,
    });

    expect(steps).toContainEqual({
      label: 'Scroll visible content',
      tool: 'swipe',
      params: {
        simulatorId,
        withinElementRef: 'e2',
        direction: 'up',
        distance: 0.5,
      },
    });
  });

  it('prioritizes real scrolling over low-information chrome taps', () => {
    const snapshot: RuntimeSnapshotV1 = {
      type: 'runtime-snapshot',
      protocol: 'rs/1',
      simulatorId,
      screenHash: 'scrollable-main',
      seq: 1,
      capturedAtMs: 0,
      expiresAtMs: 1,
      actions: [],
      elements: [
        {
          ref: 'e1',
          role: 'scroll-view',
          label: 'Main content',
          identifier: 'example.mainScroll',
          frame: { x: 0, y: 120, width: 390, height: 724 },
          actions: ['swipeWithin'],
        },
        {
          ref: 'e2',
          role: 'button',
          label: 'Location',
          identifier: 'example.locationButton',
          frame: { x: 20, y: 70, width: 120, height: 44 },
          actions: ['tap'],
        },
        {
          ref: 'e3',
          role: 'button',
          label: 'Settings',
          identifier: 'example.settingsButton',
          frame: { x: 320, y: 70, width: 44, height: 44 },
          actions: ['tap'],
        },
      ],
    };
    const scrollRef = 'e1';
    const locationRef = 'e2';

    const steps = createRuntimeSnapshotNextSteps({
      simulatorId,
      runtimeSnapshot: snapshot,
      includeRefreshAndWait: false,
    });

    expect(steps[0]).toEqual({
      label: 'Scroll visible content',
      tool: 'swipe',
      params: {
        simulatorId,
        withinElementRef: scrollRef,
        direction: 'up',
        distance: 0.5,
      },
    });
    expect(steps).toContainEqual({
      label: 'Tap an elementRef',
      tool: 'tap',
      params: { simulatorId, elementRef: locationRef },
    });
  });

  it('prefers an identified sheet list over background scroll views in flattened sheets', () => {
    recordSnapshot([
      createNode({
        type: 'Application',
        role: 'AXApplication',
        AXLabel: 'Example',
        frame: { x: 0, y: 0, width: 390, height: 844 },
        children: [
          createNode({
            type: 'ScrollView',
            role: 'AXScrollArea',
            frame: { x: 0, y: 110, width: 390, height: 210 },
            children: [
              createNode({ AXLabel: 'Now', frame: { x: 20, y: 130, width: 80, height: 40 } }),
            ],
          }),
          createNode({
            type: 'Table',
            role: 'AXTable',
            AXIdentifier: 'example.locationsSheet',
            frame: { x: 0, y: 360, width: 390, height: 484 },
            children: [
              createNode({ AXLabel: 'Close', frame: { x: 320, y: 370, width: 44, height: 44 } }),
              createNode({
                type: 'TextField',
                role: 'AXTextField',
                AXValue: 'London',
                frame: { x: 20, y: 430, width: 300, height: 44 },
              }),
              createNode({
                AXLabel: 'London, England, United Kingdom',
                AXValue: 'saved',
                frame: { x: 20, y: 500, width: 350, height: 88 },
              }),
            ],
          }),
        ],
      }),
    ]);

    const snapshot = currentRuntimeSnapshot();
    const sheetListRef = snapshot.elements.find(
      (element) => element.identifier === 'example.locationsSheet',
    )?.ref;

    const steps = createRuntimeSnapshotNextSteps({
      simulatorId,
      runtimeSnapshot: snapshot,
      includeRefreshAndWait: false,
    });

    expect(steps).toContainEqual({
      label: 'Scroll visible content',
      tool: 'swipe',
      params: {
        simulatorId,
        withinElementRef: sheetListRef,
        direction: 'up',
        distance: 0.5,
      },
    });
  });

  it('prefers a foreground sheet list over application root sheet scrolling', () => {
    recordSnapshot([
      createNode({
        type: 'Application',
        role: 'AXApplication',
        AXLabel: 'Example',
        frame: { x: 0, y: 0, width: 390, height: 844 },
        children: [
          createNode({
            type: 'Button',
            role: 'AXButton',
            AXLabel: 'Sheet Grabber',
            frame: { x: 157, y: 300, width: 76, height: 8 },
          }),
          createNode({
            type: 'Table',
            role: 'AXTable',
            AXIdentifier: 'example.sheetList',
            frame: { x: 0, y: 320, width: 390, height: 524 },
            children: [
              createNode({ AXLabel: 'Close', frame: { x: 320, y: 340, width: 44, height: 44 } }),
              createNode({
                type: 'TextField',
                role: 'AXTextField',
                AXLabel: 'Search',
                frame: { x: 20, y: 390, width: 300, height: 44 },
              }),
            ],
          }),
        ],
      }),
    ]);

    const snapshot = currentRuntimeSnapshot();
    const rootRef = snapshot.elements.find((element) => element.role === 'application')?.ref;
    const listRef = snapshot.elements.find(
      (element) => element.identifier === 'example.sheetList',
    )?.ref;

    expect(rootRef).toBeDefined();
    expect(listRef).toBeDefined();
    expect(snapshot.elements.find((element) => element.ref === rootRef)?.actions).not.toContain(
      'swipeWithin',
    );

    const steps = createRuntimeSnapshotNextSteps({
      simulatorId,
      runtimeSnapshot: snapshot,
      includeRefreshAndWait: false,
    });

    expect(steps).toContainEqual({
      label: 'Scroll visible content',
      tool: 'swipe',
      params: {
        simulatorId,
        withinElementRef: listRef,
        direction: 'up',
        distance: 0.5,
      },
    });
  });

  it('does not suggest synthetic sheet scrolling when no real sheet scroll target exists', () => {
    recordSnapshot([
      createNode({
        type: 'Application',
        role: 'AXApplication',
        AXLabel: 'Weather',
        frame: { x: 0, y: 0, width: 402, height: 874 },
        children: [
          createNode({
            type: 'ScrollView',
            role: 'AXScrollArea',
            AXIdentifier: 'example.backgroundScroll',
            frame: { x: 0, y: 80, width: 402, height: 260 },
          }),
          createNode({
            type: 'Button',
            role: 'AXButton',
            AXLabel: 'Sheet Grabber',
            frame: { x: 163, y: 57, width: 76, height: 25 },
          }),
          createNode({
            type: 'StaticText',
            role: 'AXStaticText',
            AXLabel: 'Locations',
            AXIdentifier: 'example.locationsSheet',
            frame: { x: 148, y: 104, width: 106, height: 32 },
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
            AXLabel: 'Use current location',
            AXIdentifier: 'example.locationsSheet',
            frame: { x: 20, y: 218, width: 362, height: 54 },
          }),
          createNode({
            type: 'StaticText',
            role: 'AXStaticText',
            AXLabel: 'MY LOCATIONS · 7',
            AXIdentifier: 'example.locationsSheet',
            frame: { x: 20, y: 292, width: 160, height: 20 },
          }),
          createNode({
            AXLabel: 'San Francisco, 1:24 PM · Cloudy',
            frame: { x: 20, y: 326, width: 362, height: 72 },
          }),
          createNode({
            AXLabel: 'Portland, 1:24 PM · Light Rain',
            frame: { x: 20, y: 415, width: 362, height: 72 },
          }),
          createNode({
            AXLabel: 'Aspen, 2:24 PM · Light Snow',
            frame: { x: 20, y: 504, width: 362, height: 72 },
          }),
        ],
      }),
    ]);

    const snapshot = currentRuntimeSnapshot();
    const rootRef = snapshot.elements.find((element) => element.role === 'application')?.ref;

    expect(rootRef).toBeDefined();
    expect(
      snapshot.elements.find(
        (element) => element.identifier === 'mobilebuildmcp.inferred.sheet-content',
      ),
    ).toBeUndefined();
    expect(snapshot.elements.find((element) => element.ref === rootRef)?.actions).not.toContain(
      'swipeWithin',
    );

    const steps = createRuntimeSnapshotNextSteps({
      simulatorId,
      runtimeSnapshot: snapshot,
      includeRefreshAndWait: false,
    });

    expect(steps.some((step) => step.tool === 'swipe')).toBe(false);
  });

  it('suggests expanding a collapsed foreground sheet via its real grabber', () => {
    recordSnapshot([
      createNode({
        type: 'Application',
        role: 'AXApplication',
        AXLabel: 'Example',
        frame: { x: 0, y: 0, width: 440, height: 956 },
        children: [
          createNode({
            type: 'Button',
            role: 'AXButton',
            AXLabel: 'Sheet Grabber',
            AXValue: 'Half screen',
            frame: { x: 182, y: 446, width: 76, height: 24 },
          }),
          createNode({
            type: 'Button',
            role: 'AXButton',
            AXLabel: 'Close',
            AXIdentifier: 'example.sheet',
            frame: { x: 374, y: 478, width: 44, height: 44 },
          }),
          createNode({
            type: 'TextField',
            role: 'AXTextField',
            AXValue: 'Search',
            AXIdentifier: 'example.sheet',
            frame: { x: 20, y: 518, width: 400, height: 44 },
          }),
          createNode({
            type: 'Button',
            role: 'AXButton',
            AXLabel: 'Use current location',
            AXIdentifier: 'example.sheet',
            frame: { x: 20, y: 580, width: 400, height: 44 },
          }),
          createNode({
            type: 'Button',
            role: 'AXButton',
            AXLabel: 'First visible row',
            frame: { x: 20, y: 650, width: 400, height: 72 },
          }),
        ],
      }),
    ]);

    const snapshot = currentRuntimeSnapshot();
    const grabberRef = snapshot.elements.find((element) => element.label === 'Sheet Grabber')?.ref;
    const steps = createRuntimeSnapshotNextSteps({
      simulatorId,
      runtimeSnapshot: snapshot,
      includeRefreshAndWait: false,
    });

    expect(steps[0]).toEqual({
      label: 'Expand foreground sheet',
      tool: 'drag',
      params: {
        simulatorId,
        elementRef: grabberRef,
        direction: 'up',
        distance: 0.35,
        duration: 0.8,
        steps: 80,
        postDelay: 0.8,
      },
    });
    expect(steps.some((step) => step.tool === 'swipe')).toBe(false);
    expect(steps.some((step) => step.tool === 'batch')).toBe(false);
  });

  it('prefers composite dragging real foreground sheet scroll content after expansion', () => {
    recordSnapshot([
      createNode({
        type: 'Application',
        role: 'AXApplication',
        AXLabel: 'Example',
        frame: { x: 0, y: 0, width: 440, height: 956 },
        children: [
          createNode({
            type: 'Button',
            role: 'AXButton',
            AXLabel: 'Sheet Grabber',
            AXValue: 'Expanded',
            frame: { x: 182, y: 57, width: 76, height: 25 },
          }),
          createNode({
            type: 'ScrollView',
            role: 'AXScrollArea',
            AXIdentifier: 'example.locationsSheet',
            frame: { x: 20, y: 255, width: 400, height: 637 },
            children: [
              createNode({
                type: 'Button',
                role: 'AXButton',
                AXLabel: 'Edit',
                AXIdentifier: 'example.locationsSheet',
                frame: { x: 20, y: 96, width: 44, height: 44 },
              }),
              createNode({
                type: 'Button',
                role: 'AXButton',
                AXLabel: 'Close',
                AXIdentifier: 'example.locationsSheet',
                frame: { x: 374, y: 96, width: 44, height: 44 },
              }),
              createNode({
                type: 'Button',
                role: 'AXButton',
                AXLabel: 'Use current location',
                AXIdentifier: 'example.locationsSheet',
                frame: { x: 20, y: 240, width: 400, height: 44 },
              }),
              createNode({
                type: 'Button',
                role: 'AXButton',
                AXLabel: 'San Francisco, 1:24 PM · Mostly Sunny',
                frame: { x: 20, y: 326, width: 400, height: 72 },
              }),
            ],
          }),
        ],
      }),
    ]);

    const snapshot = currentRuntimeSnapshot();
    const sheetScrollRef = snapshot.elements.find(
      (element) => element.identifier === 'example.locationsSheet',
    )?.ref;
    const steps = createRuntimeSnapshotNextSteps({
      simulatorId,
      runtimeSnapshot: snapshot,
      includeRefreshAndWait: false,
    });

    expect(steps[0]).toEqual({
      label: 'Drag visible sheet content',
      tool: 'drag',
      params: {
        simulatorId,
        elementRef: sheetScrollRef,
        direction: 'up',
        distance: 0.7,
        duration: 0.8,
        steps: 80,
        postDelay: 0.5,
      },
    });
  });

  it('prefers a vertical list over a small horizontal scroll view for upward scroll guidance', () => {
    recordSnapshot([
      createNode({
        type: 'Application',
        role: 'AXApplication',
        AXLabel: 'Example',
        frame: { x: 0, y: 0, width: 390, height: 844 },
        children: [
          createNode({
            type: 'ScrollView',
            role: 'AXScrollArea',
            AXIdentifier: 'example.horizontalScroller',
            frame: { x: 20, y: 100, width: 350, height: 120 },
          }),
          createNode({
            type: 'Table',
            role: 'AXTable',
            AXIdentifier: 'example.verticalList',
            frame: { x: 0, y: 240, width: 390, height: 520 },
          }),
        ],
      }),
    ]);

    const snapshot = currentRuntimeSnapshot();
    const verticalListRef = snapshot.elements.find(
      (element) => element.identifier === 'example.verticalList',
    )?.ref;

    const steps = createRuntimeSnapshotNextSteps({
      simulatorId,
      runtimeSnapshot: snapshot,
      includeRefreshAndWait: false,
    });

    expect(steps).toContainEqual({
      label: 'Scroll visible content',
      tool: 'swipe',
      params: {
        simulatorId,
        withinElementRef: verticalListRef,
        direction: 'up',
        distance: 0.5,
      },
    });
  });

  it('keeps unselected tabs available as screen-changing tap suggestions', () => {
    recordSnapshot([
      createNode({
        type: 'Tab',
        role: 'AXTab',
        AXLabel: 'Current',
        AXValue: 'selected',
        AXSelected: true,
      }),
      createNode({
        type: 'Tab',
        role: 'AXTab',
        AXLabel: 'Search',
        AXValue: '0',
        AXSelected: false,
      }),
    ]);

    const snapshot = currentRuntimeSnapshot();
    const searchTabRef = snapshot.elements.find((element) => element.label === 'Search')?.ref;

    const steps = createRuntimeSnapshotNextSteps({
      simulatorId,
      runtimeSnapshot: snapshot,
      includeRefreshAndWait: false,
    });

    expect(steps).toContainEqual({
      label: 'Tap an elementRef',
      tool: 'tap',
      params: { simulatorId, elementRef: searchTabRef },
    });
  });

  it('promotes visible switches as a batch next step', () => {
    recordSnapshot([
      createScrollView({
        AXIdentifier: 'settings.sheet',
        children: [
          createNode({
            type: 'Switch',
            role: 'AXSwitch',
            AXLabel: 'Atmospheric animations',
            AXValue: '1',
          }),
          createNode({
            type: 'Switch',
            role: 'AXSwitch',
            AXLabel: 'Severe weather alerts',
            AXValue: '1',
          }),
          createNode({
            type: 'Switch',
            role: 'AXSwitch',
            AXLabel: 'Reduce transparency',
            AXValue: '0',
          }),
        ],
      }),
    ]);

    const snapshot = currentRuntimeSnapshot();
    const switchRefs = snapshot.elements
      .filter((element) => element.role === 'switch')
      .map((element) => element.ref);

    const steps = createRuntimeSnapshotNextSteps({
      simulatorId,
      runtimeSnapshot: snapshot,
      includeRefreshAndWait: false,
    });

    expect(steps).toContainEqual({
      label: 'Batch visible switch toggles',
      tool: 'batch',
      params: {
        simulatorId,
        steps: switchRefs.slice(0, 2).map((elementRef) => ({
          action: 'tap',
          elementRef,
        })),
      },
    });
    expect(steps.find((step) => step.tool === 'tap')).toBeUndefined();
  });

  it('omits unchanged repeated switch refs from batch next steps', () => {
    recordSnapshot([
      createScrollView({
        AXIdentifier: 'settings.sheet',
        children: [
          createNode({
            type: 'Switch',
            role: 'AXSwitch',
            AXLabel: 'Atmospheric animations',
            AXValue: '1',
          }),
          createNode({
            type: 'Switch',
            role: 'AXSwitch',
            AXLabel: 'Severe weather alerts',
            AXValue: '1',
          }),
          createNode({
            type: 'Switch',
            role: 'AXSwitch',
            AXLabel: 'Reduce transparency',
            AXValue: '0',
          }),
        ],
      }),
    ]);

    const snapshot = currentRuntimeSnapshot();
    const switchRefs = snapshot.elements
      .filter((element) => element.role === 'switch')
      .map((element) => element.ref);

    const steps = createRuntimeSnapshotNextSteps({
      simulatorId,
      runtimeSnapshot: snapshot,
      includeRefreshAndWait: false,
      actionContext: {
        action: { type: 'tap', elementRef: switchRefs[0]! },
        previousScreenHash: snapshot.screenHash,
        actionTarget: { value: '1' },
      },
    });

    expect(steps).toContainEqual({
      label: 'Batch visible switch toggles',
      tool: 'batch',
      params: {
        simulatorId,
        steps: switchRefs.slice(1, 3).map((elementRef) => ({
          action: 'tap',
          elementRef,
        })),
      },
    });
  });

  it('keeps repeated switch refs in batch next steps when exposed state changed', () => {
    recordSnapshot([
      createScrollView({
        AXIdentifier: 'settings.sheet',
        children: [
          createNode({
            type: 'Switch',
            role: 'AXSwitch',
            AXLabel: 'Atmospheric animations',
            AXValue: '1',
          }),
          createNode({
            type: 'Switch',
            role: 'AXSwitch',
            AXLabel: 'Severe weather alerts',
            AXValue: '1',
          }),
          createNode({
            type: 'Switch',
            role: 'AXSwitch',
            AXLabel: 'Reduce transparency',
            AXValue: '0',
          }),
        ],
      }),
    ]);

    const snapshot = currentRuntimeSnapshot();
    const switchRefs = snapshot.elements
      .filter((element) => element.role === 'switch')
      .map((element) => element.ref);

    const steps = createRuntimeSnapshotNextSteps({
      simulatorId,
      runtimeSnapshot: snapshot,
      includeRefreshAndWait: false,
      actionContext: {
        action: { type: 'tap', elementRef: switchRefs[0]! },
        previousScreenHash: snapshot.screenHash,
        actionTarget: { value: '0' },
      },
    });

    expect(steps).toContainEqual({
      label: 'Batch visible switch toggles',
      tool: 'batch',
      params: {
        simulatorId,
        steps: switchRefs.slice(0, 2).map((elementRef) => ({
          action: 'tap',
          elementRef,
        })),
      },
    });
  });

  it('uses hierarchy depth only as a foreground-root tie breaker', () => {
    recordSnapshot([
      nestNode(
        createScrollView({
          AXIdentifier: 'deep.stateControls',
          frame: { x: 0, y: 0, width: 390, height: 80 },
          children: [
            createNode({
              type: 'Switch',
              role: 'AXSwitch',
              AXLabel: 'Nested switch',
              AXValue: '0',
            }),
          ],
        }),
        40,
      ),
      createScrollView({
        AXIdentifier: 'shallow.searchPanel',
        frame: { x: 0, y: 100, width: 390, height: 500 },
        children: [
          createNode({
            type: 'TextField',
            role: 'AXTextField',
            AXLabel: 'Search',
            frame: { x: 20, y: 130, width: 350, height: 40 },
          }),
        ],
      }),
    ]);

    const snapshot = currentRuntimeSnapshot();
    const shallowSearchRef = snapshot.elements.find(
      (element) => element.identifier === 'shallow.searchPanel',
    )?.ref;

    const steps = createRuntimeSnapshotNextSteps({
      simulatorId,
      runtimeSnapshot: snapshot,
      includeRefreshAndWait: false,
    });

    expect(steps).toContainEqual({
      label: 'Scroll visible content',
      tool: 'swipe',
      params: {
        simulatorId,
        withinElementRef: shallowSearchRef,
        direction: 'up',
        distance: 0.5,
      },
    });
  });
});
