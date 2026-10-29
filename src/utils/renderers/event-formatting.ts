import { existsSync } from 'node:fs';
import path from 'node:path';
import { escape, globSync } from 'glob';
import type {
  ArtifactRenderItem,
  BuildStageRenderItem,
  CompilerErrorRenderItem,
  CompilerWarningRenderItem,
  DetailTreeRenderItem,
  FileRefRenderItem,
  HeaderRenderItem,
  SectionRenderItem,
  StatusRenderItem,
  TableRenderItem,
  TestCaseResultRenderItem,
  TestDiscoveryRenderItem,
  TestFailureRenderItem,
  TestProgressRenderItem,
} from '../../rendering/render-items.ts';
import type {
  DetailTreePathItem,
  DetailTreeTextBlock,
  DetailTreeValueItem,
  FileRefTextBlock,
  NextStepsTextBlock,
  SectionTextBlock,
  SummaryTextBlock,
  TableTextBlock,
} from './domain-result-text.ts';
import { displayPath } from '../build-preflight.ts';
import type { FilePathRenderStyle } from '../runtime-config-types.ts';
import { formatPathTree } from './path-tree.ts';
import { renderNextStepsSection } from '../responses/next-steps-renderer.ts';

// --- Operation emoji map ---

export const OPERATION_EMOJI: Record<string, string> = {
  Build: '\u{1F528}',
  'Build & Run': '\u{1F680}',
  Clean: '\u{1F9F9}',
  Test: '\u{1F9EA}',
  'List Schemes': '\u{1F50D}',
  'Show Build Settings': '\u{1F50D}',
  'Get App Path': '\u{1F50D}',
  'Coverage Report': '\u{1F4CA}',
  'File Coverage': '\u{1F4CA}',
  'List Simulators': '\u{1F4F1}',
  'Boot Simulator': '\u{1F4F1}',
  'Shut Down Simulator': '\u{1F4F1}',
  'Open Simulator': '\u{1F4F1}',
  'Set Appearance': '\u{1F3A8}',
  'Set Location': '\u{1F4CD}',
  'Reset Location': '\u{1F4CD}',
  Statusbar: '\u{1F4F1}',
  'Erase Simulator': '\u{1F5D1}',
  'List Devices': '\u{1F4F1}',
  'Install App': '\u{1F4E6}',
  'Launch App': '\u{1F680}',
  'Stop App': '\u{1F6D1}',
  'Launch macOS App': '\u{1F680}',
  'Stop macOS App': '\u{1F6D1}',
  'Discover Projects': '\u{1F50D}',
  'Get Bundle ID': '\u{1F50D}',
  'Get macOS Bundle ID': '\u{1F50D}',
  'Scaffold iOS Project': '\u{1F4DD}',
  'Scaffold macOS Project': '\u{1F4DD}',
  'Set Defaults': '\u{2699}\u{FE0F}',
  'Show Defaults': '\u{2699}\u{FE0F}',
  'Clear Defaults': '\u{2699}\u{FE0F}',
  'Use Defaults Profile': '\u{2699}\u{FE0F}',
  'Sync Xcode Defaults': '\u{2699}\u{FE0F}',
  'Start Log Capture': '\u{1F4DD}',
  'Stop Log Capture': '\u{1F4DD}',
  'Attach Debugger': '\u{1F41B}',
  'Add Breakpoint': '\u{1F41B}',
  'Remove Breakpoint': '\u{1F41B}',
  Continue: '\u{1F41B}',
  Detach: '\u{1F41B}',
  'LLDB Command': '\u{1F41B}',
  'Stack Trace': '\u{1F41B}',
  Variables: '\u{1F41B}',
  Tap: '\u{1F446}',
  Swipe: '\u{1F446}',
  'Type Text': '\u{2328}\u{FE0F}',
  Screenshot: '\u{1F4F7}',
  'Snapshot UI': '\u{1F4F7}',
  Button: '\u{1F446}',
  Gesture: '\u{1F446}',
  'Key Press': '\u{2328}\u{FE0F}',
  'Key Sequence': '\u{2328}\u{FE0F}',
  'Long Press': '\u{1F446}',
  Touch: '\u{1F446}',
  'Swift Package Build': '\u{1F4E6}',
  'Swift Package Test': '\u{1F9EA}',
  'Swift Package Clean': '\u{1F9F9}',
  'Swift Package Run': '\u{1F680}',
  'Swift Package List': '\u{1F4E6}',
  'Swift Package Processes': '\u{1F4E6}',
  'Swift Package Stop': '\u{1F6D1}',
  'Xcode IDE Call Tool': '\u{1F527}',
  'Xcode IDE List Tools': '\u{1F527}',
  'Bridge Disconnect': '\u{1F527}',
  'Bridge Status': '\u{1F527}',
  'Bridge Sync': '\u{1F527}',
  Doctor: '\u{1FA7A}',
  'Manage Workflows': '\u{2699}\u{FE0F}',
  'Record Video': '\u{1F3AC}',
};

