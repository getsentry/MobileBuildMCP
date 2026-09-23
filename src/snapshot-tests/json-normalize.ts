import type { StructuredOutputEnvelope } from '../types/structured-output.ts';
import { normalizeSnapshotOutput, type NormalizeSnapshotOutputOptions } from './normalize.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

const ELEMENT_REF_KEYS = new Set(['elementRef', 'withinElementRef', 'ref']);
const SIM_RUNTIME_ROOT = '<SIM_RUNTIME_ROOT>';

function isElementRef(value: string): boolean {
  return /^e\d+$/.test(value);
}

function parseRuntimeLabel(value: string): { platform: 'iOS' | 'watchOS' } | undefined {
  const match = /^(iOS|watchOS) \d+(?:\.\d+)*$/.exec(value);
  return match ? { platform: match[1] as 'iOS' | 'watchOS' } : undefined;
}

type NormalizeStructuredEnvelopeOptions = NormalizeSnapshotOutputOptions;

function normalizeBaseString(value: string, options: NormalizeStructuredEnvelopeOptions): string {
  const normalized = normalizeSnapshotOutput(value.replace(/\u00A0/g, ' '), options);
  return normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;
}

function isDeviceListPath(path: string[]): boolean {
  return path.includes('data') && path.includes('devices');
}

function normalizeString(
  value: string,
  options: NormalizeStructuredEnvelopeOptions,
  key?: string,
  path: string[] = [],
): string {
  const parentKey = path.at(-2);
  const isVerboseRuntimeCaptureRef =
    path.includes('capture') && (path.includes('elements') || path.includes('actions'));
  let result = normalizeBaseString(value, options);

  if (
    path.includes('nextSteps') &&
    (result.startsWith('Scroll visible content:') ||
      result.startsWith('Take screenshot for verification:'))
  ) {
    return '<POST_SWIPE_NEXT_STEP>';
  }

  if (parentKey === 'stderr') {
    result = result.replace(/^\[\d+\/\d+\] /, '[<STEP>] ');
  }

  if (key === 'rawResponseJsonPath') {
    return '<RAW_RESPONSE_JSON_PATH>';
  }

  if (key === 'screenHash') {
    return '<SCREEN_HASH>';
  }

  if (
    key !== undefined &&
    ELEMENT_REF_KEYS.has(key) &&
    isElementRef(result) &&
    !isVerboseRuntimeCaptureRef
  ) {
    return '<ELEMENT_REF>';
  }

  if (key === 'AXFrame') {
    // Round embedded floats to 1 decimal place for rounding-stable comparison with
    // the sibling `frame` object. e.g. 82.666664123535156 -> 82.7, 250.5 stays 250.5.
    result = result.replace(/(\d+)\.(\d{2,})/g, (_full, intPart: string, fracPart: string) => {
      const value = parseFloat(`${intPart}.${fracPart}`);
      return (Math.round(value * 10) / 10).toString();
    });
  }

  // Simulator state (e.g. 'Booted' | 'Shutdown') is inherently volatile across
  // test runs — any previous test may have booted or shut down a simulator.
  // Replace with a stable placeholder.
  if (key === 'state' && path.includes('simulators')) {
    return '<SIM_STATE>';
  }

  if (key === 'state' && isDeviceListPath(path)) {
    return '<DEVICE_STATE>';
  }

  if (key === 'osVersion' && path.includes('devices')) {
    return '<OS_VERSION>';
  }

  if (key === 'runtime') {
    const runtime = parseRuntimeLabel(result);
    if (runtime) return `${runtime.platform} <VERSION>`;
  }

  return result;
}

function normalizeBoolean(path: string[], key: string | undefined, value: boolean): boolean {
  if (key === 'isAvailable' && isDeviceListPath(path)) {
    return true;
  }

  return value;
}

function normalizeNumber(path: string[], key: string | undefined, value: number): number {
  if (key === 'count' && path.includes('capture')) {
    return 99999;
  }

  if (
    path.includes('capture') &&
    path.includes('elements') &&
    path.at(-2) === 'frame' &&
    (key === 'x' || key === 'y' || key === 'width' || key === 'height')
  ) {
    return key === 'width' || key === 'height' ? 1 : 0;
  }

  switch (key) {
    case 'toolCount':
      if (path.includes('data')) return 99999;
      return value;
    case 'durationMs':
      if (path.at(-2) === 'summary') return 1234;
      if (path.includes('testCases')) return 0;
      return value;
    case 'processId':
    case 'pid':
      return 99999;
    case 'uptimeSeconds':
      return 3600;
    case 'threadId':
      return 1;
    case 'capturedAtMs':
      return 1_700_000_000_000;
    case 'expiresAtMs':
      return 1_700_000_060_000;
    case 'snapshotAgeMs':
      return 1234;
    case 'seq':
      if (path.includes('capture')) return 1;
      return value;
    case 'x':
    case 'y':
    case 'width':
    case 'height':
      return Math.round(value * 10) / 10;
    default:
      return value;
  }
}

