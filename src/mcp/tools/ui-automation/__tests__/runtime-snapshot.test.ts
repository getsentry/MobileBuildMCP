import { describe, expect, it } from 'vitest';
import type { AccessibilityNode } from '../../../../types/domain-results.ts';
import {
  createRuntimeSnapshotRecord,
  extractAccessibilityHierarchy,
  getPrimaryRuntimeElement,
  parseRuntimeSnapshotResponse,
  getRuntimeElementActivationPoint,
  getRuntimeElementDirectionalDragPoints,
  getRuntimeElementSwipePoints,
  RuntimeSnapshotParseError,
} from '../shared/runtime-snapshot.ts';

const simulatorId = '12345678-1234-4234-8234-123456789012';

function createNode(overrides: Partial<AccessibilityNode> = {}): AccessibilityNode {
  return {
    type: 'Button',
    role: 'AXButton',
    frame: { x: 10, y: 20, width: 100, height: 40 },
    children: [],
    enabled: true,
    custom_actions: [],
    ...overrides,
  };
}

describe('runtime snapshot normalization', () => {
  it('flattens AX hierarchy into RuntimeSnapshotV1 public elements', () => {
    const child = createNode({
      type: 'TextField',
      role: 'AXTextField',
      AXLabel: 'Email',
      AXValue: 'user@example.com',
      AXUniqueId: 'email-field',
      AXSelected: true,
      frame: { x: 20, y: 80, width: 220, height: 44 },
    });
    const root = createNode({
      type: 'Window',
      role: 'AXWindow',
      frame: { x: 0, y: 0, width: 390, height: 844 },
      children: [child],
    });

    const snapshot = createRuntimeSnapshotRecord({
      simulatorId,
      uiHierarchy: [root],
      nowMs: 1_000,
    });

    expect(snapshot.payload).toEqual(
      expect.objectContaining({
        type: 'runtime-snapshot',
        protocol: 'rs/1',
        simulatorId,
        capturedAtMs: 1_000,
        expiresAtMs: 61_000,
      }),
    );
    expect(snapshot.payload.elements.map((element) => element.ref)).toEqual(['e1', 'e2']);
    expect(snapshot.payload.elements[1]).toEqual(
      expect.objectContaining({
        ref: 'e2',
        role: 'text-field',
        label: 'Email',
        value: 'user@example.com',
        identifier: 'email-field',
        frame: { x: 20, y: 80, width: 220, height: 44 },
        state: { enabled: true, selected: true, visible: true },
        actions: expect.arrayContaining(['tap', 'typeText', 'longPress', 'touch']),
      }),
    );
    expect(snapshot.payload.screenHash).toMatch(/^[a-z0-9]+$/);
    expect(snapshot.payload.seq).toBe(0);
    expect(snapshot.payload.actions).toContainEqual({
      action: 'typeText',
      elementRef: 'e2',
      label: 'Email',
    });
    expect(snapshot.elements[1]?.rawNode).toBe(child);
    expect('rawNode' in snapshot.payload.elements[1]!).toBe(false);
    expect(snapshot.elementsByRef.get('e2')?.rawNode).toBe(child);
  });

  it('reads AXIdentifier as a stable runtime element identifier', () => {
    const snapshot = createRuntimeSnapshotRecord({
      simulatorId,
      uiHierarchy: [createNode({ AXIdentifier: 'weather.detailsButton' })],
      nowMs: 1_000,
    });

    expect(snapshot.payload.elements[0]).toEqual(
      expect.objectContaining({ identifier: 'weather.detailsButton' }),
    );
  });

  it('classifies text views as text-entry controls', () => {
    const snapshot = createRuntimeSnapshotRecord({
      simulatorId,
      uiHierarchy: [
        createNode({
          type: 'XCUIElementTypeTextView',
          role: 'XCUIElementTypeTextView',
          AXLabel: 'Notes',
          AXValue: 'Draft',
          frame: { x: 20, y: 80, width: 240, height: 120 },
        }),
      ],
      nowMs: 1_000,
    });

    expect(snapshot.payload.elements[0]).toEqual(
      expect.objectContaining({
        role: 'text-field',
        label: 'Notes',
        value: 'Draft',
        actions: expect.arrayContaining(['tap', 'typeText']),
      }),
    );
  });

  it('classifies context menu items as menu controls instead of text', () => {
    const snapshot = createRuntimeSnapshotRecord({
      simulatorId,
      uiHierarchy: [
        createNode({
          type: 'MenuItem',
          role: 'AXMenuItem',
          role_description: 'context menu item',
        }),
      ],
      nowMs: 1_000,
    });

    expect(snapshot.payload.elements[0]).toEqual(
      expect.objectContaining({
        role: 'menu',
        actions: expect.arrayContaining(['longPress', 'touch']),
      }),
    );
    expect(snapshot.payload.elements[0]?.actions).not.toContain('tap');
  });

  it('classifies tab radio buttons from AXe as tabs', () => {
    const snapshot = createRuntimeSnapshotRecord({
      simulatorId,
      uiHierarchy: [
        createNode({
          type: 'RadioButton',
          role: 'AXRadioButton',
          role_description: 'tab',
          AXLabel: 'Reports',
          AXValue: '0',
        }),
      ],
      nowMs: 1_000,
    });

    expect(snapshot.payload.elements[0]).toEqual(
      expect.objectContaining({
        role: 'tab',
        label: 'Reports',
        value: '0',
        actions: expect.arrayContaining(['tap', 'longPress', 'touch']),
      }),
    );
  });

  // Regression coverage for issue #442. A `.accessibilityIdentifier(...)` applied to a
  // SwiftUI `Tab` is not forwarded to the native tab bar item's accessibility element,
  // so `describe-ui` reports no AXUniqueId/AXIdentifier for the tab (confirmed by
  // reproducing on a simulator: the identifier string is absent from the entire AX
  // tree, while an identifier on the tab's content still propagates normally). The
  // snapshot must still expose the tab for automation via role + label, and must not
  // invent an identifier or leak the tab's SF Symbol image identifier onto the tab.
  it('does not surface an identifier for SwiftUI tabs that expose none (issue #442)', () => {
    const snapshot = createRuntimeSnapshotRecord({
      simulatorId,
      uiHierarchy: [
        createNode({
          type: 'RadioButton',
          role: 'AXRadioButton',
          subrole: 'AXTabButton',
          role_description: 'tab',
          AXLabel: 'Wheels',
          AXValue: '0',
          frame: { x: 120, y: 780, width: 80, height: 50 },
          children: [
            createNode({
              type: 'Image',
              role: 'AXImage',
              role_description: 'image',
              AXLabel: 'arrow.trianglehead.2.clockwise',
              AXUniqueId: 'arrow.trianglehead.2.clockwise',
              frame: { x: 140, y: 786, width: 30, height: 30 },
            }),
          ],
        }),
      ],
      nowMs: 1_000,
    });

    const tab = snapshot.payload.elements.find((element) => element.role === 'tab');
    expect(tab).toEqual(
      expect.objectContaining({
        role: 'tab',
        label: 'Wheels',
        value: '0',
        actions: expect.arrayContaining(['tap']),
      }),
    );
    expect(tab).not.toHaveProperty('identifier');
  });

  it('surfaces a tab identifier when the platform does expose one (issue #442)', () => {
    const snapshot = createRuntimeSnapshotRecord({
      simulatorId,
      uiHierarchy: [
        createNode({
          type: 'RadioButton',
          role: 'AXRadioButton',
          subrole: 'AXTabButton',
          role_description: 'tab',
          AXLabel: 'Wheels',
          AXValue: '0',
          AXUniqueId: 'tab_wheels',
        }),
      ],
      nowMs: 1_000,
    });

    expect(snapshot.payload.elements.find((element) => element.role === 'tab')).toEqual(
      expect.objectContaining({ role: 'tab', label: 'Wheels', identifier: 'tab_wheels' }),
    );
  });

  it('derives deterministic screen hashes from normalized UI content', () => {
    const uiHierarchy = [createNode({ AXLabel: 'Continue' }), createNode({ AXLabel: 'Cancel' })];

    const first = createRuntimeSnapshotRecord({ simulatorId, uiHierarchy, nowMs: 1_000 });
    const second = createRuntimeSnapshotRecord({ simulatorId, uiHierarchy, nowMs: 2_000 });
    const changed = createRuntimeSnapshotRecord({
      simulatorId,
      uiHierarchy: [createNode({ AXLabel: 'Continue' }), createNode({ AXLabel: 'Done' })],
      nowMs: 1_000,
    });

    expect(first.payload.screenHash).toBe(second.payload.screenHash);
    expect(first.payload.screenHash).not.toBe(changed.payload.screenHash);
  });

  it('parses AXe describe-ui response envelopes', () => {
    const responseText = JSON.stringify({
      elements: [createNode({ AXLabel: 'Continue' })],
    });

    const hierarchy = extractAccessibilityHierarchy(responseText);

    expect(hierarchy).toHaveLength(1);
    expect(hierarchy[0]?.AXLabel).toBe('Continue');
  });

  it('throws typed parse errors for malformed describe-ui responses', () => {
    expect(() => extractAccessibilityHierarchy('not json')).toThrow(RuntimeSnapshotParseError);
    expect(() => extractAccessibilityHierarchy(JSON.stringify({ value: [] }))).toThrow(
      RuntimeSnapshotParseError,
    );
    expect(() => extractAccessibilityHierarchy(JSON.stringify({}))).toThrow(
      RuntimeSnapshotParseError,
    );
  });

  it('allows empty describe-ui arrays only when the caller opts in', () => {
    expect(extractAccessibilityHierarchy(JSON.stringify([]))).toEqual([]);
    expect(extractAccessibilityHierarchy(JSON.stringify({ elements: [] }))).toEqual([]);
    expect(() => parseRuntimeSnapshotResponse({ simulatorId, responseText: '[]' })).toThrow(
      RuntimeSnapshotParseError,
    );

    const snapshot = parseRuntimeSnapshotResponse({
      simulatorId,
      responseText: '{"elements": []}',
      allowEmpty: true,
    });

    expect(snapshot.payload.elements).toEqual([]);
    expect(snapshot.payload.actions).toEqual([]);
  });

  it('selects the primary element for semantic next steps', () => {
    const snapshot = createRuntimeSnapshotRecord({
      simulatorId,
      uiHierarchy: [createNode({ AXLabel: 'Continue' })],
      nowMs: 1_000,
    });

    expect(getPrimaryRuntimeElement(snapshot.payload, 'tap')?.label).toBe('Continue');
    expect(getPrimaryRuntimeElement(snapshot.payload, 'typeText')).toBe(
      snapshot.payload.elements[0],
    );
  });

  it('infers swipeWithin on top-level application roots with semantic vertical overflow', () => {
    const root = createNode({
      type: 'Application',
      role: 'AXApplication',
      AXLabel: 'Example',
      frame: { x: 0, y: 0, width: 390, height: 844 },
      children: [
        createNode({
          type: 'Button',
          role: 'AXButton',
          AXLabel: 'Settings',
          frame: { x: 320, y: 40, width: 44, height: 44 },
        }),
        createNode({
          type: 'StaticText',
          role: 'AXStaticText',
          AXLabel: 'Details available below',
          frame: { x: 40, y: 920, width: 220, height: 24 },
        }),
      ],
    });

    const snapshot = createRuntimeSnapshotRecord({
      simulatorId,
      uiHierarchy: [root],
      nowMs: 1_000,
    });

    expect(snapshot.payload.elements[0]).toEqual(
      expect.objectContaining({
        ref: 'e1',
        role: 'application',
        label: 'Example',
        actions: ['swipeWithin'],
      }),
    );
    expect(snapshot.payload.actions).toContainEqual({
      action: 'swipeWithin',
      elementRef: 'e1',
      label: 'Example',
    });
    expect(getRuntimeElementSwipePoints(snapshot.elements[0]!, 'up')).toEqual({
      ok: true,
      from: { x: 195, y: 717 },
      to: { x: 195, y: 127 },
    });
  });

  it('infers swipeWithin on top-level windows with semantic vertical overflow', () => {
    const root = createNode({
      type: 'Window',
      role: 'AXWindow',
      AXLabel: 'Example',
      frame: { x: 0, y: 0, width: 390, height: 844 },
      children: [
        createNode({
          type: 'StaticText',
          role: 'AXStaticText',
          AXLabel: 'More content below',
          frame: { x: 140, y: 920, width: 160, height: 24 },
        }),
      ],
    });

    const snapshot = createRuntimeSnapshotRecord({
      simulatorId,
      uiHierarchy: [root],
      nowMs: 1_000,
    });

    expect(snapshot.payload.elements[0]).toEqual(
      expect.objectContaining({
        ref: 'e1',
        role: 'window',
        label: 'Example',
        actions: ['swipeWithin'],
      }),
    );
  });

  it('does not infer swipeWithin when descendants fit inside the container', () => {
    const root = createNode({
      type: 'Application',
      role: 'AXApplication',
      frame: { x: 0, y: 0, width: 390, height: 844 },
      children: [
        createNode({
          type: 'StaticText',
          role: 'AXStaticText',
          AXLabel: 'Visible label',
          frame: { x: 20, y: 200, width: 120, height: 20 },
        }),
      ],
    });

    const snapshot = createRuntimeSnapshotRecord({
      simulatorId,
      uiHierarchy: [root],
      nowMs: 1_000,
    });

    expect(snapshot.payload.elements[0]?.actions).toEqual([]);
  });

  it('does not infer root viewport swipeWithin from anonymous geometry-only overflow', () => {
    const root = createNode({
      type: 'Application',
      role: 'AXApplication',
      frame: { x: 0, y: 0, width: 390, height: 844 },
      children: [
        createNode({
          type: 'Other',
          role: 'AXGroup',
          AXLabel: undefined,
          AXValue: undefined,
          AXIdentifier: undefined,
          frame: { x: 20, y: 920, width: 240, height: 80 },
        }),
      ],
    });

    const snapshot = createRuntimeSnapshotRecord({
      simulatorId,
      uiHierarchy: [root],
      nowMs: 1_000,
    });

    expect(snapshot.payload.elements[0]?.actions).toEqual([]);
  });

  it('does not infer root viewport swipeWithin when a better descendant scroll target exists', () => {
    const root = createNode({
      type: 'Application',
      role: 'AXApplication',
      AXLabel: 'Example',
      frame: { x: 0, y: 0, width: 390, height: 844 },
      children: [
        createNode({
          type: 'ScrollView',
          role: 'AXScrollArea',
          AXIdentifier: 'app.contentPanel',
          frame: { x: 0, y: 100, width: 390, height: 600 },
        }),
        createNode({
          type: 'StaticText',
          role: 'AXStaticText',
          AXLabel: 'Additional details below',
          frame: { x: 40, y: 920, width: 220, height: 24 },
        }),
      ],
    });

    const snapshot = createRuntimeSnapshotRecord({
      simulatorId,
      uiHierarchy: [root],
      nowMs: 1_000,
    });

    expect(snapshot.payload.elements[0]?.actions).not.toContain('swipeWithin');
    expect(snapshot.payload.elements[1]).toEqual(
      expect.objectContaining({
        role: 'scroll-view',
        identifier: 'app.contentPanel',
        actions: expect.arrayContaining(['swipeWithin']),
      }),
    );
  });

  it('infers swipeWithin from deeply nested overflowing descendants', () => {
    const snapshot = createRuntimeSnapshotRecord({
      simulatorId,
      uiHierarchy: [
        createNode({
          type: 'Other',
          role: 'AXGroup',
          AXLabel: 'Scrollable panel',
          frame: { x: 0, y: 0, width: 300, height: 300 },
          children: [
            createNode({
              type: 'Other',
              role: 'AXGroup',
              frame: { x: 10, y: 10, width: 280, height: 280 },
              children: [
                createNode({
                  type: 'Other',
                  role: 'AXGroup',
                  frame: { x: 20, y: 20, width: 260, height: 260 },
                  children: [
                    createNode({
                      type: 'StaticText',
                      role: 'AXStaticText',
                      AXLabel: 'Overflow',
                      frame: { x: 30, y: 360, width: 120, height: 20 },
                    }),
                  ],
                }),
              ],
            }),
          ],
        }),
      ],
      nowMs: 1_000,
    });

    expect(snapshot.payload.elements[0]).toEqual(
      expect.objectContaining({
        role: 'other',
        label: 'Scrollable panel',
        actions: expect.arrayContaining(['swipeWithin']),
      }),
    );
  });

  it('does not infer root viewport swipeWithin when a sheet grabber is nested', () => {
    const root = createNode({
      type: 'Application',
      role: 'AXApplication',
      AXLabel: 'Example',
      frame: { x: 0, y: 0, width: 390, height: 844 },
      children: [
        createNode({
          type: 'Other',
          role: 'AXGroup',
          frame: { x: 0, y: 0, width: 390, height: 120 },
          children: [
            createNode({
              type: 'Button',
              role: 'AXButton',
              AXLabel: 'Sheet Grabber',
              frame: { x: 157, y: 56, width: 76, height: 24 },
            }),
          ],
        }),
        createNode({
          type: 'StaticText',
          role: 'AXStaticText',
          AXLabel: 'More content below',
          frame: { x: 40, y: 920, width: 220, height: 24 },
        }),
      ],
    });

    const snapshot = createRuntimeSnapshotRecord({
      simulatorId,
      uiHierarchy: [root],
      nowMs: 1_000,
    });

    expect(snapshot.payload.elements[0]).toEqual(
      expect.objectContaining({
        role: 'application',
        label: 'Example',
        actions: [],
      }),
    );
  });

  it('does not infer root viewport swipeWithin when a better nested scroll target exists', () => {
    const root = createNode({
      type: 'Application',
      role: 'AXApplication',
      AXLabel: 'Example',
      frame: { x: 0, y: 0, width: 390, height: 844 },
      children: [
        createNode({
          type: 'Other',
          role: 'AXGroup',
          frame: { x: 0, y: 100, width: 390, height: 600 },
          children: [
            createNode({
              type: 'ScrollView',
              role: 'AXScrollArea',
              AXIdentifier: 'app.nestedContentPanel',
              frame: { x: 0, y: 100, width: 390, height: 600 },
            }),
          ],
        }),
        createNode({
          type: 'StaticText',
          role: 'AXStaticText',
          AXLabel: 'Additional details below',
          frame: { x: 40, y: 920, width: 220, height: 24 },
        }),
      ],
    });

    const snapshot = createRuntimeSnapshotRecord({
      simulatorId,
      uiHierarchy: [root],
      nowMs: 1_000,
    });

    expect(snapshot.payload.elements[0]?.actions).not.toContain('swipeWithin');
    expect(
      snapshot.payload.elements.find((element) => element.identifier === 'app.nestedContentPanel'),
    ).toEqual(
      expect.objectContaining({
        role: 'scroll-view',
        actions: expect.arrayContaining(['swipeWithin']),
      }),
    );
  });

  it('does not synthesize a foreground sheet scroll region without a real scroll descendant', () => {
    const root = createNode({
      type: 'Application',
      role: 'AXApplication',
      AXLabel: 'Example',
      frame: { x: 0, y: 0, width: 402, height: 874 },
      children: [
        createNode({
          type: 'Button',
          role: 'AXButton',
          AXLabel: 'Sheet Grabber',
          AXValue: 'Expanded',
          frame: { x: 163, y: 57, width: 76, height: 25 },
        }),
        createNode({
          type: 'Switch',
          role: 'AXSwitch',
          AXLabel: 'Reduce transparency',
          AXValue: '0',
          frame: { x: 36, y: 603, width: 330, height: 28 },
        }),
      ],
    });

    const snapshot = createRuntimeSnapshotRecord({
      simulatorId,
      uiHierarchy: [root],
      nowMs: 1_000,
    });

    expect(snapshot.payload.elements[0]).toEqual(
      expect.objectContaining({
        ref: 'e1',
        role: 'application',
        label: 'Example',
        actions: [],
      }),
    );
    expect(
      snapshot.payload.elements.find(
        (element) => element.identifier === 'mobilebuildmcp.inferred.sheet-content',
      ),
    ).toBeUndefined();
    expect(snapshot.payload.actions.some((action) => action.action === 'swipeWithin')).toBe(false);
  });

  it('does not synthesize a locations sheet scroll region over tappable rows', () => {
    const root = createNode({
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
          AXLabel: 'Close',
          AXIdentifier: 'example.locationsSheet',
          frame: { x: 330, y: 96, width: 44, height: 44 },
        }),
        createNode({
          type: 'TextField',
          role: 'AXTextField',
          AXValue: 'Search for a city, airport, or country',
          AXIdentifier: 'example.locationsSheet',
          frame: { x: 20, y: 150, width: 362, height: 44 },
        }),
        createNode({
          type: 'Button',
          role: 'AXButton',
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
          type: 'Button',
          role: 'AXButton',
          AXLabel: 'San Francisco, 1:24 PM · Cloudy',
          frame: { x: 20, y: 326, width: 362, height: 72 },
        }),
        createNode({
          type: 'Button',
          role: 'AXButton',
          AXLabel: 'Portland, 1:24 PM · Light Rain',
          frame: { x: 20, y: 415, width: 362, height: 72 },
        }),
        createNode({
          type: 'TextField',
          role: 'AXTextField',
          AXLabel: 'Body note',
          frame: { x: 20, y: 600, width: 362, height: 44 },
        }),
      ],
    });

    const snapshot = createRuntimeSnapshotRecord({
      simulatorId,
      uiHierarchy: [root],
      nowMs: 1_000,
    });
    expect(
      snapshot.payload.elements.find(
        (element) => element.identifier === 'mobilebuildmcp.inferred.sheet-content',
      ),
    ).toBeUndefined();
    expect(snapshot.payload.elements[0]?.actions).not.toContain('swipeWithin');
    expect(snapshot.payload.elements.find((element) => element.role === 'scroll-view')).toEqual(
      expect.objectContaining({
        identifier: 'example.backgroundScroll',
        actions: expect.arrayContaining(['swipeWithin']),
      }),
    );
  });

  it('does not advertise synthetic scrolling for live-shaped locations sheets', () => {
    const root = createNode({
      type: 'Application',
      role: 'AXApplication',
      AXLabel: 'Weather',
      frame: { x: 0, y: 0, width: 440, height: 956 },
      children: [
        createNode({
          type: 'Button',
          role: 'AXButton',
          AXLabel: 'Sheet Grabber',
          frame: { x: 182, y: 360, width: 76, height: 25 },
        }),
        createNode({
          type: 'StaticText',
          role: 'AXStaticText',
          AXLabel: 'Locations',
          AXIdentifier: 'example.locationsSheet',
          frame: { x: 168, y: 408, width: 106, height: 32 },
        }),
        createNode({
          type: 'Button',
          role: 'AXButton',
          AXLabel: 'Close',
          AXIdentifier: 'example.locationsSheet',
          frame: { x: 374, y: 400, width: 44, height: 44 },
        }),
        createNode({
          type: 'TextField',
          role: 'AXTextField',
          AXValue: 'Search for a city, airport, or country',
          AXIdentifier: 'example.locationsSheet',
          frame: { x: 20, y: 450, width: 400, height: 44 },
        }),
        createNode({
          type: 'StaticText',
          role: 'AXStaticText',
          AXLabel: 'MY LOCATIONS · 8',
          AXIdentifier: 'example.locationsSheet',
          frame: { x: 20, y: 566, width: 160, height: 20 },
        }),
        createNode({
          type: 'Button',
          role: 'AXButton',
          AXLabel: 'MY LOCATION, San Francisco, 1:24 PM · Mostly Sunny',
          frame: { x: 20, y: 596, width: 400, height: 72 },
        }),
        createNode({
          type: 'Button',
          role: 'AXButton',
          AXLabel: 'Portland, 1:24 PM · Light Rain',
          frame: { x: 20, y: 686, width: 400, height: 72 },
        }),
        createNode({
          type: 'Button',
          role: 'AXButton',
          AXLabel: 'Aspen, 2:24 PM · Light Snow',
          frame: { x: 20, y: 776, width: 400, height: 72 },
        }),
      ],
    });

    const snapshot = createRuntimeSnapshotRecord({
      simulatorId,
      uiHierarchy: [root],
      nowMs: 1_000,
    });
    expect(
      snapshot.payload.elements.find(
        (element) => element.identifier === 'mobilebuildmcp.inferred.sheet-content',
      ),
    ).toBeUndefined();
    expect(snapshot.payload.elements[0]?.actions).not.toContain('swipeWithin');
    expect(snapshot.payload.actions.some((action) => action.action === 'swipeWithin')).toBe(false);
  });

  it('does not synthesize sheet host swipe frames when the grabber is near the bottom', () => {
    const root = createNode({
      type: 'Application',
      role: 'AXApplication',
      AXLabel: 'Example',
      frame: { x: 0, y: 0, width: 390, height: 844 },
      children: [
        createNode({
          type: 'Button',
          role: 'AXButton',
          AXLabel: 'Sheet Grabber',
          AXValue: 'Expanded',
          frame: { x: 157, y: 620, width: 76, height: 5 },
        }),
      ],
    });

    const snapshot = createRuntimeSnapshotRecord({
      simulatorId,
      uiHierarchy: [root],
      nowMs: 1_000,
    });

    expect(snapshot.payload.elements[0]?.actions).toEqual([]);
    expect(
      snapshot.payload.elements.find(
        (element) => element.identifier === 'mobilebuildmcp.inferred.sheet-content',
      ),
    ).toBeUndefined();
  });

  it('removes actions from elements outside the viewport', () => {
    const root = createNode({
      type: 'Application',
      role: 'AXApplication',
      frame: { x: 0, y: 0, width: 390, height: 844 },
      children: [
        createNode({
          type: 'Switch',
          role: 'AXSwitch',
          AXLabel: 'Reduce transparency',
          AXValue: '0',
          frame: { x: 40, y: 890, width: 300, height: 30 },
        }),
      ],
    });

    const snapshot = createRuntimeSnapshotRecord({
      simulatorId,
      uiHierarchy: [root],
      nowMs: 1_000,
    });

    expect(snapshot.payload.elements[1]).toEqual(
      expect.objectContaining({
        role: 'switch',
        label: 'Reduce transparency',
        value: '0',
        state: expect.objectContaining({ visible: false }),
        actions: [],
      }),
    );
  });

  it('does not re-add swipeWithin to offscreen containers', () => {
    const root = createNode({
      type: 'Application',
      role: 'AXApplication',
      frame: { x: 0, y: 0, width: 390, height: 844 },
      children: [
        createNode({
          type: 'Other',
          role: 'AXGroup',
          AXLabel: 'Offscreen panel',
          frame: { x: 0, y: 900, width: 300, height: 200 },
          children: [
            createNode({
              type: 'StaticText',
              role: 'AXStaticText',
              AXLabel: 'Overflowing child',
              frame: { x: 10, y: 1160, width: 100, height: 20 },
            }),
          ],
        }),
      ],
    });

    const snapshot = createRuntimeSnapshotRecord({
      simulatorId,
      uiHierarchy: [root],
      nowMs: 1_000,
    });

    expect(snapshot.payload.elements[1]).toEqual(
      expect.objectContaining({
        role: 'other',
        label: 'Offscreen panel',
        state: expect.objectContaining({ visible: false }),
        actions: [],
      }),
    );
    expect(snapshot.payload.actions).not.toContainEqual({
      action: 'swipeWithin',
      elementRef: 'e2',
      label: 'Offscreen panel',
    });
  });

  it('removes point-based actions from clipped elements with offscreen activation points', () => {
    const root = createNode({
      type: 'Application',
      role: 'AXApplication',
      frame: { x: 0, y: 0, width: 402, height: 874 },
      children: [
        createNode({
          type: 'Button',
          role: 'AXButton',
          AXLabel: 'Lisbon',
          frame: { x: 20, y: 839.33, width: 362, height: 89 },
        }),
      ],
    });

    const snapshot = createRuntimeSnapshotRecord({
      simulatorId,
      uiHierarchy: [root],
      nowMs: 1_000,
    });

    expect(snapshot.payload.elements[1]).toEqual(
      expect.objectContaining({
        role: 'button',
        label: 'Lisbon',
        state: expect.objectContaining({ visible: true }),
        actions: [],
      }),
    );
  });

  it('uses an upper activation point for bottom-clipped visible targets', () => {
    const root = createNode({
      type: 'Application',
      role: 'AXApplication',
      frame: { x: 0, y: 0, width: 402, height: 874 },
      children: [
        createNode({
          type: 'Button',
          role: 'AXButton',
          AXLabel: 'Remove',
          frame: { x: 324.87, y: 786.62, width: 49.93, height: 85.46 },
        }),
      ],
    });

    const snapshot = createRuntimeSnapshotRecord({
      simulatorId,
      uiHierarchy: [root],
      nowMs: 1_000,
    });

    expect(snapshot.payload.elements[1]?.actions).toContain('tap');
    expect(getRuntimeElementActivationPoint(snapshot.elements[1]!)).toEqual({ x: 350, y: 795 });
  });

  it('does not mark unlabeled custom-action internals as tap targets', () => {
    const snapshot = createRuntimeSnapshotRecord({
      simulatorId,
      uiHierarchy: [
        createNode({
          type: 'Other',
          role: 'AXGroup',
          AXLabel: undefined,
          AXValue: undefined,
          AXUniqueId: undefined,
          identifier: undefined,
          frame: { x: 30, y: 450, width: 80, height: 32 },
          custom_actions: ['Press'],
        }),
        createNode({
          type: 'Other',
          role: 'AXGroup',
          AXUniqueId: 'label-view',
          frame: { x: 30, y: 500, width: 80, height: 32 },
          custom_actions: ['Press'],
        }),
        createNode({
          type: 'Other',
          role: 'AXGroup',
          AXUniqueId: 'named-custom-target',
          frame: { x: 30, y: 550, width: 80, height: 32 },
          custom_actions: ['Press'],
        }),
      ],
      nowMs: 1_000,
    });

    expect(snapshot.payload.elements[0]).toEqual(
      expect.objectContaining({
        role: 'other',
        actions: expect.not.arrayContaining(['tap']),
      }),
    );
    expect(snapshot.payload.elements[1]).toEqual(
      expect.objectContaining({
        role: 'other',
        identifier: 'label-view',
        actions: expect.not.arrayContaining(['tap']),
      }),
    );
    expect(snapshot.payload.elements[2]).toEqual(
      expect.objectContaining({
        role: 'other',
        identifier: 'named-custom-target',
        actions: expect.arrayContaining(['tap']),
      }),
    );
  });

  it('does not mark standalone other elements as swipeable', () => {
    const snapshot = createRuntimeSnapshotRecord({
      simulatorId,
      uiHierarchy: [
        createNode({
          type: 'Other',
          role: 'AXGroup',
          AXLabel: 'Suggested',
          frame: { x: 30, y: 450, width: 80, height: 32 },
        }),
      ],
      nowMs: 1_000,
    });

    expect(snapshot.payload.elements[0]).toEqual(
      expect.objectContaining({
        role: 'other',
        label: 'Suggested',
        actions: expect.not.arrayContaining(['swipeWithin']),
      }),
    );
  });

  it('does not infer swipeWithin on small other wrappers with overflowing descendants', () => {
    const snapshot = createRuntimeSnapshotRecord({
      simulatorId,
      uiHierarchy: [
        createNode({
          type: 'Other',
          role: 'AXGroup',
          frame: { x: 0, y: 0, width: 80, height: 80 },
          children: [
            createNode({
              type: 'StaticText',
              role: 'AXStaticText',
              AXLabel: 'Overflow',
              frame: { x: 10, y: 100, width: 100, height: 20 },
            }),
          ],
        }),
      ],
      nowMs: 1_000,
    });

    expect(snapshot.payload.elements[0]).toEqual(
      expect.objectContaining({
        role: 'other',
        actions: expect.not.arrayContaining(['swipeWithin']),
      }),
    );
  });

  it('infers swipeWithin on other containers with overflowing descendants', () => {
    const snapshot = createRuntimeSnapshotRecord({
      simulatorId,
      uiHierarchy: [
        createNode({
          type: 'Other',
          role: 'AXGroup',
          AXLabel: 'Scrollable panel',
          frame: { x: 0, y: 0, width: 200, height: 200 },
          children: [
            createNode({
              type: 'StaticText',
              role: 'AXStaticText',
              AXLabel: 'Overflow',
              frame: { x: 10, y: 260, width: 100, height: 20 },
            }),
          ],
        }),
      ],
      nowMs: 1_000,
    });

    expect(snapshot.payload.elements[0]).toEqual(
      expect.objectContaining({
        role: 'other',
        label: 'Scrollable panel',
        actions: expect.arrayContaining(['swipeWithin']),
      }),
    );
  });

  it('classifies generic containers with scroll-view identifiers as scroll views', () => {
    const snapshot = createRuntimeSnapshotRecord({
      simulatorId,
      uiHierarchy: [
        createNode({
          type: 'Other',
          role: 'AXGroup',
          AXIdentifier: 'app.mainScrollView',
          AXLabel: undefined,
          frame: { x: 0, y: 0, width: 390, height: 844 },
          children: [
            createNode({
              type: 'StaticText',
              role: 'AXStaticText',
              AXLabel: 'Visible child',
              frame: { x: 20, y: 120, width: 120, height: 20 },
            }),
          ],
        }),
      ],
      nowMs: 1_000,
    });

    expect(snapshot.payload.elements[0]).toEqual(
      expect.objectContaining({
        role: 'scroll-view',
        identifier: 'app.mainScrollView',
        actions: expect.arrayContaining(['swipeWithin']),
      }),
    );
  });

  it('keeps an unlabeled other swipe target as fallback when no better scroll ref exists', () => {
    const snapshot = createRuntimeSnapshotRecord({
      simulatorId,
      uiHierarchy: [
        createNode({
          type: 'Other',
          role: 'AXGroup',
          AXLabel: undefined,
          AXValue: undefined,
          AXUniqueId: undefined,
          frame: { x: 0, y: 0, width: 200, height: 200 },
          children: [
            createNode({
              type: 'StaticText',
              role: 'AXStaticText',
              AXLabel: 'Overflow',
              frame: { x: 10, y: 260, width: 100, height: 20 },
            }),
          ],
        }),
      ],
      nowMs: 1_000,
    });

    expect(snapshot.payload.elements[0]).toEqual(
      expect.objectContaining({
        role: 'other',
        actions: expect.arrayContaining(['swipeWithin']),
      }),
    );
  });

  it('removes unlabeled other swipe targets when better scroll refs exist', () => {
    const snapshot = createRuntimeSnapshotRecord({
      simulatorId,
      uiHierarchy: [
        createNode({
          type: 'Application',
          role: 'AXApplication',
          frame: { x: 0, y: 0, width: 390, height: 844 },
          children: [
            createNode({
              type: 'Other',
              role: 'AXGroup',
              AXLabel: undefined,
              AXValue: undefined,
              AXUniqueId: undefined,
              frame: { x: 0, y: 0, width: 300, height: 300 },
              children: [
                createNode({
                  type: 'StaticText',
                  role: 'AXStaticText',
                  AXLabel: 'Generic overflow',
                  frame: { x: 10, y: 360, width: 120, height: 20 },
                }),
              ],
            }),
            createNode({
              type: 'ScrollView',
              role: 'AXScrollArea',
              AXIdentifier: 'weather.locationsSheet',
              frame: { x: 0, y: 400, width: 390, height: 300 },
            }),
          ],
        }),
      ],
      nowMs: 1_000,
    });

    expect(snapshot.payload.elements[1]).toEqual(
      expect.objectContaining({
        role: 'other',
        actions: expect.not.arrayContaining(['swipeWithin']),
      }),
    );
    expect(snapshot.payload.elements[3]).toEqual(
      expect.objectContaining({
        role: 'scroll-view',
        identifier: 'weather.locationsSheet',
        actions: expect.arrayContaining(['swipeWithin']),
      }),
    );
  });

  it('derives trailing activation points for wide switch rows', () => {
    const snapshot = createRuntimeSnapshotRecord({
      simulatorId,
      uiHierarchy: [
        createNode({
          type: 'Switch',
          role: 'AXSwitch',
          frame: { x: 42.57, y: 889.68, width: 316.87, height: 26.89 },
        }),
      ],
      nowMs: 1_000,
    });

    expect(getRuntimeElementActivationPoint(snapshot.elements[0]!)).toEqual({ x: 307, y: 903 });
  });

  it('uses normalized distance to shorten swipe strokes within safe endpoints', () => {
    const snapshot = createRuntimeSnapshotRecord({
      simulatorId,
      uiHierarchy: [
        createNode({
          type: 'ScrollView',
          role: 'AXScrollArea',
          frame: { x: 0, y: 0, width: 200, height: 400 },
        }),
      ],
      nowMs: 1_000,
    });

    expect(getRuntimeElementSwipePoints(snapshot.elements[0]!, 'up', 0.5)).toEqual({
      ok: true,
      from: { x: 100, y: 270 },
      to: { x: 100, y: 130 },
    });
    expect(getRuntimeElementSwipePoints(snapshot.elements[0]!, 'up', 0.8)).toEqual({
      ok: true,
      from: { x: 100, y: 312 },
      to: { x: 100, y: 88 },
    });
  });

  it('uses viewport-relative directional drag points for small chrome targets', () => {
    const snapshot = createRuntimeSnapshotRecord({
      simulatorId,
      uiHierarchy: [
        createNode({
          type: 'Application',
          role: 'AXApplication',
          frame: { x: 0, y: 0, width: 440, height: 956 },
          children: [
            createNode({
              type: 'Button',
              role: 'AXButton',
              AXLabel: 'Sheet Grabber',
              frame: { x: 182, y: 446, width: 76, height: 24 },
            }),
          ],
        }),
      ],
      nowMs: 1_000,
    });

    expect(
      getRuntimeElementDirectionalDragPoints(
        snapshot.elements[1]!,
        'up',
        0.35,
        snapshot.elements[0]!.publicElement.frame,
      ),
    ).toEqual({
      ok: true,
      from: { x: 220, y: 458 },
      to: { x: 220, y: 123 },
    });
  });

  it('rejects directional drag points that reverse after viewport clamping', () => {
    const snapshot = createRuntimeSnapshotRecord({
      simulatorId,
      uiHierarchy: [
        createNode({
          type: 'Application',
          role: 'AXApplication',
          frame: { x: 0, y: 0, width: 390, height: 844 },
          children: [
            createNode({
              type: 'Button',
              role: 'AXButton',
              AXLabel: 'Top edge control',
              frame: { x: 40, y: 0, width: 80, height: 20 },
            }),
            createNode({
              type: 'Button',
              role: 'AXButton',
              AXLabel: 'Left edge control',
              frame: { x: 0, y: 100, width: 20, height: 80 },
            }),
          ],
        }),
      ],
      nowMs: 1_000,
    });

    expect(
      getRuntimeElementDirectionalDragPoints(
        snapshot.elements[1]!,
        'up',
        0.35,
        snapshot.elements[0]!.publicElement.frame,
      ),
    ).toMatchObject({ ok: false, message: expect.stringContaining('requested direction') });
    expect(
      getRuntimeElementDirectionalDragPoints(
        snapshot.elements[2]!,
        'left',
        0.35,
        snapshot.elements[0]!.publicElement.frame,
      ),
    ).toMatchObject({ ok: false, message: expect.stringContaining('requested direction') });
  });

  it('keeps full-screen swipe points away from unsafe viewport edges', () => {
    const snapshot = createRuntimeSnapshotRecord({
      simulatorId,
      uiHierarchy: [
        createNode({
          type: 'Application',
          role: 'AXApplication',
          frame: { x: 0, y: 0, width: 402, height: 874 },
        }),
      ],
      nowMs: 1_000,
    });

    expect(getRuntimeElementSwipePoints(snapshot.elements[0]!, 'down')).toEqual({
      ok: true,
      from: { x: 201, y: 131 },
      to: { x: 201, y: 743 },
    });
    expect(getRuntimeElementSwipePoints(snapshot.elements[0]!, 'left')).toEqual({
      ok: true,
      from: { x: 342, y: 524 },
      to: { x: 60, y: 524 },
    });
  });

  it('rejects unsafe swipe point derivation', () => {
    const snapshot = createRuntimeSnapshotRecord({
      simulatorId,
      uiHierarchy: [
        createNode({
          type: 'ScrollView',
          role: 'AXScrollArea',
          frame: { x: 0, y: 0, width: 1, height: 1 },
        }),
        createNode({
          type: 'ScrollView',
          role: 'AXScrollArea',
          frame: { x: 0, y: 0, width: 2, height: 100 },
        }),
      ],
      nowMs: 1_000,
    });

    expect(getRuntimeElementSwipePoints(snapshot.elements[0]!, 'up')).toMatchObject({
      ok: false,
      message: expect.stringContaining('too small'),
    });
    expect(getRuntimeElementSwipePoints(snapshot.elements[1]!, 'right')).toMatchObject({
      ok: false,
      message: expect.stringContaining('non-degenerate'),
    });
  });
});
