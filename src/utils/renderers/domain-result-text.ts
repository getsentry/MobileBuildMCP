import type { NextStep } from '../../types/common.ts';
import type {
  BasicDiagnostics,
  DebugThread,
  TestDiagnostics,
  ToolDomainResult,
} from '../../types/domain-results.ts';
import type {
  RuntimeElementV1,
  RuntimeSnapshotUnchangedV1,
  RuntimeSnapshotV1,
  UiAutomationRecoverableError,
  UiWaitMatch,
} from '../../types/ui-snapshot.ts';
import type { RenderHints } from '../../rendering/types.ts';
import type { XcodebuildOperation } from '../../types/domain-fragments.ts';
import type {
  HeaderRenderItem,
  RenderItem,
  StatusRenderItem,
  TestDiscoveryRenderItem,
} from '../../rendering/render-items.ts';
import { displayPath } from '../build-preflight.ts';
import { formatDeviceId } from '../device-name-resolver.ts';
import { deriveBuildLikeTitle, invocationRequestToHeaderParams } from '../xcodebuild-pipeline.ts';

export interface SummaryTextBlock {
  type: 'summary';
  operation?: string;
  status: 'SUCCEEDED' | 'FAILED';
  totalTests?: number;
  passedTests?: number;
  failedTests?: number;
  skippedTests?: number;
  durationMs?: number;
}

export interface SectionTextBlock {
  type: 'section';
  title: string;
  icon?: 'red-circle' | 'yellow-circle' | 'green-circle' | 'checkmark' | 'cross' | 'info';
  lines: string[];
  blankLineAfterTitle?: boolean;
}

export interface DetailTreeValueItem {
  label: string;
  value: string;
}

export interface DetailTreePathItem {
  label: string;
  path: string;
}

export interface DetailTreeTextBlock {
  type: 'detail-tree';
  items: Array<DetailTreeValueItem | DetailTreePathItem>;
}

export interface TableTextBlock {
  type: 'table';
  heading?: string;
  columns: string[];
  rows: Array<Record<string, string>>;
}

export interface FileRefTextBlock {
  type: 'file-ref';
  label?: string;
  path: string;
}

export interface NextStepsTextBlock {
  type: 'next-steps';
  steps: NextStep[];
  runtime?: 'cli' | 'daemon' | 'mcp';
}

export type TextRendererBlock =
  | SummaryTextBlock
  | SectionTextBlock
  | DetailTreeTextBlock
  | TableTextBlock
  | FileRefTextBlock
  | NextStepsTextBlock;

export type TextRenderableItem = RenderItem | TextRendererBlock;

export interface DomainResultTextOptions {
  suppressWarnings?: boolean;
}

const SESSION_DEFAULT_KEYS = [
  'projectPath',
  'workspacePath',
  'scheme',
  'configuration',
  'simulatorName',
  'simulatorId',
  'simulatorPlatform',
  'deviceId',
  'useLatestOS',
  'arch',
  'suppressWarnings',
  'derivedDataPath',
  'preferXcodebuild',
  'platform',
  'bundleId',
  'env',
  'extraArgs',
] as const;

type CoverageTargetFile = {
  name: string;
  path?: string;
  coveragePct: number;
  coveredLines: number;
  executableLines: number;
};

type CoverageTargetWithFiles = {
  name: string;
  coveragePct: number;
  coveredLines: number;
  executableLines: number;
  files?: CoverageTargetFile[];
};

type CoverageResultWithOptionalRanges = Extract<ToolDomainResult, { kind: 'coverage-result' }> & {
  targets?: CoverageTargetWithFiles[];
  uncoveredLineRanges?: Array<{ start: number; end: number }>;
};

type SessionDefaultsOperation =
  | { type: 'show' }
  | { type: 'sync-xcode' }
  | {
      type: 'set';
      changedKeys: string[];
      persisted?: boolean;
      activatedProfile?: string;
      notices?: string[];
    }
  | {
      type: 'clear';
      scope: 'all' | 'profile' | 'current';
      profile?: string;
      clearedKeys?: string[];
    };

type SessionDefaultsResultWithOperation = Extract<
  ToolDomainResult,
  { kind: 'session-defaults' }
> & {
  operation?: SessionDefaultsOperation;
};

type SessionProfileResultWithPersisted = Extract<ToolDomainResult, { kind: 'session-profile' }> & {
  persisted?: boolean;
};

type VideoCapturePayload = {
  type: 'video-recording';
  state: 'started' | 'stopped';
  fps?: number;
  outputFile?: string;
  sessionId?: string;
};

type CaptureResultWithVideo = Extract<ToolDomainResult, { kind: 'capture-result' }> & {
  capture?:
    | { format: string; width: number; height: number }
    | { type: 'ui-hierarchy'; uiHierarchy: unknown[] }
    | RuntimeSnapshotV1
    | RuntimeSnapshotUnchangedV1
    | VideoCapturePayload;
};

type DebugVariableShape = Record<string, unknown>;
type DebugVariablesScopes = {
  locals: { variables: DebugVariableShape[] };
  globals: { variables: DebugVariableShape[] };
  registers: { groups: Array<{ name: string; variables: DebugVariableShape[] }> };
};

function inferXcodebuildOperation(result: ToolDomainResult): XcodebuildOperation | undefined {
  switch (result.kind) {
    case 'test-result':
      return 'TEST';
    case 'app-path':
    case 'build-result':
    case 'build-run-result':
    case 'build-settings':
    case 'bundle-id':
    case 'scheme-list':
      return 'BUILD';
    default:
      return undefined;
  }
}

function createHeader(
  operation: string,
  params: HeaderRenderItem['params'] = [],
): HeaderRenderItem {
  return { type: 'header', operation, params };
}

function createStatus(level: StatusRenderItem['level'], message: string): StatusRenderItem {
  return { type: 'status', level, message };
}

function createSection(
  title: string,
  lines: string[],
  options: Omit<SectionTextBlock, 'type' | 'title' | 'lines'> = {},
): SectionTextBlock {
  return { type: 'section', title, lines, ...options };
}

function getResultDiagnostics(
  result: ToolDomainResult,
): BasicDiagnostics | TestDiagnostics | undefined {
  return 'diagnostics' in result
    ? (result.diagnostics as BasicDiagnostics | TestDiagnostics | undefined)
    : undefined;
}

function createMarkedDiagnosticLines(
  entries: Array<{ message: string; location?: string }>,
  marker: string,
): string[] {
  return entries.flatMap((entry, index) => {
    const messageLines = entry.message.split('\n');
    while (messageLines.length > 1 && messageLines.at(-1)?.trim().length === 0) {
      messageLines.pop();
    }

    const [firstLine = '', ...additionalLines] = messageLines;
    const lines = [`${marker} ${firstLine}`];
    lines.push(...additionalLines.map((line) => `  ${line}`));
    if (entry.location) {
      lines.push(`  ${entry.location}`);
    }
    if (index < entries.length - 1) {
      lines.push('');
    }
    return lines;
  });
}

function createStandardDiagnosticSections(
  diagnostics: BasicDiagnostics | TestDiagnostics | undefined,
  suppressWarnings = false,
): SectionTextBlock[] {
  const sections: SectionTextBlock[] = [];
  if (!diagnostics) {
    return sections;
  }

  if (diagnostics.errors.length > 0) {
    sections.push(
      createSection(
        `Errors (${diagnostics.errors.length}):`,
        createMarkedDiagnosticLines(diagnostics.errors, '✗'),
        {
          blankLineAfterTitle: true,
        },
      ),
    );
  }
  if (!suppressWarnings && diagnostics.warnings.length > 0) {
    sections.push(
      createSection(
        `Warnings (${diagnostics.warnings.length}):`,
        createMarkedDiagnosticLines(diagnostics.warnings, '⚠'),
        { blankLineAfterTitle: true },
      ),
    );
  }
  if ('testFailures' in diagnostics && diagnostics.testFailures.length > 0) {
    sections.push(
      createSection(
        `Test Failures (${diagnostics.testFailures.length}):`,
        createMarkedDiagnosticLines(
          diagnostics.testFailures.map((entry) => ({
            message: formatTestFailureEntry(entry),
            location: entry.location,
          })),
          '✗',
        ),
        { blankLineAfterTitle: true },
      ),
    );
  }
  if (diagnostics.rawOutput && diagnostics.rawOutput.length > 0) {
    sections.push(
      createSection('Raw Output:', diagnostics.rawOutput, { blankLineAfterTitle: true }),
    );
  }

  return sections;
}

function createFailureStatusWithDiagnostics(
  result: ToolDomainResult,
  fallbackSummary: string,
): TextRenderableItem[] {
  return [
    ...createStandardDiagnosticSections(getResultDiagnostics(result)),
    createStatus('error', result.error ?? fallbackSummary),
  ];
}

function createDetailTree(items: DetailTreeTextBlock['items']): DetailTreeTextBlock {
  return { type: 'detail-tree', items };
}

function createPathDetailItem(label: string, path: string): DetailTreePathItem {
  return { label, path };
}

function createValueDetailItem(label: string, value: string): DetailTreeValueItem {
  return { label, value };
}

function createTable(
  columns: string[],
  rows: Array<Record<string, string>>,
  heading?: string,
): TableTextBlock {
  return { type: 'table', columns, rows, heading };
}