function isBuildSettingsEntry(value: Record<string, unknown>, path: string[]): boolean {
  return (
    path.includes('entries') && typeof value.key === 'string' && typeof value.value === 'string'
  );
}

function isSystemDebugStackLocation(displayLocation: string): boolean {
  return (
    displayLocation.startsWith('/usr/lib/') ||
    displayLocation.startsWith('/System/Library/') ||
    displayLocation.startsWith(`${SIM_RUNTIME_ROOT}/usr/lib/`) ||
    displayLocation.startsWith(`${SIM_RUNTIME_ROOT}/System/Library/`)
  );
}

function normalizeDebugStackDisplayLocation(displayLocation: string): string {
  const symbolSeparatorIndex = displayLocation.indexOf('`');
  if (symbolSeparatorIndex === -1) {
    return displayLocation;
  }

  const path = displayLocation.slice(0, symbolSeparatorIndex);
  const symbolAndOffset = displayLocation.slice(symbolSeparatorIndex + 1);
  const offsetIndex = symbolAndOffset.lastIndexOf(':<OFFSET>');

  return `${path}\`${offsetIndex === -1 ? '<FUNC>' : '<FUNC>:<OFFSET>'}`;
}

function normalizeDebugStackFrame(
  value: Record<string, unknown>,
  path: string[],
): Record<string, unknown> {
  if (
    !path.includes('threads') ||
    !path.includes('frames') ||
    typeof value.index !== 'number' ||
    typeof value.symbol !== 'string' ||
    typeof value.displayLocation !== 'string' ||
    !isSystemDebugStackLocation(value.displayLocation)
  ) {
    return value;
  }

  return {
    ...value,
    symbol: '<FUNC>',
    displayLocation: normalizeDebugStackDisplayLocation(value.displayLocation),
  };
}

function isDebugStackFrameRecord(
  value: unknown,
): value is { index: number; symbol: string; displayLocation: string } {
  return (
    isRecord(value) &&
    typeof value.index === 'number' &&
    typeof value.symbol === 'string' &&
    typeof value.displayLocation === 'string'
  );
}

function normalizeDebugStackFrames(items: unknown[]): unknown[] {
  if (!items.every(isDebugStackFrameRecord)) {
    return items;
  }

  const firstAppFrameIndex = items.findIndex((frame) =>
    frame.displayLocation.includes('<SIM_APP_BUNDLE>/'),
  );
  if (firstAppFrameIndex === -1) {
    return items;
  }

  const stableLaunchBoundaryIndex = items.findIndex(
    (frame, index) =>
      index < firstAppFrameIndex &&
      frame.displayLocation.includes('GraphicsServices.framework/GraphicsServices'),
  );
  if (stableLaunchBoundaryIndex <= 0) {
    return items;
  }

  return items.slice(stableLaunchBoundaryIndex).map((frame, index) => ({ ...frame, index }));
}

function normalizeBuildSettingsEntryKey(key: string): string {
  if (key.startsWith('SDK_DIR_')) {
    return 'SDK_DIR_<SDK_NAME>';
  }

  return key;
}