// --- Detail tree formatting ---

type DetailTreeItem = DetailTreeValueItem | DetailTreePathItem;

function isPathDetailItem(detail: DetailTreeItem): detail is DetailTreePathItem {
  return 'path' in detail;
}

function formatValueDetailTreeLines(details: readonly DetailTreeValueItem[]): string[] {
  return details.map((detail, index) => {
    const branch = index === details.length - 1 ? '\u2514' : '\u251C';
    return `  ${branch} ${detail.label}: ${detail.value}`;
  });
}

export interface DetailTreeFormattingOptions {
  filePathRenderStyle?: FilePathRenderStyle;
}

function formatPathListLines(details: readonly DetailTreePathItem[]): string[] {
  return details.map((detail, index) => {
    const branch = index === details.length - 1 ? '└' : '├';
    const displayed = displayPath(detail.path);
    return detail.label ? `${branch} ${detail.label}: ${displayed}` : `${branch} ${displayed}`;
  });
}

function formatDetailTreeLines(
  details: readonly DetailTreeItem[],
  options: DetailTreeFormattingOptions = {},
): string[] {
  const valueDetails: DetailTreeValueItem[] = [];
  const pathDetails: DetailTreePathItem[] = [];
  for (const detail of details) {
    if (isPathDetailItem(detail)) {
      pathDetails.push(detail);
    } else {
      valueDetails.push(detail);
    }
  }

  if (pathDetails.length === 0) {
    return formatValueDetailTreeLines(valueDetails);
  }

  const pathLines =
    options.filePathRenderStyle === 'list'
      ? formatPathListLines(pathDetails)
      : formatPathTree(pathDetails, { formatPath: displayPath });

  const lines = valueDetails.map((detail) => `  ├ ${detail.label}: ${detail.value}`);
  lines.push('  \u2514 Files:');
  for (const line of pathLines) {
    lines.push(`     ${line}`);
  }
  return lines;
}

// --- Diagnostic path resolution ---

const FILE_DIAGNOSTIC_REGEX =
  /^(?<file>.+?):(?<line>\d+)(?::(?<column>\d+))?:\s*(?<kind>warning|error):\s*(?<message>.+)$/i;
const TOOLCHAIN_DIAGNOSTIC_REGEX = /^(warning|error):\s+.+$/i;
const LINKER_DIAGNOSTIC_REGEX = /^(ld|clang|swiftc):\s+(warning|error):\s+.+$/i;
const DIAGNOSTIC_PATH_IGNORE_PATTERNS = [
  '**/.git/**',
  '**/node_modules/**',
  '**/build/**',
  '**/dist/**',
  '**/DerivedData/**',
];
const resolvedDiagnosticPathCache = new Map<string, string | null>();

export interface GroupedDiagnosticEntry {
  message: string;
  location?: string;
}

export interface DiagnosticFormattingOptions {
  baseDir?: string;
}