function formatDurationSeconds(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function formatTestFailureEntry(entry: { suite: string; test: string; message: string }): string {
  const identity = [entry.suite, entry.test].filter(Boolean).join(' / ');
  return identity.length > 0 ? `${identity}: ${entry.message}` : entry.message;
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatSessionDefaultsValue(value: unknown): string {
  return value === null || value === undefined ? '(not set)' : String(value);
}

function formatProfileAnnotationFromLabel(profileLabel: string): string {
  return profileLabel === '(default)' ? '(default profile)' : `(${profileLabel} profile)`;
}

function inferSessionDefaultsMode(
  result: SessionDefaultsResultWithOperation,
): 'show' | 'set' | 'clear' | 'sync-xcode' {
  if (result.operation?.type === 'show') return 'show';
  if (result.operation?.type === 'sync-xcode') return 'sync-xcode';
  if (result.operation?.type === 'set') return 'set';
  if (result.operation?.type === 'clear') return 'clear';

  const profiles = Object.keys(result.profiles);
  if (profiles.length > 1) {
    return 'show';
  }

  const activeProfile = result.profiles[result.currentProfile] ?? result.profiles['(default)'];
  const hasAnyValue = SESSION_DEFAULT_KEYS.some((key) => activeProfile?.[key] !== null);
  if (!hasAnyValue) {
    return 'show';
  }

  if (
    activeProfile?.bundleId !== null &&
    activeProfile?.scheme !== null &&
    activeProfile?.projectPath === null &&
    activeProfile?.workspacePath === null
  ) {
    return 'sync-xcode';
  }

  return 'set';
}

function formatVariable(variable: DebugVariableShape): string {
  const name = String(variable.name ?? '');
  const type = String(variable.type ?? '<no-type>');
  const value = String(variable.value ?? '');
  return `${name} (${type}) = ${value}`;
}

function formatVariablesLines(scopes: DebugVariablesScopes): string[] {
  const lines: string[] = [];

  const appendScope = (label: string, values: string[]): void => {
    lines.push(`${label}:`);
    if (values.length === 0) {
      lines.push('  (no variables)');
    } else {
      values.forEach((value) => lines.push(`  ${value}`));
    }
    lines.push('');
  };

  appendScope(
    'Locals',
    scopes.locals.variables.map((variable) => formatVariable(variable)),
  );
  appendScope(
    'Globals',
    scopes.globals.variables.map((variable) => formatVariable(variable)),
  );

  const registerLines: string[] = [];
  for (const group of scopes.registers.groups) {
    if (group.variables.length === 0) {
      registerLines.push(`${group.name} (<no-type>) =`);
      continue;
    }
    registerLines.push(`${group.name}:`);
    group.variables.forEach((variable) => registerLines.push(`  ${formatVariable(variable)}`));
  }
  appendScope('Registers', registerLines);

  while (lines.at(-1) === '') {
    lines.pop();
  }
  return lines;
}

function formatStackLines(threads: DebugThread[]): string[] {
  const lines: string[] = [];
  for (const thread of threads) {
    lines.push(`Thread ${thread.threadId} (${thread.name})`);
    if (thread.truncated && thread.frames.length > 0) {
      lines.push('<LOWER_FRAMES>');
    }
    for (const frame of thread.frames) {
      lines.push(`frame #${frame.index}: ${frame.symbol} at ${frame.displayLocation}`);
    }
    if (thread.truncated && thread.frames.length > 0) {
      lines.push('<LOWER_FRAMES>');
    }
  }
  return lines;
}

interface SimulatorPlatformInfo {
  label: string;
  emoji: string;
  order: number;
}

interface DevicePlatformInfo {
  label: string;
  emoji: string;
  order: number;
}

const DEVICE_PLATFORM_MAP: Record<string, DevicePlatformInfo> = {
  iOS: { label: 'iOS Devices', emoji: '\u{1F4F1}', order: 0 },
  iPadOS: { label: 'iPadOS Devices', emoji: '\u{1F4F1}', order: 1 },
  watchOS: { label: 'watchOS Devices', emoji: '\u{231A}\u{FE0F}', order: 2 },
  tvOS: { label: 'tvOS Devices', emoji: '\u{1F4FA}', order: 3 },
  visionOS: { label: 'visionOS Devices', emoji: '\u{1F97D}', order: 4 },
  macOS: { label: 'macOS Devices', emoji: '\u{1F4BB}', order: 5 },
};

const SIMULATOR_PLATFORM_MAP: Record<string, SimulatorPlatformInfo> = {
  iOS: { label: 'iOS Simulators', emoji: '\u{1F4F1}', order: 0 },
  visionOS: { label: 'visionOS Simulators', emoji: '\u{1F97D}', order: 1 },
  watchOS: { label: 'watchOS Simulators', emoji: '\u{231A}\u{FE0F}', order: 2 },
  tvOS: { label: 'tvOS Simulators', emoji: '\u{1F4FA}', order: 3 },
};

function detectSimulatorPlatform(runtimeName: string): string {
  if (/xrOS|visionOS/i.test(runtimeName)) return 'visionOS';
  if (/watchOS/i.test(runtimeName)) return 'watchOS';
  if (/tvOS/i.test(runtimeName)) return 'tvOS';
  return 'iOS';
}

function getSimulatorPlatformInfo(platform: string): SimulatorPlatformInfo {
  return (
    SIMULATOR_PLATFORM_MAP[platform] ?? {
      label: `${platform} Simulators`,
      emoji: '\u{1F4F1}',
      order: 99,
    }
  );
}

function getDevicePlatformInfo(platform: string): DevicePlatformInfo {
  return (
    DEVICE_PLATFORM_MAP[platform] ?? {
      label: `${platform} Devices`,
      emoji: '\u{1F4F1}',
      order: 99,
    }
  );
}

function createDeviceListItems(
  result: Extract<ToolDomainResult, { kind: 'device-list' }>,
): TextRenderableItem[] {
  const header = createHeader('List Devices');
  if (result.didError) {
    return [header, ...createFailureStatusWithDiagnostics(result, 'Failed to list devices')];
  }

  const groupedByPlatform = new Map<string, typeof result.devices>();
  for (const device of result.devices) {
    const platformGroup = groupedByPlatform.get(device.platform) ?? [];
    platformGroup.push(device);
    groupedByPlatform.set(device.platform, platformGroup);
  }

  const platformCounts: Record<string, number> = {};
  let totalCount = 0;
  const items: TextRenderableItem[] = [header];
  const sortedPlatforms = [...groupedByPlatform.entries()].sort(
    ([left], [right]) => getDevicePlatformInfo(left).order - getDevicePlatformInfo(right).order,
  );

  for (const [platform, devices] of sortedPlatforms) {
    const info = getDevicePlatformInfo(platform);
    const lines: string[] = [''];

    for (const device of devices) {
      if (lines.length > 1) {
        lines.push('');
      }
      const marker = device.isAvailable ? '\u2713' : '\u2717';
      lines.push(`${info.emoji} [${marker}] ${device.name}`);
      lines.push(`  OS: ${device.osVersion}`);
      lines.push(`  UDID: ${device.deviceId}`);
    }

    platformCounts[platform] = devices.length;
    totalCount += devices.length;
    items.push(createSection(`${info.label}:`, lines));
  }

  const countParts = sortedPlatforms
    .map(([platform]) => `${platformCounts[platform]} ${platform}`)
    .join(', ');
  items.push(createStatus('success', `${totalCount} physical devices discovered (${countParts}).`));
  items.push(
    createSection('Hints', [
      'Use the device ID/UDID from above when required by other tools.',
      "Save a default device with session-set-defaults { deviceId: 'DEVICE_UDID' }.",
      'Before running build/run/test/UI automation tools, set the desired device identifier in session defaults.',
    ]),
  );
  return items;
}

function createSimulatorListItems(
  result: Extract<ToolDomainResult, { kind: 'simulator-list' }>,
): TextRenderableItem[] {
  const header = createHeader('List Simulators');
  if (result.didError) {
    return [header, ...createFailureStatusWithDiagnostics(result, 'Failed to list simulators')];
  }

  const groupedByRuntime = new Map<string, typeof result.simulators>();
  for (const simulator of result.simulators) {
    const runtimeGroup = groupedByRuntime.get(simulator.runtime) ?? [];
    runtimeGroup.push(simulator);
    groupedByRuntime.set(simulator.runtime, runtimeGroup);
  }

  const groupedByPlatform = new Map<string, Map<string, typeof result.simulators>>();
  for (const [runtime, simulators] of groupedByRuntime.entries()) {
    if (simulators.length === 0) continue;
    const platform = detectSimulatorPlatform(runtime);
    const platformGroup =
      groupedByPlatform.get(platform) ?? new Map<string, typeof result.simulators>();
    platformGroup.set(runtime, simulators);
    groupedByPlatform.set(platform, platformGroup);
  }

  const platformCounts: Record<string, number> = {};
  let totalCount = 0;
  const items: TextRenderableItem[] = [header];
  const sortedPlatforms = [...groupedByPlatform.entries()].sort(
    ([left], [right]) =>
      getSimulatorPlatformInfo(left).order - getSimulatorPlatformInfo(right).order,
  );

  for (const [platform, runtimeGroups] of sortedPlatforms) {
    const info = getSimulatorPlatformInfo(platform);
    const lines: string[] = [];
    let platformTotal = 0;

    for (const [runtimeName, simulators] of runtimeGroups.entries()) {
      lines.push('', `${runtimeName}:`);
      for (const simulator of simulators) {
        lines.push('');
        const marker = simulator.state === 'Booted' ? '\u{2713}' : '\u{2717}';
        lines.push(`  ${info.emoji} [${marker}] ${simulator.name} (${simulator.state})`);
        lines.push(`    UDID: ${simulator.simulatorId}`);
        platformTotal += 1;
      }
    }

    platformCounts[platform] = platformTotal;
    totalCount += platformTotal;
    items.push(createSection(`${info.label}:`, lines));
  }

  const countParts = sortedPlatforms
    .map(([platform]) => `${platformCounts[platform]} ${platform}`)
    .join(', ');
  items.push(createStatus('success', `${totalCount} simulators available (${countParts}).`));
  items.push(
    createSection('Hints', [
      'Use the simulator ID/UDID from above when required by other tools.',
      "Save a default simulator with session-set-defaults { simulatorId: 'SIMULATOR_UDID' }.",
      'Before running boot/build/run tools, set the desired simulator identifier in session defaults.',
    ]),
  );
  return items;
}

function createDoctorReportItems(
  result: Extract<ToolDomainResult, { kind: 'doctor-report' }>,
): TextRenderableItem[] {
  const items: TextRenderableItem[] = [
    createHeader('MobileBuildMCP Doctor', [
      { label: 'Server Version', value: result.serverVersion },
    ]),
    createTable(
      ['name', 'status', 'message'],
      result.checks.map((check) => ({
        name: check.name,
        status: check.status,
        message: check.message,
      })),
      'Doctor Checks',
    ),
  ];

  if (result.didError) {
    items.push(...createFailureStatusWithDiagnostics(result, 'Doctor failed.'));
  } else if (result.checks.some((check) => check.status === 'error')) {
    items.push(createStatus('warning', 'Doctor completed with diagnostic errors.'));
  } else if (result.checks.some((check) => check.status === 'warning')) {
    items.push(createStatus('warning', 'Doctor completed with warnings.'));
  } else {
    items.push(createStatus('success', 'Doctor diagnostics complete'));
  }
  return items;
}

function createWorkflowSelectionItems(
  result: Extract<ToolDomainResult, { kind: 'workflow-selection' }>,
): TextRenderableItem[] {
  const items: TextRenderableItem[] = [createHeader('Manage Workflows')];
  items.push(
    createSection(
      'Enabled Workflows',
      result.enabledWorkflows.length > 0 ? result.enabledWorkflows : ['(none)'],
    ),
  );
  const message = result.didError
    ? (result.error ?? 'Failed to update workflows.')
    : `Workflows enabled: ${result.enabledWorkflows.join(', ') || '(none)'} (${result.registeredToolCount} tools registered)`;
  if (result.didError) {
    items.push(...createFailureStatusWithDiagnostics(result, message));
  } else {
    items.push(createStatus('success', message));
  }
  return items;
}

function createAppPathItems(
  result: Extract<ToolDomainResult, { kind: 'app-path' }>,
): TextRenderableItem[] {
  const headerParams: HeaderRenderItem['params'] = [];
  if (result.request?.scheme) {
    headerParams.push({ label: 'Scheme', value: result.request.scheme });
  }
  if (result.request?.workspacePath) {
    headerParams.push({ label: 'Workspace', value: displayPath(result.request.workspacePath) });
  } else if (result.request?.projectPath) {
    headerParams.push({ label: 'Project', value: displayPath(result.request.projectPath) });
  }
  if (result.request?.configuration) {
    headerParams.push({ label: 'Configuration', value: result.request.configuration });
  }
  if (result.request?.platform) {
    headerParams.push({ label: 'Platform', value: result.request.platform });
  }
  if (result.request?.simulator) {
    headerParams.push({ label: 'Simulator', value: result.request.simulator });
  }

  const items: TextRenderableItem[] = [createHeader('Get App Path', headerParams)];
  const target = result.summary?.target;

  if (result.didError) {
    items.push(
      ...createFailureStatusWithDiagnostics(
        result,
        target === 'simulator' ? 'Failed to get app path' : 'Query failed.',
      ),
    );
    return items;
  }

  const durationMs =
    typeof result.summary?.durationMs === 'number' ? result.summary.durationMs : undefined;
  const appPath =
    'artifacts' in result && result.artifacts && 'appPath' in result.artifacts
      ? result.artifacts.appPath
      : undefined;
  const isSimulatorAppPath =
    target === 'simulator' ||
    (typeof appPath === 'string' &&
      /(iphonesimulator|watchsimulator|appletvsimulator|xrsimulator|visionossimulator)/i.test(
        appPath,
      ));
  items.push(
    createStatus(
      'success',
      isSimulatorAppPath && durationMs !== undefined
        ? `Get app path successful (⏱️ ${formatDurationSeconds(durationMs)})`
        : isSimulatorAppPath
          ? 'Get app path successful'
          : 'Success',
    ),
  );
  if (appPath) {
    items.push(createDetailTree([createPathDetailItem('App Path', appPath)]));
  }
  return items;
}

function createBundleIdItems(
  result: Extract<ToolDomainResult, { kind: 'bundle-id' }>,
  hints?: RenderHints,
): TextRenderableItem[] {
  const items: TextRenderableItem[] = [
    createHeader(hints?.headerTitle ?? 'Get Bundle ID', [
      { label: 'App', value: displayPath(result.artifacts.appPath) },
    ]),
  ];
  if (result.didError) {
    items.push(...createFailureStatusWithDiagnostics(result, 'Failed to get bundle ID.'));
    return items;
  }

  items.push(
    createSection(
      '✅ Bundle ID',
      result.artifacts.bundleId ? [`└ ${result.artifacts.bundleId}`] : [],
    ),
  );
  return items;
}

function createInstallResultItems(
  result: Extract<ToolDomainResult, { kind: 'install-result' }>,
): TextRenderableItem[] {
  const isSimulator = typeof result.artifacts.simulatorId === 'string';
  const targetLabel = isSimulator ? 'Simulator' : 'Device';
  const appLabel = isSimulator ? 'App Path' : 'App';
  const targetValue = isSimulator
    ? (result.artifacts.simulatorId ?? 'unknown')
    : result.didError
      ? (result.artifacts.deviceId ?? 'unknown')
      : result.artifacts.deviceId
        ? formatDeviceId(result.artifacts.deviceId)
        : 'unknown';
  const items: TextRenderableItem[] = [
    createHeader('Install App', [
      { label: targetLabel, value: targetValue },
      { label: appLabel, value: displayPath(result.artifacts.appPath) },
    ]),
  ];

  if (result.didError) {
    items.push(...createFailureStatusWithDiagnostics(result, 'Install failed.'));
    return items;
  }

  items.push(
    createStatus(
      'success',
      isSimulator ? 'App installed successfully' : 'App installed successfully.',
    ),
  );
  return items;
}

function createLaunchResultItems(
  result: Extract<ToolDomainResult, { kind: 'launch-result' }>,
): TextRenderableItem[] {
  const isSimulator = typeof result.artifacts.simulatorId === 'string';
  const isDevice = typeof result.artifacts.deviceId === 'string';
  const isMac = !isSimulator && !isDevice && typeof result.artifacts.appPath === 'string';
  const title = isMac ? 'Launch macOS App' : 'Launch App';
  const params: HeaderRenderItem['params'] = [];

  if (isMac) {
    if (result.artifacts.appPath) {
      params.push({ label: 'App', value: displayPath(result.artifacts.appPath) });
    }
  } else if (isDevice) {
    params.push({
      label: 'Device',
      value: result.didError
        ? result.artifacts.deviceId!
        : formatDeviceId(result.artifacts.deviceId!),
    });
    if (result.artifacts.bundleId) {
      params.push({ label: 'Bundle ID', value: result.artifacts.bundleId });
    }
  } else {
    if (result.artifacts.simulatorId) {
      params.push({ label: 'Simulator', value: result.artifacts.simulatorId });
    }
    if (result.artifacts.bundleId) {
      params.push({ label: 'Bundle ID', value: result.artifacts.bundleId });
    }
  }

  const items: TextRenderableItem[] = [createHeader(title, params)];
  if (result.didError) {
    items.push(...createFailureStatusWithDiagnostics(result, 'Launch failed.'));
    return items;
  }

  items.push(
    createStatus('success', isDevice ? 'App launched successfully.' : 'App launched successfully'),
  );

  const details: DetailTreeTextBlock['items'] = [];
  if (result.artifacts.bundleId && isMac) {
    details.push(createValueDetailItem('Bundle ID', result.artifacts.bundleId));
  }
  if (typeof result.artifacts.processId === 'number') {
    details.push(createValueDetailItem('Process ID', String(result.artifacts.processId)));
  }
  if (result.artifacts.runtimeLogPath) {
    details.push(createPathDetailItem('Runtime Logs', result.artifacts.runtimeLogPath));
  }
  if (result.artifacts.osLogPath) {
    details.push(createPathDetailItem('OSLog', result.artifacts.osLogPath));
  }
  if (details.length > 0) {
    items.push(createDetailTree(details));
  }
  return items;
}

function createStopResultItems(
  result: Extract<ToolDomainResult, { kind: 'stop-result' }>,
): TextRenderableItem[] {
  const isSimulator = typeof result.artifacts.simulatorId === 'string';
  const isDevice = typeof result.artifacts.deviceId === 'string';
  const isSwiftPackage =
    !isSimulator &&
    !isDevice &&
    typeof result.artifacts.processId === 'number' &&
    !result.artifacts.appName &&
    !result.artifacts.bundleId;
  const isMac = !isSimulator && !isDevice && !isSwiftPackage;

  const title = isSwiftPackage ? 'Swift Package Stop' : isMac ? 'Stop macOS App' : 'Stop App';
  const params: HeaderRenderItem['params'] = [];
  if (isSimulator) {
    params.push({ label: 'Simulator', value: result.artifacts.simulatorId! });
    if (result.artifacts.bundleId) {
      params.push({ label: 'Bundle ID', value: result.artifacts.bundleId });
    }
  } else if (isDevice) {
    params.push({
      label: 'Device',
      value: result.didError
        ? result.artifacts.deviceId!
        : formatDeviceId(result.artifacts.deviceId!),
    });
    if (typeof result.artifacts.processId === 'number') {
      params.push({ label: 'PID', value: String(result.artifacts.processId) });
    }
  } else if (isSwiftPackage) {
    params.push({ label: 'PID', value: String(result.artifacts.processId) });
  } else {
    params.push({
      label: 'App',
      value:
        result.artifacts.appName ??
        (typeof result.artifacts.processId === 'number'
          ? `PID ${result.artifacts.processId}`
          : 'unknown'),
    });
  }

  const items: TextRenderableItem[] = [createHeader(title, params)];
  if (result.didError) {
    items.push(...createFailureStatusWithDiagnostics(result, 'Stop failed.'));
    return items;
  }

  items.push(
    createStatus(
      'success',
      isSwiftPackage ? 'Swift package process stopped successfully' : 'App stopped successfully',
    ),
  );
  return items;
}

function createSchemeListItems(
  result: Extract<ToolDomainResult, { kind: 'scheme-list' }>,
): TextRenderableItem[] {
  const [label, pathValue] =
    'projectPath' in result.artifacts
      ? (['Project', result.artifacts.projectPath] as const)
      : (['Workspace', result.artifacts.workspacePath] as const);
  const items: TextRenderableItem[] = [
    createHeader('List Schemes', [{ label, value: displayPath(pathValue) }]),
  ];
  if (result.didError) {
    items.push(...createFailureStatusWithDiagnostics(result, 'Failed to list schemes.'));
    return items;
  }

  items.push(
    createStatus(
      'success',
      `Found ${result.schemes.length} ${result.schemes.length === 1 ? 'scheme' : 'schemes'}`,
    ),
  );
  items.push(createSection('Schemes:', result.schemes));
  return items;
}

function createBuildSettingsItems(
  result: Extract<ToolDomainResult, { kind: 'build-settings' }>,
): TextRenderableItem[] {
  const items: TextRenderableItem[] = [
    createHeader('Show Build Settings', [
      { label: 'Scheme', value: result.artifacts.scheme },
      { label: 'Workspace', value: displayPath(result.artifacts.workspacePath) },
    ]),
  ];

  if (result.didError) {
    items.push(...createFailureStatusWithDiagnostics(result, 'Failed to show build settings.'));
    return items;
  }

  items.push(createStatus('success', 'Build settings retrieved'));
  items.push(
    createSection(
      'Settings',
      result.entries.map((entry) => {
        const renderableEntry = entry as typeof entry & {
          __hasEquals?: boolean;
          __renderValue?: string;
        };
        if (renderableEntry.__hasEquals === false) {
          return entry.key;
        }
        return `    ${entry.key} =${renderableEntry.__renderValue ?? ` ${entry.value}`}`;
      }),
    ),
  );
  return items;
}

function createProjectListItems(
  result: Extract<ToolDomainResult, { kind: 'project-list' }>,
): TextRenderableItem[] {
  const items: TextRenderableItem[] = [
    createHeader('Discover Projects', [
      { label: 'Workspace root', value: displayPath(result.artifacts.workspaceRoot) },
      { label: 'Scan path', value: displayPath(result.artifacts.scanPath) },
      { label: 'Max depth', value: String(result.summary.maxDepth) },
    ]),
  ];

  if (result.didError) {
    items.push(...createFailureStatusWithDiagnostics(result, 'Failed to discover projects.'));
    return items;
  }

  const projectCount = result.summary.projectCount ?? result.projects.length;
  const workspaceCount = result.summary.workspaceCount ?? result.workspaces.length;
  items.push(
    createStatus(
      'success',
      `Found ${pluralize(projectCount, 'project')} and ${pluralize(workspaceCount, 'workspace')}`,
    ),
  );
  items.push(
    createSection(
      'Projects:',
      result.projects.map((project) => displayPath(project.path)),
    ),
  );
  items.push(
    createSection(
      'Workspaces:',
      result.workspaces.map((workspace) => displayPath(workspace.path)),
    ),
  );
  return items;
}

function createScaffoldResultItems(
  result: Extract<ToolDomainResult, { kind: 'scaffold-result' }>,
): TextRenderableItem[] {
  const title =
    result.summary.platform === 'macOS' ? 'Scaffold macOS Project' : 'Scaffold iOS Project';
  const items: TextRenderableItem[] = [
    createHeader(title, [
      { label: 'Name', value: result.artifacts.projectName },
      { label: 'Path', value: displayPath(result.artifacts.outputPath) },
      { label: 'Platform', value: result.summary.platform },
    ]),
  ];

  if (result.didError) {
    items.push(...createFailureStatusWithDiagnostics(result, 'Failed to scaffold project.'));
    return items;
  }

  items.push(
    createSection('✅ Project scaffolded successfully', [
      `└ ${displayPath(result.artifacts.outputPath)}`,
    ]),
  );
  return items;
}

function createSessionDefaultsItems(
  rawResult: Extract<ToolDomainResult, { kind: 'session-defaults' }>,
): TextRenderableItem[] {
  const result = rawResult as SessionDefaultsResultWithOperation;
  const mode = inferSessionDefaultsMode(result);
  const activeProfile =
    result.profiles[result.currentProfile] ??
    result.profiles['(default)'] ??
    result.profiles[Object.keys(result.profiles)[0]];

  if (mode === 'show') {
    const items: TextRenderableItem[] = [createHeader('Show Defaults')];
    for (const [profileLabel, profile] of Object.entries(result.profiles)) {
      items.push(
        createSection(
          `📁 ${profileLabel}`,
          SESSION_DEFAULT_KEYS.map((key, index) => {
            const branch = index === SESSION_DEFAULT_KEYS.length - 1 ? '└' : '├';
            return `${branch} ${key}: ${formatSessionDefaultsValue(profile[key])}`;
          }),
        ),
      );
    }
    return items;
  }

  if (mode === 'sync-xcode') {
    const detailItems: DetailTreeTextBlock['items'] = [];
    if (activeProfile?.scheme !== null) {
      detailItems.push({ label: 'scheme', value: String(activeProfile?.scheme) });
    }
    if (activeProfile?.bundleId !== null) {
      detailItems.push({ label: 'bundleId', value: String(activeProfile?.bundleId) });
    }
    return [
      createHeader('Sync Xcode Defaults'),
      createStatus(
        'success',
        `Synced session defaults from Xcode IDE ${formatProfileAnnotationFromLabel(result.currentProfile)}`,
      ),
      ...(detailItems.length > 0 ? [createDetailTree(detailItems)] : []),
    ];
  }

  if (mode === 'clear') {
    const profileLabel =
      result.operation?.type === 'clear' && result.operation.scope === 'profile'
        ? (result.operation.profile ?? result.currentProfile)
        : result.currentProfile;
    return [
      createHeader('Clear Defaults', [{ label: 'Profile', value: profileLabel }]),
      createStatus(
        'success',
        result.operation?.type === 'clear' && result.operation.scope === 'all'
          ? 'All session defaults cleared.'
          : `Session defaults cleared ${formatProfileAnnotationFromLabel(profileLabel)}`,
      ),
    ];
  }

  const headerParams: HeaderRenderItem['params'] = [];
  if (activeProfile?.projectPath !== null) {
    headerParams.push({
      label: 'Project Path',
      value: displayPath(String(activeProfile.projectPath)),
    });
  }
  if (activeProfile?.workspacePath !== null) {
    headerParams.push({
      label: 'Workspace Path',
      value: displayPath(String(activeProfile.workspacePath)),
    });
  }
  if (activeProfile?.scheme !== null) {
    headerParams.push({ label: 'Scheme', value: String(activeProfile.scheme) });
  }
  headerParams.push({ label: 'Profile', value: result.currentProfile });

  const items: TextRenderableItem[] = [
    createHeader('Set Defaults', headerParams),
    createStatus(
      'success',
      `Session defaults updated ${formatProfileAnnotationFromLabel(result.currentProfile)}`,
    ),
    createDetailTree(
      SESSION_DEFAULT_KEYS.map((key) => ({
        label: key,
        value: formatSessionDefaultsValue(activeProfile[key]),
      })),
    ),
  ];

  const notices: string[] = [];
  if (result.operation?.type === 'set' && result.operation.activatedProfile) {
    notices.push(`Activated profile "${result.operation.activatedProfile}".`);
  }
  if (result.operation?.type === 'set' && result.operation.notices?.length) {
    notices.push(...result.operation.notices);
  }
  if (notices.length > 0) {
    items.push(createSection('Notices', notices));
  }
  return items;
}

function createSessionProfileItems(
  rawResult: Extract<ToolDomainResult, { kind: 'session-profile' }>,
): TextRenderableItem[] {
  const result = rawResult as SessionProfileResultWithPersisted;
  const items: TextRenderableItem[] = [
    createHeader('Use Defaults Profile', [
      { label: 'Current profile', value: result.previousProfile },
    ]),
  ];

  if (result.didError) {
    items.push(
      ...createFailureStatusWithDiagnostics(result, 'Failed to activate defaults profile.'),
    );
    return items;
  }

  if (result.persisted) {
    items.push(createSection('Notices', ['Persisted active profile selection.']));
  }
  items.push(
    createStatus(
      'success',
      `Activated profile ${formatProfileAnnotationFromLabel(result.currentProfile)}`,
    ),
  );
  return items;
}

const HIDDEN_RUNTIME_TARGET_LABELS = new Set(['sheet grabber']);

const LOW_PRIORITY_RUNTIME_TARGET_LABELS = new Set([
  'sheet grabber',
  'close',
  'clear search',
  'remove',
  'delete',
  'clear',
  'c',
  'ac',
  '±',
  '%',
  '÷',
  '×',
  '-',
  '+',
  '=',
]);

function compactRuntimeSnapshotText(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').replace(/\|/g, '/').trim();
}

function normalizedRuntimeSnapshotText(value: string | undefined): string {
  return compactRuntimeSnapshotText(value).toLowerCase();
}

function isHiddenRuntimeTarget(element: RuntimeElementV1): boolean {
  return HIDDEN_RUNTIME_TARGET_LABELS.has(normalizedRuntimeSnapshotText(element.label));
}

function isLowPriorityRuntimeTarget(element: RuntimeElementV1): boolean {
  return LOW_PRIORITY_RUNTIME_TARGET_LABELS.has(normalizedRuntimeSnapshotText(element.label));
}

function isContentRichTapTarget(element: RuntimeElementV1): boolean {
  if (!element.actions.includes('tap')) {
    return false;
  }

  const label = compactRuntimeSnapshotText(element.label);
  const identifier = compactRuntimeSnapshotText(element.identifier);
  return label.includes(',') || label.length >= 24 || /card$/i.test(identifier);
}

function isAlreadySelectedRuntimeTarget(element: RuntimeElementV1): boolean {
  return (
    element.state?.selected === true || normalizedRuntimeSnapshotText(element.value) === 'selected'
  );
}

function getRuntimeTargetDisplayPriority(element: RuntimeElementV1): number {
  if (isLowPriorityRuntimeTarget(element)) {
    return 90;
  }
  if (isAlreadySelectedRuntimeTarget(element)) {
    return 70;
  }
  if (isContentRichTapTarget(element)) {
    return 0;
  }
  if (element.actions.includes('typeText')) {
    return 10;
  }
  if (element.actions.includes('tap')) {
    return 20;
  }
  return 50;
}

function sortRuntimeTargetsForDisplay(elements: RuntimeElementV1[]): RuntimeElementV1[] {
  return elements
    .map((element, index) => ({ element, index }))
    .sort((left, right) => {
      const priorityDelta =
        getRuntimeTargetDisplayPriority(left.element) -
        getRuntimeTargetDisplayPriority(right.element);
      return priorityDelta === 0 ? left.index - right.index : priorityDelta;
    })
    .map(({ element }) => element);
}

function getPrimaryRuntimeElementAction(element: RuntimeElementV1, action?: string): string {
  if (action) {
    return action;
  }
  if (element.actions.includes('typeText')) {
    return 'typeText';
  }
  if (element.actions.includes('tap')) {
    return 'tap';
  }
  if (element.actions.includes('swipeWithin')) {
    return 'swipe';
  }
  return 'none';
}

function formatRuntimeElementLine(element: RuntimeElementV1, action?: string): string {
  const primaryAction = getPrimaryRuntimeElementAction(element, action);
  return [
    element.ref,
    primaryAction,
    element.role ?? '',
    compactRuntimeSnapshotText(element.label),
    compactRuntimeSnapshotText(element.value),
    compactRuntimeSnapshotText(element.identifier),
  ].join('|');
}

function formatSuppressedRuntimeEvidenceLine(element: RuntimeElementV1): string {
  return [
    element.role ?? '',
    compactRuntimeSnapshotText(element.label),
    compactRuntimeSnapshotText(element.value),
    compactRuntimeSnapshotText(element.identifier),
  ].join('|');
}

function getSuppressedRuntimeTargetRefs(hints?: RenderHints): Set<string> {
  return new Set(hints?.runtimeSnapshot?.suppressedTargetRefs ?? []);
}

function hasRuntimeTextEvidence(element: RuntimeElementV1): boolean {
  return (
    compactRuntimeSnapshotText(element.label).length > 0 ||
    compactRuntimeSnapshotText(element.value).length > 0
  );
}

function isLikelyRuntimeTarget(
  element: RuntimeElementV1,
  suppressedTargetRefs: ReadonlySet<string> = new Set<string>(),
): boolean {
  return (
    !suppressedTargetRefs.has(element.ref) &&
    !isHiddenRuntimeTarget(element) &&
    element.actions.some((action) => action === 'tap' || action === 'typeText')
  );
}

function isSuppressedRuntimeTextEvidenceElement(
  element: RuntimeElementV1,
  suppressedTargetRefs: ReadonlySet<string>,
): boolean {
  return (
    suppressedTargetRefs.has(element.ref) &&
    element.state?.visible !== false &&
    !isHiddenRuntimeTarget(element) &&
    !isLowPriorityRuntimeTarget(element) &&
    hasRuntimeTextEvidence(element)
  );
}

function isScrollableRuntimeArea(element: RuntimeElementV1): boolean {
  return element.actions.includes('swipeWithin') && !isLikelyRuntimeTarget(element);
}

function countLikelyRuntimeTargets(
  snapshot: RuntimeSnapshotV1,
  suppressedTargetRefs: ReadonlySet<string> = new Set<string>(),
): number {
  return snapshot.elements.filter((element) => isLikelyRuntimeTarget(element, suppressedTargetRefs))
    .length;
}

function countScrollableRuntimeAreas(snapshot: RuntimeSnapshotV1): number {
  return snapshot.elements.filter(isScrollableRuntimeArea).length;
}

function createRuntimeSnapshotTargetsSection(
  snapshot: RuntimeSnapshotV1,
  suppressedTargetRefs: ReadonlySet<string> = new Set<string>(),
): SectionTextBlock {
  const likelyTargets = sortRuntimeTargetsForDisplay(
    snapshot.elements.filter((element) => isLikelyRuntimeTarget(element, suppressedTargetRefs)),
  );
  const lines = likelyTargets.map((element) => formatRuntimeElementLine(element));

  return createSection(
    `Targets (${likelyTargets.length}) — ref|action|role|label|value|id`,
    lines.length > 0 ? lines : ['(no likely interaction targets found)'],
  );
}

function createRuntimeSnapshotEvidenceSection(
  snapshot: RuntimeSnapshotV1,
  suppressedTargetRefs: ReadonlySet<string>,
): SectionTextBlock | null {
  const evidenceElements = snapshot.elements.filter((element) =>
    isSuppressedRuntimeTextEvidenceElement(element, suppressedTargetRefs),
  );
  if (evidenceElements.length === 0) {
    return null;
  }

  return createSection(
    `Evidence (${evidenceElements.length}) — role|label|value|id`,
    evidenceElements.map((element) => formatSuppressedRuntimeEvidenceLine(element)),
  );
}

function createRuntimeSnapshotScrollAreasSection(
  snapshot: RuntimeSnapshotV1,
): SectionTextBlock | null {
  const scrollAreas = snapshot.elements.filter(isScrollableRuntimeArea);
  if (scrollAreas.length === 0) {
    return null;
  }

  return createSection(
    `Scroll (${scrollAreas.length}) — ref|action|role|label|value|id`,
    scrollAreas.map((element) => formatRuntimeElementLine(element, 'swipe')),
  );
}

function createWaitMatchSection(waitMatch: UiWaitMatch): SectionTextBlock {
  return createSection(
    `Matched ${waitMatch.predicate} (${waitMatch.matches.length}) — ref|action|role|label|value|id`,
    waitMatch.matches.length > 0
      ? waitMatch.matches.map((element) => formatRuntimeElementLine(element))
      : ['(no matching elements found)'],
  );
}

function createUiErrorItems(uiError?: UiAutomationRecoverableError): TextRenderableItem[] {
  if (!uiError) {
    return [];
  }

  const lines = [
    `Code: ${uiError.code}`,
    `Message: ${uiError.message}`,
    ...(uiError.elementRef ? [`Element: ${uiError.elementRef}`] : []),
    ...(typeof uiError.timeoutMs === 'number' ? [`Timeout: ${uiError.timeoutMs}ms`] : []),
    `Hint: ${uiError.recoveryHint}`,
  ];

  if (uiError.candidates && uiError.candidates.length > 0) {
    lines.push(
      `Candidates (${uiError.candidates.length}):`,
      ...uiError.candidates.map((candidate) => `  ${formatRuntimeElementLine(candidate)}`),
    );
  }

  return [createSection('Recovery', lines)];
}

function createSimulatorActionItems(
  result: Extract<ToolDomainResult, { kind: 'simulator-action-result' }>,
): TextRenderableItem[] {
  const titleMap: Record<typeof result.action.type, string> = {
    boot: 'Boot Simulator',
    erase: 'Erase Simulator',
    open: 'Open Simulator',
    'reset-location': 'Reset Location',
    'set-location': 'Set Location',
    'set-appearance': 'Set Appearance',
    statusbar: 'Statusbar',
    'toggle-software-keyboard': 'Toggle Software Keyboard',
    'toggle-connect-hardware-keyboard': 'Toggle Connect Hardware Keyboard',
  };

  const params: HeaderRenderItem['params'] = [];
  if (result.artifacts?.simulatorId) {
    params.push({ label: 'Simulator', value: result.artifacts.simulatorId });
  }
  if (result.action.type === 'set-location') {
    params.push({
      label: 'Coordinates',
      value: `${result.action.coordinates.latitude},${result.action.coordinates.longitude}`,
    });
  }
  if (result.action.type === 'set-appearance') {
    params.push({ label: 'Mode', value: result.action.appearance });
  }
  if (result.action.type === 'statusbar' && result.action.dataNetwork) {
    params.push({ label: 'Data Network', value: result.action.dataNetwork });
  }

  const items: TextRenderableItem[] = [createHeader(titleMap[result.action.type], params)];
  if (result.didError) {
    items.push(...createFailureStatusWithDiagnostics(result, 'Simulator action failed.'));
  } else {
    const successMessages: Record<typeof result.action.type, string> = {
      boot: 'Simulator booted successfully',
      erase: 'Simulators were erased successfully',
      open: 'Simulator opened successfully',
      'reset-location': 'Location successfully reset to default',
      'set-location': 'Location set successfully',
      'set-appearance': `Appearance successfully set to ${result.action.type === 'set-appearance' ? result.action.appearance : 'requested'} mode`,
      statusbar: 'Status bar data network set successfully',
      'toggle-software-keyboard': 'Sent Toggle Software Keyboard (Cmd+K)',
      'toggle-connect-hardware-keyboard': 'Sent Connect Hardware Keyboard (Cmd+Shift+K)',
    };
    items.push(
      ...createStandardDiagnosticSections(result.diagnostics),
      createStatus('success', successMessages[result.action.type]),
    );
  }

  return items;
}

function createCaptureResultItems(
  rawResult: Extract<ToolDomainResult, { kind: 'capture-result' }>,
  hints?: RenderHints,
): TextRenderableItem[] {
  const result = rawResult as CaptureResultWithVideo;

  if (result.capture && 'type' in result.capture && result.capture.type === 'video-recording') {
    const items: TextRenderableItem[] = [
      createHeader('Record Video', [
        ...(result.artifacts.simulatorId
          ? [{ label: 'Simulator', value: result.artifacts.simulatorId }]
          : []),
      ]),
    ];

    if (result.didError) {
      items.push(...createFailureStatusWithDiagnostics(result, 'Video recording failed.'));
      return items;
    }

    items.push(
      createStatus(
        'success',
        result.capture.state === 'started' ? 'Video recording started' : 'Video recording stopped',
      ),
    );
    const details: DetailTreeTextBlock['items'] = [];
    if (typeof result.capture.fps === 'number') {
      details.push(createValueDetailItem('FPS', String(result.capture.fps)));
    }
    if (result.capture.sessionId) {
      details.push(createValueDetailItem('Session ID', result.capture.sessionId));
    }
    if (result.capture.outputFile) {
      details.push(createPathDetailItem('Output File', result.capture.outputFile));
    }
    if (details.length > 0) {
      items.push(createDetailTree(details));
    }
    return items;
  }

  const capture = result.capture;
  const isRuntimeSnapshot =
    capture !== undefined && 'type' in capture && capture.type === 'runtime-snapshot';
  const isRuntimeSnapshotUnchanged =
    capture !== undefined && 'type' in capture && capture.type === 'runtime-snapshot-unchanged';
  const isUiHierarchy =
    (capture !== undefined && 'type' in capture && capture.type === 'ui-hierarchy') ||
    isRuntimeSnapshot ||
    isRuntimeSnapshotUnchanged ||
    result.error?.includes('accessibility hierarchy') === true ||
    result.error?.includes('runtime UI snapshot') === true;
  const title = hints?.headerTitle ?? (isUiHierarchy ? 'Snapshot UI' : 'Screenshot');
  const items: TextRenderableItem[] = [
    createHeader(title, [
      ...(result.artifacts.simulatorId
        ? [{ label: 'Simulator', value: result.artifacts.simulatorId }]
        : []),
    ]),
  ];

  if (result.didError) {
    items.push(...createStandardDiagnosticSections(result.diagnostics));
    items.push(...createUiErrorItems(result.uiError));
    let fallbackError = 'Failed to capture screenshot.';
    if (isRuntimeSnapshot) {
      fallbackError = 'Failed to get runtime UI snapshot.';
    } else if (isUiHierarchy) {
      fallbackError = 'Failed to get accessibility hierarchy.';
    }

    items.push(createStatus('error', result.error ?? fallbackError));
    return items;
  }

  if (isRuntimeSnapshotUnchanged) {
    const unchangedCapture = result.capture as RuntimeSnapshotUnchangedV1;
    items.push(
      ...createStandardDiagnosticSections(result.diagnostics),
      createStatus(
        'success',
        `Runtime UI snapshot unchanged (screenHash: ${unchangedCapture.screenHash}, seq: ${unchangedCapture.seq}).`,
      ),
    );
    return items;
  }

  if (isRuntimeSnapshot) {
    const snapshot = result.capture as RuntimeSnapshotV1;
    const suppressedTargetRefs = getSuppressedRuntimeTargetRefs(hints);
    const likelyTargetCount = countLikelyRuntimeTargets(snapshot, suppressedTargetRefs);
    const scrollAreaCount = countScrollableRuntimeAreas(snapshot);
    const evidenceSection = createRuntimeSnapshotEvidenceSection(snapshot, suppressedTargetRefs);
    const scrollAreasSection = createRuntimeSnapshotScrollAreasSection(snapshot);
    if (title === 'Wait for UI' && result.waitMatch) {
      items.push(createWaitMatchSection(result.waitMatch));
    }
    items.push(createRuntimeSnapshotTargetsSection(snapshot, suppressedTargetRefs));
    if (evidenceSection) {
      items.push(evidenceSection);
    }
    if (scrollAreasSection) {
      items.push(scrollAreasSection);
    }
    items.push(
      createSection('Tips', [
        '- Use target refs with tap, type_text, long_press, and touch.',
        ...(scrollAreaCount > 0 ? ['- Use scroll refs with swipe.'] : []),
        '- Refs are snapshot-specific; after snapshot_ui or wait_for_ui, use refs from the latest output.',
        '- Use wait_for_ui for text/assertions or changing UI.',
      ]),
    );
    items.push(
      ...createStandardDiagnosticSections(result.diagnostics),
      createStatus(
        'success',
        title === 'Wait for UI'
          ? `Wait completed; runtime UI snapshot refreshed with ${pluralize(snapshot.elements.length, 'element')}, ${pluralize(likelyTargetCount, 'likely target')}, and ${pluralize(scrollAreaCount, 'scroll area')}.`
          : `Runtime UI snapshot captured with ${pluralize(snapshot.elements.length, 'element')}, ${pluralize(likelyTargetCount, 'likely target')}, and ${pluralize(scrollAreaCount, 'scroll area')}.`,
      ),
    );
    return items;
  }

  if (isUiHierarchy) {
    const uiHierarchy = (result.capture as { type: 'ui-hierarchy'; uiHierarchy: unknown[] })
      .uiHierarchy;
    const uiHierarchyLines = formatUiHierarchyJsonLines(uiHierarchy);
    items.push(createSection('Accessibility Hierarchy', ['```json', ...uiHierarchyLines, '```']));
    items.push(
      createSection('Tips', [
        '- Prefer runtime snapshot refs from snapshot_ui or wait_for_ui for UI actions',
        '- Avoid guessing frame coordinates from screenshots or raw accessibility output',
        '- If a debugger is attached, ensure the app is running (not stopped on breakpoints)',
        '- Screenshots are for visual verification only',
      ]),
    );
    items.push(
      ...createStandardDiagnosticSections(result.diagnostics),
      createStatus('success', 'Accessibility hierarchy retrieved successfully.'),
    );
    return items;
  }

  items.push(createStatus('success', 'Screenshot captured'));
  const details: DetailTreeTextBlock['items'] = [];
  if (result.artifacts.screenshotPath) {
    details.push(createPathDetailItem('Screenshot', result.artifacts.screenshotPath));
  }
  if (result.capture && !('type' in result.capture)) {
    details.push(createValueDetailItem('Format', result.capture.format));
    details.push(
      createValueDetailItem('Size', `${result.capture.width}x${result.capture.height}px`),
    );
  }
  if (details.length > 0) {
    items.push(createDetailTree(details));
  }
  return items;
}

function createProcessListItems(
  result: Extract<ToolDomainResult, { kind: 'process-list' }>,
): TextRenderableItem[] {
  const items: TextRenderableItem[] = [createHeader('Swift Package Processes')];
  if (result.processes.length === 0) {
    items.push(createStatus('info', 'No Swift Package processes currently running.'));
    return items;
  }

  items.push(
    createSection(
      `Running Processes (${result.processes.length}):`,
      result.processes.flatMap((processInfo) => [
        `🟢 ${processInfo.name}`,
        `   PID: ${processInfo.processId} | Uptime: ${processInfo.uptimeSeconds}s`,
        `   Package: ${processInfo.artifacts?.packagePath ?? 'unknown package'}`,
      ]),
      { blankLineAfterTitle: true },
    ),
  );
  return items;
}

function createCoverageResultItems(
  rawResult: Extract<ToolDomainResult, { kind: 'coverage-result' }>,
): TextRenderableItem[] {
  const result = rawResult as CoverageResultWithOptionalRanges;
  const headerParams: HeaderRenderItem['params'] =
    result.coverageScope === 'report'
      ? [
          { label: 'xcresult', value: displayPath(result.artifacts.xcresultPath) },
          ...(result.artifacts.target
            ? [{ label: 'Target Filter', value: result.artifacts.target }]
            : []),
        ]
      : [
          { label: 'xcresult', value: displayPath(result.artifacts.xcresultPath) },
          ...(result.artifacts.file ? [{ label: 'File', value: result.artifacts.file }] : []),
        ];

  const items: TextRenderableItem[] = [
    createHeader(
      result.coverageScope === 'report' ? 'Coverage Report' : 'File Coverage',
      headerParams,
    ),
  ];

  if (result.didError) {
    items.push(
      ...createFailureStatusWithDiagnostics(
        result,
        `Failed to get ${result.coverageScope === 'report' ? 'coverage report' : 'file coverage'}.`,
      ),
    );
    return items;
  }

  if (result.coverageScope === 'report') {
    items.push(
      createStatus(
        'info',
        `Overall: ${result.summary.coveragePct?.toFixed(1) ?? '0.0'}% (${result.summary.coveredLines ?? 0}/${result.summary.executableLines ?? 0} lines)`,
      ),
    );
    items.push(
      createSection(
        'Targets',
        (result.targets ?? []).map(
          (entry) =>
            `${entry.name}: ${entry.coveragePct.toFixed(1)}% (${entry.coveredLines}/${entry.executableLines} lines)`,
        ),
      ),
    );

    for (const target of result.targets ?? []) {
      if (!target.files?.length) continue;
      items.push(
        createSection(
          `${target.name} Files`,
          target.files.map(
            (fileEntry) =>
              `${fileEntry.name}: ${fileEntry.coveragePct.toFixed(1)}% (${fileEntry.coveredLines}/${fileEntry.executableLines} lines)`,
          ),
        ),
      );
    }
    return items;
  }

  if (result.artifacts.sourceFilePath) {
    items.push(createSection(`File: ${displayPath(result.artifacts.sourceFilePath)}`, []));
  }
  items.push(
    createStatus(
      'info',
      `Coverage: ${result.summary.coveragePct?.toFixed(1) ?? '0.0'}% (${result.summary.coveredLines ?? 0}/${result.summary.executableLines ?? 0} lines)`,
    ),
  );

  if (result.functions?.notCovered?.length) {
    items.push(
      createSection(
        `Not Covered (${result.functions.notCoveredFunctionCount} ${result.functions.notCoveredFunctionCount === 1 ? 'function' : 'functions'}, ${result.functions.notCoveredLineCount} lines)`,
        result.functions.notCovered.map(
          (fn) => `L${fn.line}  ${fn.name} -- 0/${fn.executableLines} lines`,
        ),
        { icon: 'red-circle' },
      ),
    );
  }

  if (result.functions?.partialCoverage?.length) {
    items.push(
      createSection(
        `Partial Coverage (${result.functions.partialCoverageFunctionCount} ${result.functions.partialCoverageFunctionCount === 1 ? 'function' : 'functions'})`,
        result.functions.partialCoverage.map(
          (fn) =>
            `L${fn.line}  ${fn.name} -- ${fn.coveragePct.toFixed(1)}% (${fn.coveredLines}/${fn.executableLines} lines)`,
        ),
        { icon: 'yellow-circle' },
      ),
    );
  }

  if ((result.functions?.fullCoverageCount ?? 0) > 0) {
    items.push(
      createSection(
        `Full Coverage (${result.functions?.fullCoverageCount ?? 0} ${(result.functions?.fullCoverageCount ?? 0) === 1 ? 'function' : 'functions'}) -- all at 100%`,
        [],
        { icon: 'green-circle' },
      ),
    );
  }

  if (Array.isArray(result.uncoveredLineRanges)) {
    if (result.uncoveredLineRanges.length === 0) {
      items.push(createStatus('info', 'All executable lines are covered.'));
    } else {
      items.push(
        createSection(
          'Uncovered Lines',
          result.uncoveredLineRanges.map((range) =>
            range.start === range.end ? `L${range.start}` : `L${range.start}-${range.end}`,
          ),
        ),
      );
    }
  }

  return items;
}

function createDebugBreakpointItems(
  result: Extract<ToolDomainResult, { kind: 'debug-breakpoint-result' }>,
): TextRenderableItem[] {
  const title = result.action === 'add' ? 'Add Breakpoint' : 'Remove Breakpoint';
  const items: TextRenderableItem[] = [createHeader(title)];
  if (result.didError) {
    items.push(
      ...createFailureStatusWithDiagnostics(
        result,
        `Failed to ${result.action === 'add' ? 'add' : 'remove'} breakpoint.`,
      ),
    );
    return items;
  }

  if (result.action === 'add') {
    items.push(
      createStatus('success', `Breakpoint ${result.breakpoint.breakpointId ?? 'unknown'} set`),
    );
    const output =
      result.breakpoint.kind === 'function'
        ? result.breakpoint.breakpointId
          ? [`Set breakpoint ${result.breakpoint.breakpointId} on ${result.breakpoint.name}`]
          : []
        : result.breakpoint.breakpointId
          ? [
              `Set breakpoint ${result.breakpoint.breakpointId} at ${result.breakpoint.file}:${result.breakpoint.line}`,
            ]
          : [];
    if (output.length > 0) {
      items.push(createSection('Output:', output));
    }
    return items;
  }

  items.push(
    createStatus('success', `Breakpoint ${result.breakpoint.breakpointId ?? 'unknown'} removed`),
  );
  items.push(
    createSection('Output:', [
      `Removed breakpoint ${result.breakpoint.breakpointId ?? 'unknown'}.`,
    ]),
  );
  return items;
}

function createDebugCommandItems(
  result: Extract<ToolDomainResult, { kind: 'debug-command-result' }>,
): TextRenderableItem[] {
  const items: TextRenderableItem[] = [
    createHeader('LLDB Command', [{ label: 'Command', value: result.command }]),
  ];
  if (result.didError) {
    items.push(...createFailureStatusWithDiagnostics(result, 'Failed to run LLDB command.'));
    return items;
  }

  items.push(createStatus('success', 'Command executed'));
  if (result.outputLines.length > 0) {
    items.push(createSection('Output:', result.outputLines));
  }
  return items;
}

function createDebugSessionActionItems(
  result: Extract<ToolDomainResult, { kind: 'debug-session-action' }>,
): TextRenderableItem[] {
  switch (result.action) {
    case 'attach': {
      const items: TextRenderableItem[] = [createHeader('Attach Debugger')];
      if (result.didError) {
        items.push(...createFailureStatusWithDiagnostics(result, 'Failed to attach debugger.'));
        return items;
      }

      const resumeText =
        result.session?.executionState === 'running'
          ? 'Execution is running. App is responsive to UI interaction.'
          : 'Execution is paused. Use debug_continue to resume before UI automation.';
      items.push(
        createStatus(
          'success',
          `Attached DAP debugger to simulator process ${result.artifacts?.processId ?? 'unknown'} (${result.artifacts?.simulatorId ?? 'unknown'})`,
        ),
      );
      items.push(
        createDetailTree([
          { label: 'Debug session ID', value: result.session?.debugSessionId ?? 'unknown' },
          { label: 'Status', value: 'This session is now the current debug session.' },
          { label: 'Execution', value: resumeText },
        ]),
      );
      return items;
    }
    case 'continue':
      return result.didError
        ? [
            createHeader('Continue'),
            ...createFailureStatusWithDiagnostics(result, 'Failed to resume debugger.'),
          ]
        : [
            createHeader('Continue'),
            createStatus(
              'success',
              `Resumed debugger session${result.session ? ` ${result.session.debugSessionId}` : ''}`,
            ),
          ];
    case 'detach':
      return result.didError
        ? [
            createHeader('Detach'),
            ...createFailureStatusWithDiagnostics(result, 'Failed to detach debugger.'),
          ]
        : [
            createHeader('Detach'),
            createStatus(
              'success',
              `Detached debugger session${result.session ? ` ${result.session.debugSessionId}` : ''}`,
            ),
          ];
  }
}

function createDebugStackItems(
  result: Extract<ToolDomainResult, { kind: 'debug-stack-result' }>,
): TextRenderableItem[] {
  const items: TextRenderableItem[] = [createHeader('Stack Trace')];
  if (result.didError) {
    items.push(...createFailureStatusWithDiagnostics(result, 'Failed to get stack.'));
    return items;
  }

  items.push(createStatus('success', 'Stack trace retrieved'));
  if ('threads' in result && result.threads.length > 0) {
    items.push(createSection('Frames:', formatStackLines(result.threads)));
  }
  return items;
}

function createDebugVariablesItems(
  result: Extract<ToolDomainResult, { kind: 'debug-variables-result' }>,
): TextRenderableItem[] {
  const items: TextRenderableItem[] = [createHeader('Variables')];
  if (result.didError) {
    items.push(...createFailureStatusWithDiagnostics(result, 'Failed to get variables.'));
    return items;
  }

  items.push(createStatus('success', 'Variables retrieved'));
  if ('scopes' in result) {
    items.push(
      createSection('Values:', formatVariablesLines(result.scopes as DebugVariablesScopes)),
    );
  }
  return items;
}

function isCleanLikeBuildResult(
  result: Extract<ToolDomainResult, { kind: 'build-result' }>,
): boolean {
  if (!('artifacts' in result) || !result.artifacts) {
    return false;
  }
  if ('buildLogPath' in result.artifacts && typeof result.artifacts.buildLogPath === 'string') {
    return false;
  }
  return (
    ('packagePath' in result.artifacts && typeof result.artifacts.packagePath === 'string') ||
    ('workspacePath' in result.artifacts && typeof result.artifacts.workspacePath === 'string')
  );
}

function createCleanResultItems(
  result: Extract<ToolDomainResult, { kind: 'build-result' }>,
): TextRenderableItem[] {
  const isSwiftPackage =
    'artifacts' in result && !!result.artifacts && 'packagePath' in result.artifacts;
  const title = isSwiftPackage ? 'Swift Package Clean' : 'Clean';
  const params: HeaderRenderItem['params'] = [];

  if ('artifacts' in result && result.artifacts) {
    if ('packagePath' in result.artifacts && typeof result.artifacts.packagePath === 'string') {
      params.push({ label: 'Package', value: result.artifacts.packagePath });
    } else {
      if ('scheme' in result.artifacts && typeof result.artifacts.scheme === 'string') {
        params.push({ label: 'Scheme', value: result.artifacts.scheme });
      }
      if (
        'workspacePath' in result.artifacts &&
        typeof result.artifacts.workspacePath === 'string'
      ) {
        params.push({ label: 'Workspace', value: displayPath(result.artifacts.workspacePath) });
      }
      if (
        'configuration' in result.artifacts &&
        typeof result.artifacts.configuration === 'string'
      ) {
        params.push({ label: 'Configuration', value: result.artifacts.configuration });
      }
      if ('platform' in result.artifacts && typeof result.artifacts.platform === 'string') {
        params.push({ label: 'Platform', value: result.artifacts.platform });
      }
    }
  }

  const items: TextRenderableItem[] = [createHeader(title, params)];
  if (result.didError) {
    items.push(
      ...createFailureStatusWithDiagnostics(
        result,
        isSwiftPackage ? 'Swift package clean failed.' : 'Clean failed.',
      ),
    );
    return items;
  }

  items.push(
    createStatus(
      'success',
      isSwiftPackage ? 'Swift package cleaned successfully' : 'Clean successful',
    ),
  );
  return items;
}

function createDiagnosticSections(
  result: ToolDomainResult,
  suppressWarnings: boolean,
): SectionTextBlock[] {
  return createStandardDiagnosticSections(getResultDiagnostics(result), suppressWarnings);
}

function createSummaryBlock(result: ToolDomainResult): SummaryTextBlock | null {
  if ('summary' in result && result.summary && typeof result.summary === 'object') {
    const summary = result.summary;
    if ('status' in summary && (summary.status === 'SUCCEEDED' || summary.status === 'FAILED')) {
      return {
        type: 'summary',
        operation: inferXcodebuildOperation(result),
        status: summary.status,
        durationMs:
          'durationMs' in summary && typeof summary.durationMs === 'number'
            ? summary.durationMs
            : undefined,
        ...(result.kind === 'test-result' && result.summary.counts
          ? {
              passedTests: result.summary.counts.passed,
              failedTests: result.summary.counts.failed,
              skippedTests: result.summary.counts.skipped,
              totalTests:
                result.summary.counts.passed +
                result.summary.counts.failed +
                result.summary.counts.skipped,
            }
          : {}),
      };
    }
  }

  if (result.didError) {
    return {
      type: 'summary',
      operation: inferXcodebuildOperation(result),
      status: 'FAILED',
    };
  }
  return null;
}

function createTestDiscoveryProgress(
  result: Extract<ToolDomainResult, { kind: 'test-result' }>,
): TestDiscoveryRenderItem | null {
  const discovered = result.tests?.discovered;
  if (!discovered || discovered.total === 0) {
    return null;
  }
  return {
    type: 'test-discovery',
    operation: 'TEST',
    total: discovered.total,
    tests: discovered.items,
    truncated: discovered.items.length < discovered.total,
  };
}

function createBuildLikeDiagnosticItems(
  result: Extract<ToolDomainResult, { kind: 'build-result' | 'build-run-result' | 'test-result' }>,
  suppressWarnings: boolean,
): TextRenderableItem[] {
  return createStandardDiagnosticSections(
    'diagnostics' in result ? result.diagnostics : undefined,
    suppressWarnings,
  );
}

function createBuildRunSyntheticStepItems(
  result: Extract<ToolDomainResult, { kind: 'build-run-result' }>,
): TextRenderableItem[] {
  if (result.didError) {
    return [];
  }

  const target =
    result.summary.target ??
    ('simulatorId' in result.artifacts
      ? 'simulator'
      : 'deviceId' in result.artifacts
        ? 'device'
        : 'packagePath' in result.artifacts
          ? 'swift-package'
          : 'macos');

  const stepsByTarget: Record<
    string,
    Array<{ level: StatusRenderItem['level']; message: string }>
  > = {
    device: [
      { level: 'info', message: 'Resolving app path' },
      { level: 'success', message: 'Resolving app path' },
      { level: 'info', message: 'Installing app' },
      { level: 'success', message: 'Installing app' },
      { level: 'info', message: 'Launching app' },
    ],
    macos: [
      { level: 'info', message: 'Resolving app path' },
      { level: 'success', message: 'Resolving app path' },
      { level: 'info', message: 'Launching app' },
      { level: 'success', message: 'Launching app' },
    ],
    simulator: [
      { level: 'info', message: 'Resolving app path' },
      { level: 'success', message: 'Resolving app path' },
      { level: 'info', message: 'Booting simulator' },
      { level: 'success', message: 'Booting simulator' },
      { level: 'info', message: 'Installing app' },
      { level: 'success', message: 'Installing app' },
      { level: 'info', message: 'Launching app' },
    ],
  };

  return (stepsByTarget[target] ?? []).map((step) => createStatus(step.level, step.message));
}

function appendCommaToLastContentLine(lines: string[]): void {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index] && lines[index]!.length > 0) {
      lines[index] = `${lines[index]},`;
      return;
    }
  }
}