function normalizeBuildSettingsEntryValue(
  key: string,
  value: string,
  options: NormalizeStructuredEnvelopeOptions,
): string {
  if (key === 'SDKROOT' || key === 'SDK_DIR' || key.startsWith('SDK_DIR_')) {
    return '<SDK_PATH>';
  }

  switch (key) {
    case 'PATH':
      return '<PATH_ENTRIES>';
    case 'ALTERNATE_OWNER':
    case 'INSTALL_OWNER':
    case 'USER':
    case 'VERSION_INFO_BUILDER':
      return '<USER>';
    case 'UID':
      return '<UID>';
    case 'GID':
      return '<GID>';
    case 'ALTERNATE_GROUP':
    case 'GROUP':
    case 'INSTALL_GROUP':
      return '<GROUP>';
    case 'CACHE_ROOT':
    case 'CCHROOT':
      return '<XCODE_CACHE_ROOT>';
    case 'CORRESPONDING_SIMULATOR_SDK_DIR':
      return '<SDK_PATH>';
    case 'CORRESPONDING_SIMULATOR_SDK_NAME':
    case 'SDK_NAME':
    case 'SDK_NAMES':
      return '<SDK_NAME>';
    case 'PLATFORM_PRODUCT_BUILD_VERSION':
    case 'SDK_PRODUCT_BUILD_VERSION':
    case 'MAC_OS_X_PRODUCT_BUILD_VERSION':
    case 'XCODE_PRODUCT_BUILD_VERSION':
      return '<SDK_BUILD_VERSION>';
    case 'SDK_STAT_CACHE_PATH':
      return '<SDK_STAT_CACHE_PATH>';
    case 'SDK_VERSION':
    case 'SDK_VERSION_ACTUAL':
    case 'SDK_VERSION_MAJOR':
    case 'SDK_VERSION_MINOR':
    case 'MAC_OS_X_VERSION_ACTUAL':
    case 'MAC_OS_X_VERSION_MAJOR':
    case 'MAC_OS_X_VERSION_MINOR':
    case 'XCODE_VERSION_ACTUAL':
    case 'XCODE_VERSION_MAJOR':
    case 'XCODE_VERSION_MINOR':
      return '<SDK_VERSION>';
    case 'TARGET_DEVICE_MODEL':
    case 'ASSETCATALOG_FILTER_FOR_DEVICE_MODEL':
      return '<DEVICE_MODEL>';
    case 'TARGET_DEVICE_OS_VERSION':
    case 'ASSETCATALOG_FILTER_FOR_DEVICE_OS_VERSION':
      return '<OS_VERSION>';
    case 'DEPLOYMENT_TARGET_SUGGESTED_VALUES':
      return '<DEPLOYMENT_TARGETS>';
    case 'DRIVERKIT_DEPLOYMENT_TARGET':
    case 'MACOSX_DEPLOYMENT_TARGET':
    case 'TVOS_DEPLOYMENT_TARGET':
    case 'WATCHOS_DEPLOYMENT_TARGET':
    case 'XROS_DEPLOYMENT_TARGET':
      return '<DEPLOYMENT_TARGET>';
    default:
      return normalizeBaseString(value, options);
  }
}

function isNormalizedTestCase(
  value: unknown,
): value is { status?: unknown; suite?: string; test?: string } {
  return isRecord(value) && typeof value.status === 'string';
}

function testCaseSortKey(item: unknown): string {
  const record = item as { suite?: string; test?: string };
  return `${record.suite ?? ''}|${record.test ?? ''}`;
}

function normalizeTestCases(items: unknown[]): unknown[] {
  const sorted = [...items].sort((a, b) => testCaseSortKey(a).localeCompare(testCaseSortKey(b)));
  const failed = sorted.filter((item) => isNormalizedTestCase(item) && item.status === 'failed');

  return failed.length > 0 ? failed : sorted;
}

function isDiagnosticTestFailure(
  value: unknown,
): value is { suite?: unknown; test: string; message: string; location: string } {
  return (
    isRecord(value) &&
    typeof value.test === 'string' &&
    typeof value.message === 'string' &&
    typeof value.location === 'string'
  );
}

function normalizeDiagnosticTestFailure(item: unknown): unknown {
  if (!isDiagnosticTestFailure(item)) {
    return item;
  }

  if (
    item.location === 'CalculatorServiceTests.swift:37' &&
    item.test === 'This test should fail to verify error reporting'
  ) {
    return { ...item, suite: '<SWIFT_TEST_SUITE>' };
  }

  return item;
}

function normalizeDiagnosticTestFailures(items: unknown[]): unknown[] {
  return items.map(normalizeDiagnosticTestFailure).sort((left, right) => {
    const leftFailure = left as { suite?: string; test?: string; location?: string };
    const rightFailure = right as { suite?: string; test?: string; location?: string };
    return `${leftFailure.suite ?? ''}|${leftFailure.test ?? ''}|${leftFailure.location ?? ''}`.localeCompare(
      `${rightFailure.suite ?? ''}|${rightFailure.test ?? ''}|${rightFailure.location ?? ''}`,
    );
  });
}

function isSpringBoardHomeCompactCapture(value: Record<string, unknown>): boolean {
  return (
    value.type === 'runtime-snapshot' &&
    value.rs === '1' &&
    Array.isArray(value.targets) &&
    Array.isArray(value.text) &&
    value.text.includes('<REF>|text|text|Search||') &&
    value.targets.some(
      (entry) => typeof entry === 'string' && entry.includes('|tap|button|Settings||Settings'),
    )
  );
}