function resolveDiagnosticPathCandidate(
  filePath: string,
  options?: DiagnosticFormattingOptions,
): string {
  if (path.isAbsolute(filePath) || !options?.baseDir) {
    return filePath;
  }

  const directCandidate = path.resolve(options.baseDir, filePath);
  if (existsSync(directCandidate)) {
    return directCandidate;
  }

  if (filePath.includes('/') || filePath.includes(path.sep)) {
    return filePath;
  }

  const cacheKey = `${options.baseDir}::${filePath}`;
  const cached = resolvedDiagnosticPathCache.get(cacheKey);
  if (cached !== undefined) {
    return cached ?? filePath;
  }

  const matches = globSync(`**/${escape(filePath)}`, {
    cwd: options.baseDir,
    nodir: true,
    ignore: DIAGNOSTIC_PATH_IGNORE_PATTERNS,
  });

  if (matches.length === 1) {
    const resolvedMatch = path.resolve(options.baseDir, matches[0]);
    resolvedDiagnosticPathCache.set(cacheKey, resolvedMatch);
    return resolvedMatch;
  }

  resolvedDiagnosticPathCache.set(cacheKey, null);
  return filePath;
}

function formatDiagnosticFilePath(filePath: string, options?: DiagnosticFormattingOptions): string {
  const candidate = resolveDiagnosticPathCandidate(filePath, options);
  if (!path.isAbsolute(candidate)) {
    return candidate;
  }

  const relative = path.relative(process.cwd(), candidate);
  if (relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return relative;
  }

  return candidate;
}

function parseHumanDiagnostic(
  event: CompilerWarningRenderItem | CompilerErrorRenderItem,
  kind: 'warning' | 'error',
  options?: DiagnosticFormattingOptions,
): GroupedDiagnosticEntry {
  const rawLine = event.rawLine.trim();
  const fileMatch = FILE_DIAGNOSTIC_REGEX.exec(rawLine);

  if (fileMatch?.groups) {
    const filePath = formatDiagnosticFilePath(fileMatch.groups.file, options);
    const line = fileMatch.groups.line;
    const column = fileMatch.groups.column;
    const message = fileMatch.groups.message;
    const location = column ? `${filePath}:${line}:${column}` : `${filePath}:${line}`;
    return { message: `${kind}: ${message}`, location };
  }

  if (TOOLCHAIN_DIAGNOSTIC_REGEX.test(rawLine) || LINKER_DIAGNOSTIC_REGEX.test(rawLine)) {
    return { message: `${kind}: ${event.message}` };
  }

  if (event.location) {
    return { message: `${event.location}: ${kind}: ${event.message}` };
  }

  return { message: `${kind}: ${event.message}` };
}

// --- Canonical event formatters ---

export interface HeaderFormattingOptions {
  includeDetails?: boolean;
}

export function formatHeaderEvent(
  event: HeaderRenderItem,
  options: HeaderFormattingOptions = {},
): string {
  const emoji = OPERATION_EMOJI[event.operation] ?? '\u{2699}\u{FE0F}';
  const lines: string[] = [`${emoji} ${event.operation}`];

  if (options.includeDetails === false) {
    return lines.join('\n');
  }

  const onlyTestingParams = event.params.filter((param) => param.label === '-only-testing');
  const skipTestingParams = event.params.filter((param) => param.label === '-skip-testing');
  const regularParams = event.params.filter(
    (param) => param.label !== '-only-testing' && param.label !== '-skip-testing',
  );

  if (event.params.length > 0) {
    lines.push('');
  }

  for (const param of regularParams) {
    lines.push(`   ${param.label}: ${param.value}`);
  }

  if (onlyTestingParams.length > 0 || skipTestingParams.length > 0) {
    lines.push('   Selective Testing:');
    for (const param of onlyTestingParams) {
      lines.push(`     ${param.value}`);
    }
    for (const param of skipTestingParams) {
      lines.push(`     Skip Testing: ${param.value}`);
    }
  }

  return lines.join('\n');
}

export function formatStatusLineEvent(event: StatusRenderItem): string {
  switch (event.level) {
    case 'success':
      return `\u{2705} ${event.message}`;
    case 'error':
      return `\u{274C} ${event.message}`;
    case 'warning':
      return `\u{26A0}\u{FE0F} ${event.message}`;
    default:
      return `\u{2139}\u{FE0F} ${event.message}`;
  }
}

const SECTION_ICON_MAP: Record<NonNullable<SectionRenderItem['icon']>, string> = {
  'red-circle': '\u{1F534}',
  'yellow-circle': '\u{1F7E1}',
  'green-circle': '\u{1F7E2}',
  checkmark: '\u{2705}',
  cross: '\u{274C}',
  info: '\u{2139}\u{FE0F}',
};