function formatUiHierarchyJsonLines(value: unknown, indentLevel = 0): string[] {
  const indent = ' '.repeat(indentLevel);

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return [`${indent}[`, '', `${indent}]`];
    }

    const lines = [`${indent}[`];
    value.forEach((item, index) => {
      const itemLines = formatUiHierarchyJsonLines(item, indentLevel);
      if (index < value.length - 1) {
        appendCommaToLastContentLine(itemLines);
      }
      lines.push(...itemLines);
    });
    lines.push(`${indent}]`);
    return lines;
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      return [`${indent}{}`];
    }

    const lines = [`${indent}{`];
    entries.forEach(([key, entryValue], index) => {
      const propertyLines = formatUiHierarchyJsonPropertyLines(key, entryValue, indentLevel + 2);
      if (index < entries.length - 1) {
        appendCommaToLastContentLine(propertyLines);
      }
      lines.push(...propertyLines);
    });
    lines.push(`${indent}}`);
    return lines;
  }

  return [`${indent}${JSON.stringify(value)}`];
}

function formatUiHierarchyJsonPropertyLines(
  key: string,
  value: unknown,
  indentLevel: number,
): string[] {
  const indent = ' '.repeat(indentLevel);
  const prefix = `${indent}${JSON.stringify(key)} : `;

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return [`${prefix}[`, '', `${indent}]`];
    }

    const lines = [`${prefix}[`];
    value.forEach((item, index) => {
      const itemLines = formatUiHierarchyJsonLines(item, indentLevel + 2);
      if (index < value.length - 1) {
        appendCommaToLastContentLine(itemLines);
      }
      lines.push(...itemLines);
    });
    lines.push(`${indent}]`);
    return lines;
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      return [`${prefix}{}`];
    }

    const lines = [`${prefix}{`];
    entries.forEach(([childKey, childValue], index) => {
      const propertyLines = formatUiHierarchyJsonPropertyLines(
        childKey,
        childValue,
        indentLevel + 2,
      );
      if (index < entries.length - 1) {
        appendCommaToLastContentLine(propertyLines);
      }
      lines.push(...propertyLines);
    });
    lines.push(`${indent}}`);
    return lines;
  }

  return [`${prefix}${JSON.stringify(value)}`];
}