function normalizeSpringBoardHomeCompactCapture(
  value: Record<string, unknown>,
): Record<string, unknown> {
  if (!isSpringBoardHomeCompactCapture(value)) {
    return value;
  }

  return {
    ...value,
    count: 99999,
    targets: (value.targets as unknown[]).filter(
      (entry) => typeof entry !== 'string' || !entry.includes('|tap|button|Double-tap to open||'),
    ),
  };
}

function normalizeStderrLines(items: unknown[]): unknown[] {
  const normalized: unknown[] = [];
  let stepRun: string[] = [];

  const flushStepRun = (): void => {
    if (stepRun.length === 0) return;
    normalized.push(...stepRun.sort((left, right) => left.localeCompare(right)));
    stepRun = [];
  };

  for (const item of items) {
    if (typeof item === 'string' && item.startsWith('[<STEP>] ')) {
      stepRun.push(item);
      continue;
    }

    flushStepRun();
    normalized.push(item);
  }

  flushStepRun();
  return normalized;
}

function normalizeValue(
  value: unknown,
  options: NormalizeStructuredEnvelopeOptions,
  path: string[] = [],
): unknown {
  const key = path.at(-1);

  if (typeof value === 'string') {
    return normalizeString(value, options, key, path);
  }

  if (typeof value === 'boolean') {
    return normalizeBoolean(path, key, value);
  }

  if (typeof value === 'number') {
    return normalizeNumber(path, key, value);
  }

  if (Array.isArray(value)) {
    const normalized = value.map((item, index) =>
      normalizeValue(item, options, [...path, String(index)]),
    );
    if (key === 'testCases') {
      return normalizeTestCases(normalized);
    }
    if (key === 'testFailures') {
      return normalizeDiagnosticTestFailures(normalized);
    }
    if (key === 'stderr') {
      return normalizeStderrLines(normalized);
    }
    if (key === 'frames' && path.includes('threads')) {
      return normalizeDebugStackFrames(normalized);
    }
    return normalized;
  }

  if (isRecord(value)) {
    const isBuildSetting = isBuildSettingsEntry(value, path);
    const normalizedEntries = Object.entries(value).map(([entryKey, entryValue]) => {
      if (isBuildSetting && entryKey === 'key') {
        return [entryKey, normalizeBuildSettingsEntryKey(String(entryValue))];
      }

      if (isBuildSetting && entryKey === 'value') {
        return [
          entryKey,
          normalizeBuildSettingsEntryValue(String(value.key), String(value.value), options),
        ];
      }

      return [entryKey, normalizeValue(entryValue, options, [...path, entryKey])];
    });

    return normalizeSpringBoardHomeCompactCapture(
      normalizeDebugStackFrame(Object.fromEntries(normalizedEntries), path),
    );
  }

  return value;
}

function normalizeXcodeBridgeCallEnvelope(
  envelope: StructuredOutputEnvelope<unknown>,
): StructuredOutputEnvelope<unknown> {
  if (envelope.schema !== 'mobilebuildmcp.output.xcode-bridge-call-result') {
    return envelope;
  }

  const data = (envelope as { data?: unknown }).data;
  if (!isRecord(data)) {
    return envelope;
  }

  return {
    ...envelope,
    data: {
      ...data,
      content: [],
      ...(Object.hasOwn(data, 'structuredContent') ? { structuredContent: {} } : {}),
    },
  };
}

export function normalizeStructuredEnvelope(
  envelope: StructuredOutputEnvelope<unknown>,
  options: NormalizeStructuredEnvelopeOptions = {},
): StructuredOutputEnvelope<unknown> {
  return normalizeValue(
    normalizeXcodeBridgeCallEnvelope(envelope),
    options,
  ) as StructuredOutputEnvelope<unknown>;
}

const FRAME_OBJECT_REGEX =
  /"frame": \{\n\s+"y": (?<y>\d+(?:\.\d+)?),\n\s+"x": (?<x>\d+(?:\.\d+)?),\n\s+"width": (?<width>\d+(?:\.\d+)?),\n\s+"height": (?<height>\d+(?:\.\d+)?)\n\s+\}/g;

function compactFrameObjects(json: string): string {
  return json.replace(
    FRAME_OBJECT_REGEX,
    '"frame": { "x": $<x>, "y": $<y>, "width": $<width>, "height": $<height> }',
  );
}

export function formatStructuredEnvelopeFixture(
  envelope: StructuredOutputEnvelope<unknown>,
  options: NormalizeStructuredEnvelopeOptions = {},
): string {
  const json = JSON.stringify(normalizeStructuredEnvelope(envelope, options), null, 2);
  return `${compactFrameObjects(json)}\n`;
}