export function formatSectionEvent(event: SectionRenderItem | SectionTextBlock): string {
  const icon = event.icon ? `${SECTION_ICON_MAP[event.icon]} ` : '';
  const headerLine = `${icon}${event.title}`;
  if (event.lines.length === 0) {
    return headerLine;
  }
  const indent = event.icon ? '   ' : '  ';
  const indented = event.lines.map((line) => (line === '' ? '' : `${indent}${line}`));
  const lines = [headerLine];
  if (event.blankLineAfterTitle) {
    lines.push('');
  }
  lines.push(...indented);
  return lines.join('\n');
}

export function formatTableEvent(event: TableRenderItem | TableTextBlock): string {
  const lines: string[] = [];
  const heading =
    'heading' in event ? (event.heading ?? ('name' in event ? event.name : undefined)) : undefined;
  if (heading) {
    lines.push(heading);
    lines.push('');
  }

  if (event.columns.length === 0 || event.rows.length === 0) {
    return lines.join('\n');
  }

  const colWidths = event.columns.map((col) => col.length);
  for (const row of event.rows) {
    for (let i = 0; i < event.columns.length; i++) {
      const value = row[event.columns[i]] ?? '';
      colWidths[i] = Math.max(colWidths[i], value.length);
    }
  }

  const headerLine = event.columns.map((col, i) => col.padEnd(colWidths[i])).join('  ');
  lines.push(headerLine);
  lines.push(colWidths.map((w) => '-'.repeat(w)).join('  '));

  for (const row of event.rows) {
    const rowLine = event.columns.map((col, i) => (row[col] ?? '').padEnd(colWidths[i])).join('  ');
    lines.push(rowLine);
  }

  return lines.join('\n');
}

export function formatFileRefEvent(
  event: ArtifactRenderItem | FileRefRenderItem | FileRefTextBlock,
): string {
  const displayed = displayPath(event.path);
  const label = 'label' in event ? event.label : 'name' in event ? event.name : undefined;
  if (label) {
    return `${label}: ${displayed}`;
  }
  return displayed;
}

export function formatDetailTreeEvent(
  event: DetailTreeRenderItem | DetailTreeTextBlock,
  options: DetailTreeFormattingOptions = {},
): string {
  return formatDetailTreeLines(event.items, options).join('\n');
}

// --- Xcodebuild-specific formatters ---

export function extractGroupedCompilerError(
  event: CompilerErrorRenderItem,
  options?: DiagnosticFormattingOptions,
): GroupedDiagnosticEntry | null {
  const firstRawLine = event.rawLine.split('\n')[0].trim();
  const fileMatch = FILE_DIAGNOSTIC_REGEX.exec(firstRawLine);

  if (fileMatch?.groups) {
    const filePath = formatDiagnosticFilePath(fileMatch.groups.file, options);
    const line = fileMatch.groups.line;
    const column = fileMatch.groups.column;
    const location = column ? `${filePath}:${line}:${column}` : `${filePath}:${line}`;
    return { message: event.message, location };
  }

  if (event.location) {
    return { message: event.message, location: formatLocationPath(event.location, options) };
  }

  return null;
}

export function formatGroupedCompilerErrors(
  events: CompilerErrorRenderItem[],
  options?: DiagnosticFormattingOptions,
): string {
  const hasFileLocated = events.some((e) => extractGroupedCompilerError(e, options) !== null);
  const heading = hasFileLocated
    ? `Compiler Errors (${events.length}):`
    : `Errors (${events.length}):`;
  const lines = [heading, ''];

  for (const event of events) {
    const fileDiagnostic = extractGroupedCompilerError(event, options);
    if (fileDiagnostic) {
      lines.push(`  \u2717 ${fileDiagnostic.message}`);
      if (fileDiagnostic.location) {
        lines.push(`    ${fileDiagnostic.location}`);
      }
    } else {
      const messageLines = event.message.split('\n');
      lines.push(`  \u2717 ${messageLines[0]}`);
      for (let i = 1; i < messageLines.length; i++) {
        lines.push(`    ${messageLines[i]}`);
      }
    }
    lines.push('');
  }

  while (lines.length > 0 && lines.at(-1) === '') {
    lines.pop();
  }

  return lines.join('\n');
}