export function createBuildLikeTailItems(result: ToolDomainResult): TextRenderableItem[] {
  switch (result.kind) {
    case 'build-result': {
      if (!('artifacts' in result) || !result.artifacts) return [];
      const items: DetailTreeTextBlock['items'] = [];
      if ('bundleId' in result.artifacts && typeof result.artifacts.bundleId === 'string') {
        items.push(createValueDetailItem('Bundle ID', result.artifacts.bundleId));
      }
      if ('buildLogPath' in result.artifacts && typeof result.artifacts.buildLogPath === 'string') {
        items.push(createPathDetailItem('Build Logs', result.artifacts.buildLogPath));
      }
      if (
        'testProductsPath' in result.artifacts &&
        typeof result.artifacts.testProductsPath === 'string'
      ) {
        items.push(createPathDetailItem('Test Products', result.artifacts.testProductsPath));
      }
      if ('xctestrunPaths' in result.artifacts && Array.isArray(result.artifacts.xctestrunPaths)) {
        for (const xctestrunPath of result.artifacts.xctestrunPaths) {
          items.push(createPathDetailItem('XCTest Run', xctestrunPath));
        }
      }
      return items.length > 0 ? [createDetailTree(items)] : [];
    }
    case 'build-run-result': {
      const items: DetailTreeTextBlock['items'] = [];
      const appLikePath =
        'appPath' in result.artifacts && typeof result.artifacts.appPath === 'string'
          ? result.artifacts.appPath
          : 'executablePath' in result.artifacts &&
              typeof result.artifacts.executablePath === 'string'
            ? result.artifacts.executablePath
            : undefined;
      if (typeof appLikePath === 'string') {
        items.push(createPathDetailItem('App Path', appLikePath));
      }
      if ('bundleId' in result.artifacts && typeof result.artifacts.bundleId === 'string') {
        items.push(createValueDetailItem('Bundle ID', result.artifacts.bundleId));
      }
      if ('processId' in result.artifacts && typeof result.artifacts.processId === 'number') {
        items.push(createValueDetailItem('Process ID', String(result.artifacts.processId)));
      }
      if (
        'buildLogPath' in result.artifacts &&
        typeof result.artifacts.buildLogPath === 'string' &&
        !(result.didError && result.summary.target === 'swift-package')
      ) {
        items.push(createPathDetailItem('Build Logs', result.artifacts.buildLogPath));
      }
      if (
        'runtimeLogPath' in result.artifacts &&
        typeof result.artifacts.runtimeLogPath === 'string'
      ) {
        items.push(createPathDetailItem('Runtime Logs', result.artifacts.runtimeLogPath));
      }
      if ('osLogPath' in result.artifacts && typeof result.artifacts.osLogPath === 'string') {
        items.push(createPathDetailItem('OSLog', result.artifacts.osLogPath));
      }
      if (items.length === 0) return [];
      const tailItems: TextRenderableItem[] = [
        ...(!result.didError ? [createStatus('success', 'Build & Run complete')] : []),
        createDetailTree(items),
      ];
      const outputLines = result.output
        ? result.output.stdout.length > 0
          ? result.output.stdout
          : result.output.stderr
        : [];
      if (outputLines.length > 0) {
        tailItems.push(createSection('Output', outputLines));
      }
      return tailItems;
    }
    case 'test-result': {
      if (!('artifacts' in result) || !result.artifacts) return [];
      const items: DetailTreeTextBlock['items'] = [];
      if ('xcresultPath' in result.artifacts && typeof result.artifacts.xcresultPath === 'string') {
        items.push(createPathDetailItem('Result Bundle', result.artifacts.xcresultPath));
      }
      if ('buildLogPath' in result.artifacts && typeof result.artifacts.buildLogPath === 'string') {
        items.push(createPathDetailItem('Build Logs', result.artifacts.buildLogPath));
      }
      if (
        'testProductsPath' in result.artifacts &&
        typeof result.artifacts.testProductsPath === 'string'
      ) {
        items.push(createPathDetailItem('Test Products', result.artifacts.testProductsPath));
      }
      if (
        'xctestrunPath' in result.artifacts &&
        typeof result.artifacts.xctestrunPath === 'string'
      ) {
        items.push(createPathDetailItem('XCTest Run', result.artifacts.xctestrunPath));
      }
      return items.length > 0 ? [createDetailTree(items)] : [];
    }
    default:
      return [];
  }
}