const BUILD_STAGE_LABEL: Record<Exclude<BuildStageRenderItem['stage'], 'COMPLETED'>, string> = {
  RESOLVING_PACKAGES: 'Resolving packages',
  COMPILING: 'Compiling',
  LINKING: 'Linking',
  PREPARING_TESTS: 'Preparing tests',
  RUN_TESTS: 'Running tests',
  ARCHIVING: 'Archiving',
};

export function formatBuildStageEvent(event: BuildStageRenderItem): string {
  if (event.stage === 'COMPLETED') {
    return event.message;
  }
  return `\u203A ${BUILD_STAGE_LABEL[event.stage]}`;
}

export function formatTransientBuildStageEvent(event: BuildStageRenderItem): string {
  if (event.stage === 'COMPLETED') {
    return event.message;
  }
  return `${BUILD_STAGE_LABEL[event.stage]}...`;
}

export function formatHumanCompilerWarningEvent(
  event: CompilerWarningRenderItem,
  options?: DiagnosticFormattingOptions,
): string {
  const diagnostic = parseHumanDiagnostic(event, 'warning', options);
  const lines = [`  \u{26A0} ${event.message}`];
  if (diagnostic.location) {
    lines.push(`    ${diagnostic.location}`);
  }
  return lines.join('\n');
}

export function formatGroupedWarnings(
  events: CompilerWarningRenderItem[],
  options?: DiagnosticFormattingOptions,
): string {
  const heading = `Warnings (${events.length}):`;
  const lines = [heading, ''];

  for (const event of events) {
    lines.push(formatHumanCompilerWarningEvent(event, options));
    lines.push('');
  }

  while (lines.at(-1) === '') {
    lines.pop();
  }

  return lines.join('\n');
}

export function formatHumanCompilerErrorEvent(
  event: CompilerErrorRenderItem,
  options?: DiagnosticFormattingOptions,
): string {
  const diagnostic = parseHumanDiagnostic(event, 'error', options);
  return diagnostic.location
    ? [diagnostic.message, `  ${diagnostic.location}`].join('\n')
    : diagnostic.message;
}

export function formatTransientStatusLineEvent(event: StatusRenderItem): string | null {
  if (event.level === 'info') {
    return `${event.message}...`;
  }
  return null;
}

export function formatTestFailureEvent(
  event: TestFailureRenderItem,
  options?: DiagnosticFormattingOptions,
): string {
  const parts: string[] = [];
  if (event.suite) {
    parts.push(event.suite);
  }
  if (event.test) {
    parts.push(event.test);
  }
  const testPath = parts.length > 0 ? `${parts.join('/')}: ` : '';
  const lines = [`  \u{2717} ${testPath}${event.message}`];
  if (event.location) {
    lines.push(`    ${formatLocationPath(event.location, options)}`);
  }
  return lines.join('\n');
}

function formatLocationPath(location: string, options?: DiagnosticFormattingOptions): string {
  const locParts = location.match(/^(.+?)(:(?:\d+)(?::\d+)?)$/);
  if (locParts) {
    return `${formatDiagnosticFilePath(locParts[1], options)}${locParts[2]}`;
  }
  return location;
}

function pluralize(count: number, singular: string, plural: string): string {
  return count === 1 ? `${count} ${singular}` : `${count} ${plural}`;
}

export function formatSummaryEvent(event: SummaryTextBlock): string {
  const succeeded = event.status === 'SUCCEEDED';
  const statusEmoji = succeeded ? '\u{2705}' : '\u{274C}';
  const durationPart =
    event.durationMs !== undefined
      ? ` (\u{23F1}\u{FE0F} ${(event.durationMs / 1000).toFixed(1)}s)`
      : '';

  const hasTestCounts = event.totalTests !== undefined && event.totalTests > 0;

  if (hasTestCounts) {
    const passed = event.passedTests ?? 0;
    const failed = event.failedTests ?? 0;
    const skipped = event.skippedTests ?? 0;

    if (succeeded) {
      return `${statusEmoji} ${pluralize(passed, 'test', 'tests')} passed, ${failed} failed, ${skipped} skipped${durationPart}`;
    }

    return `${statusEmoji} ${pluralize(failed, 'test', 'tests')} failed, ${passed} passed, ${skipped} skipped${durationPart}`;
  }

  const op = event.operation
    ? event.operation.charAt(0) + event.operation.slice(1).toLowerCase()
    : 'Operation';
  const statusWord = succeeded ? 'succeeded' : 'failed';

  return `${statusEmoji} ${op} ${statusWord}.${durationPart}`;
}