export function createStreamingFinalItems(result: ToolDomainResult): TextRenderableItem[] {
  const items: TextRenderableItem[] = [];

  if (
    'diagnostics' in result &&
    result.diagnostics &&
    'rawOutput' in result.diagnostics &&
    Array.isArray(result.diagnostics.rawOutput)
  ) {
    items.push(
      ...createStandardDiagnosticSections({
        warnings: [],
        errors: [],
        rawOutput: result.diagnostics.rawOutput,
      }),
    );
  }

  const summary = createSummaryBlock(result);
  if (summary) {
    items.push(summary);
  }

  items.push(...createBuildLikeTailItems(result));
  return items;
}

function createRawResponseArtifactItems(pathValue?: string): TextRenderableItem[] {
  return pathValue
    ? [
        createDetailTree([
          {
            label: 'Raw Response JSON',
            path: pathValue,
          },
        ]),
      ]
    : [];
}

function createSpecialCaseItems(
  result: ToolDomainResult,
  hints?: RenderHints,
): TextRenderableItem[] | null {
  switch (result.kind) {
    case 'error':
      return [
        createHeader('Error'),
        createStatus('error', result.error),
        createDetailTree([
          { label: 'Category', value: result.category },
          { label: 'Code', value: result.code },
        ]),
      ];
    case 'app-path':
      return createAppPathItems(result);
    case 'bundle-id':
      return createBundleIdItems(result, hints);
    case 'install-result':
      return createInstallResultItems(result);
    case 'launch-result':
      return createLaunchResultItems(result);
    case 'stop-result':
      return createStopResultItems(result);
    case 'scheme-list':
      return createSchemeListItems(result);
    case 'build-settings':
      return createBuildSettingsItems(result);
    case 'project-list':
      return createProjectListItems(result);
    case 'scaffold-result':
      return createScaffoldResultItems(result);
    case 'session-defaults':
      return createSessionDefaultsItems(result);
    case 'session-profile':
      return createSessionProfileItems(result);
    case 'simulator-action-result':
      return createSimulatorActionItems(result);
    case 'capture-result':
      return createCaptureResultItems(result, hints);
    case 'process-list':
      return createProcessListItems(result);
    case 'coverage-result':
      return createCoverageResultItems(result);
    case 'debug-breakpoint-result':
      return createDebugBreakpointItems(result);
    case 'debug-command-result':
      return createDebugCommandItems(result);
    case 'debug-session-action':
      return createDebugSessionActionItems(result);
    case 'debug-stack-result':
      return createDebugStackItems(result);
    case 'debug-variables-result':
      return createDebugVariablesItems(result);
    case 'build-result':
      return isCleanLikeBuildResult(result) ? createCleanResultItems(result) : null;
    case 'simulator-list':
      return createSimulatorListItems(result);
    case 'device-list':
      return createDeviceListItems(result);
    case 'doctor-report':
      return createDoctorReportItems(result);
    case 'workflow-selection':
      return createWorkflowSelectionItems(result);
    case 'ui-action-result': {
      const headerTitleMap: Record<typeof result.action.type, string> = {
        tap: 'Tap',
        swipe: 'Swipe',
        drag: 'Drag',
        touch: 'Touch',
        'long-press': 'Long Press',
        button: 'Button',
        gesture: 'Gesture',
        'type-text': 'Type Text',
        'key-press': 'Key Press',
        'key-sequence': 'Key Sequence',
        batch: 'Batch UI Actions',
      };
      const items: TextRenderableItem[] = [
        createHeader(headerTitleMap[result.action.type], [
          { label: 'Simulator', value: result.artifacts.simulatorId },
        ]),
      ];
      if (result.didError) {
        items.push(...createStandardDiagnosticSections(result.diagnostics));
        items.push(...createUiErrorItems(result.uiError));
        items.push(createStatus('error', result.error ?? 'UI action failed.'));
        return items;
      }
      let successMessage = 'UI action completed successfully.';
      switch (result.action.type) {
        case 'tap':
          successMessage = `Tap on elementRef ${result.action.elementRef} simulated successfully.`;
          break;
        case 'swipe': {
          const durationText =
            typeof result.action.durationSeconds === 'number'
              ? ` duration=${result.action.durationSeconds}s`
              : '';
          successMessage =
            `Swipe ${result.action.direction} within elementRef ${result.action.withinElementRef}` +
            `${durationText} simulated successfully.`;
          break;
        }
        case 'drag': {
          const durationText =
            typeof result.action.durationSeconds === 'number'
              ? ` duration=${result.action.durationSeconds}s`
              : '';
          successMessage =
            `Drag ${result.action.direction} from elementRef ${result.action.elementRef}` +
            `${durationText} simulated successfully.`;
          break;
        }
        case 'touch':
          successMessage = `Touch event (${result.action.event ?? 'touch'}) on elementRef ${result.action.elementRef} executed successfully.`;
          break;
        case 'long-press':
          successMessage = `Long press on elementRef ${result.action.elementRef} for ${result.action.durationMs}ms simulated successfully.`;
          break;
        case 'button':
          successMessage = `Hardware button '${result.action.button}' pressed successfully.`;
          break;
        case 'gesture':
          successMessage = `Gesture '${result.action.gesture}' executed successfully.`;
          break;
        case 'type-text': {
          const targetText = result.action.elementRef
            ? ` into elementRef ${result.action.elementRef}`
            : '';
          const lengthText =
            typeof result.action.textLength === 'number'
              ? ` (${pluralize(result.action.textLength, 'character')})`
              : '';
          successMessage = `Text typed${targetText}${lengthText} successfully.`;
          break;
        }
        case 'key-press':
          successMessage = `Key press (code: ${result.action.keyCode}) simulated successfully.`;
          break;
        case 'key-sequence':
          successMessage = `Key sequence [${result.action.keyCodes.join(',')}] executed successfully.`;
          break;
        case 'batch':
          successMessage = `Batch UI automation completed successfully (${pluralize(result.action.stepCount, 'step')}).`;
          break;
      }
      items.push(
        ...createStandardDiagnosticSections(result.diagnostics),
        createStatus('success', successMessage),
      );
      return items;
    }
    case 'xcode-bridge-status': {
      const title = result.action === 'disconnect' ? 'Bridge Disconnect' : 'Bridge Status';
      const items: TextRenderableItem[] = [createHeader(title)];
      if (!result.didError || result.action === 'status') {
        items.push(createSection('Status', [JSON.stringify(result.status, null, 2)]));
      }
      if (result.didError) {
        items.push(...createFailureStatusWithDiagnostics(result, `${title} failed`));
      } else if (result.action === 'disconnect') {
        items.push(createStatus('success', 'Bridge disconnected'));
      }
      return items;
    }
    case 'xcode-bridge-sync':
      return result.didError
        ? [
            createHeader('Bridge Sync'),
            ...createFailureStatusWithDiagnostics(result, 'Bridge sync failed'),
          ]
        : [
            createHeader('Bridge Sync'),
            createSection('Sync Result', [
              JSON.stringify({ sync: result.sync, status: result.status }, null, 2),
            ]),
            createStatus('success', 'Bridge sync completed'),
          ];
    case 'xcode-bridge-tool-list': {
      const items: TextRenderableItem[] = [createHeader('Xcode IDE List Tools')];
      if (result.didError) {
        items.push(...createFailureStatusWithDiagnostics(result, 'Failed to list bridge tools'));
        items.push(...createRawResponseArtifactItems(result.artifacts?.rawResponseJsonPath));
        return items;
      }
      items.push(
        createStatus(
          'success',
          result.artifacts?.rawResponseJsonPath
            ? `Found ${result.toolCount} tool(s). Raw response saved to artifact.`
            : `Found ${result.toolCount} tool(s)`,
        ),
      );
      items.push(...createRawResponseArtifactItems(result.artifacts?.rawResponseJsonPath));
      return items;
    }
    case 'xcode-bridge-call-result': {
      const items: TextRenderableItem[] = [
        createHeader('Xcode IDE Call Tool', [{ label: 'Remote Tool', value: result.remoteTool }]),
      ];
      if (result.didError) {
        items.push(
          ...createFailureStatusWithDiagnostics(result, `Tool "${result.remoteTool}" failed`),
        );
        items.push(...createRawResponseArtifactItems(result.artifacts?.rawResponseJsonPath));
        return items;
      }
      items.push(
        createStatus(
          'success',
          result.artifacts?.rawResponseJsonPath
            ? `Tool "${result.remoteTool}" completed successfully. Raw response saved to artifact.`
            : `Tool "${result.remoteTool}" completed successfully`,
        ),
      );
      items.push(...createRawResponseArtifactItems(result.artifacts?.rawResponseJsonPath));
      return items;
    }
    default:
      return null;
  }
}