const TEST_DISCOVERY_PREVIEW_LIMIT = 6;

export function formatTestDiscoveryEvent(event: TestDiscoveryRenderItem): string {
  const visibleTests = event.tests.slice(0, TEST_DISCOVERY_PREVIEW_LIMIT);
  const lines = [`Discovered ${event.total} test(s):`];

  for (const test of visibleTests) {
    lines.push(`   ${test}`);
  }

  const hasMore =
    event.truncated ||
    event.tests.length > visibleTests.length ||
    event.total > visibleTests.length;

  if (hasMore) {
    const remainingCount = Math.max(event.total - visibleTests.length, 0);
    lines.push(`   (...and ${remainingCount} more)`);
  }

  return lines.join('\n');
}

export function formatTestProgressEvent(event: TestProgressRenderItem): string {
  const failWord = event.failed === 1 ? 'failure' : 'failures';
  return `Running tests (${event.completed} completed, ${event.failed} ${failWord}, ${event.skipped} skipped)`;
}

export function formatNextStepsEvent(event: NextStepsTextBlock, runtime: 'cli' | 'mcp'): string {
  return renderNextStepsSection(event.steps, runtime);
}

export function formatTestCaseResults(items: readonly TestCaseResultRenderItem[]): string {
  if (items.length === 0) {
    return '';
  }

  const statusIcon: Record<TestCaseResultRenderItem['status'], string> = {
    passed: '\u{2705}',
    failed: '\u{274C}',
    skipped: '\u{23ED}\u{FE0F}',
  };

  const lines: string[] = ['Test Results:'];
  for (const item of items) {
    const icon = statusIcon[item.status];
    const duration =
      item.durationMs !== undefined ? ` (${(item.durationMs / 1000).toFixed(3)}s)` : '';
    const name = item.suite ? `${item.suite}/${item.test}` : item.test;
    lines.push(`  ${icon} ${name}${duration}`);
  }
  return lines.join('\n');
}

export function formatGroupedTestFailures(
  events: TestFailureRenderItem[],
  options?: DiagnosticFormattingOptions,
): string {
  if (events.length === 0) return '';

  const allUnnamedSuites = events.every((e) => e.suite === undefined);

  const groupedSuites = new Map<string, Map<string, TestFailureRenderItem[]>>();
  for (const event of events) {
    const suiteKey = event.suite ?? '(Unknown Suite)';
    const testKey = event.test ?? '(unknown test)';
    const suiteGroup = groupedSuites.get(suiteKey) ?? new Map<string, TestFailureRenderItem[]>();
    const testGroup = suiteGroup.get(testKey) ?? [];
    testGroup.push(event);
    suiteGroup.set(testKey, testGroup);
    groupedSuites.set(suiteKey, suiteGroup);
  }

  const lines: string[] = [];

  if (allUnnamedSuites) {
    lines.push(`Test Failures (${events.length}):`);
    lines.push('');
    for (const [suite, tests] of groupedSuites.entries()) {
      lines.push(`  ${suite}`);
      for (const [testName, failures] of tests.entries()) {
        lines.push(`    \u{2717} ${testName}`);
        for (const failure of failures) {
          lines.push(`      ${failure.message}`);
          if (failure.location) {
            lines.push(`        ${formatLocationPath(failure.location, options)}`);
          }
        }
      }
    }
    return lines.join('\n');
  }

  for (const [suite, tests] of groupedSuites.entries()) {
    if (lines.length > 0) lines.push('');
    lines.push(suite);
    for (const [testName, failures] of tests.entries()) {
      lines.push(`  ✗ ${testName}:`);
      for (const failure of failures) {
        const msgIndent = failure.location ? '      ' : '    ';
        lines.push(`${msgIndent}- ${failure.message}`);
        if (failure.location) {
          lines.push(`        ${formatLocationPath(failure.location, options)}`);
        }
      }
    }
  }

  return lines.join('\n');
}