export function createNextStepsBlock(
  steps: readonly NextStep[],
  runtime?: 'cli' | 'daemon' | 'mcp',
): NextStepsTextBlock | null {
  return steps.length > 0 ? { type: 'next-steps', steps: [...steps], runtime } : null;
}

export function renderDomainResultTextItems(
  result: ToolDomainResult,
  hints?: RenderHints,
  options?: DomainResultTextOptions,
): TextRenderableItem[] {
  const specialCaseItems = createSpecialCaseItems(result, hints);
  if (specialCaseItems) {
    return specialCaseItems;
  }

  const suppressWarnings = options?.suppressWarnings ?? false;
  const items: TextRenderableItem[] = [];
  if (
    result.kind === 'build-result' ||
    result.kind === 'build-run-result' ||
    result.kind === 'test-result'
  ) {
    if (result.request) {
      const title = hints?.headerTitle ?? deriveBuildLikeTitle(result.kind, result.request);
      items.push(createHeader(title, invocationRequestToHeaderParams(result.request)));
    }
    if (result.kind === 'test-result') {
      const discovery = createTestDiscoveryProgress(result);
      if (discovery) {
        items.push(discovery);
      }
    }
    const tailItems = createBuildLikeTailItems(result);
    items.push(...createBuildLikeDiagnosticItems(result, suppressWarnings));
    if (result.kind === 'build-run-result') {
      items.push(...createBuildRunSyntheticStepItems(result));
    }
    if (result.kind === 'test-result' && result.testCases && result.testCases.length > 0) {
      for (const testCase of result.testCases) {
        items.push({
          type: 'test-case-result',
          operation: 'TEST',
          ...(testCase.suite !== undefined ? { suite: testCase.suite } : {}),
          test: testCase.test,
          status: testCase.status,
          ...(testCase.durationMs !== undefined ? { durationMs: testCase.durationMs } : {}),
        });
      }
    }
    const summary = createSummaryBlock(result);
    if (summary) {
      items.push(summary);
    }
    items.push(...tailItems);
    return items;
  }

  items.push(...createDiagnosticSections(result, suppressWarnings));
  const summary = createSummaryBlock(result);
  if (summary) {
    items.push(summary);
  }
  items.push(...createBuildLikeTailItems(result));
  return items;
}
