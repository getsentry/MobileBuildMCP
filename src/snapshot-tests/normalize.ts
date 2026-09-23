/* eslint-disable no-control-regex, no-regex-spaces */
import os from 'node:os';
import path from 'node:path';

const ANSI_REGEX = /\x1B\[[0-9;]*[mK]/g;
const ISO_TIMESTAMP_REGEX = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z/g;
const LOG_FILENAME_TIMESTAMP_REGEX = /\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z/g;
const APPLE_DEVICE_UDID_REGEX = /[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}/g;
const UUID_REGEX = /[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/g;
const DURATION_REGEX = /\d+\.\d+s\b/g;
const PID_NUMBER_REGEX = /(pid:\s*)\d+/gi;
const PID_NAME_REGEX = /\bPID \d+\b/g;
const KILL_PID_REGEX = /(\bkill:\s*)\d+(?=:)/g;
const PID_FILENAME_SUFFIX_REGEX = /_pid\d+(?:_[0-9a-f]{8})?\.log/g;
const XCRESULT_FILENAME_PID_SUFFIX_REGEX = /_pid\d+_[0-9a-f]{8}\.xcresult/g;
const XCTESTPRODUCTS_FILENAME_PID_SUFFIX_REGEX = /_pid\d+_[0-9a-f]{8}\.xctestproducts/g;
const HELPER_PID_FILENAME_SUFFIX_REGEX =
  /_(?:helperpid\d+_ownerpid\d+|ownerpid\d+)_[0-9a-f]{8}\.log/g;
const PID_JSON_REGEX = /"pid"\s*:\s*\d+/g;
const PROCESS_ID_REGEX = /Process ID: \d+/g;
const PROCESS_INLINE_PID_REGEX = /process \d+/g;
const CLI_PROCESS_ID_ARG_REGEX = /--process-id (["']?)\d+\1/g;
const MCP_PROCESS_ID_ARG_REGEX = /(processId:\s*)\d+/g;
const THREAD_ID_REGEX = /Thread \d{5,}/g;
const HEX_ADDRESS_REGEX = /0x[0-9a-fA-F]{8,}/g;
const SIMULATOR_APP_DEBUG_DYLIB_REGEX =
  /<HOME>\/Library\/Developer\/CoreSimulator\/Devices\/<UUID>\/data\/(?:Containers\/Bundle\/Application\/<UUID>|Library\/Caches\/com\.apple\.containermanagerd\/Dead\/temp\.[^/\s]+\/<UUID>)\/([^/\s]+\.app\/[^/`\s]+\.debug\.dylib)/g;

const LLDB_FRAME_OFFSET_REGEX = /(`[^`\n]+):(\d+)$/gm;
const LLDB_BREAKPOINT_BYTE_OFFSET_REGEX = /\+ \d+ at /g;
const LLDB_SYS_FRAME_FUNC_REGEX =
  /(frame #\d+: )\S+( at (?:\/usr\/lib\/|\/Library\/Developer\/CoreSimulator\/)[^`\n]*`)[^:\n]+(:<OFFSET>)/gm;
const LLDB_FRAME_NUMBER_REGEX = /  frame #\d+:/g;
const LLDB_BREAKPOINT_LOCATIONS_REGEX = /locations = .+$/gm;
const CORE_SIMULATOR_RUNTIME_ROOT_REGEX =
  /\/Library\/Developer\/CoreSimulator\/Volumes\/[^/\s]+\/Library\/Developer\/CoreSimulator\/Profiles\/Runtimes\/[^/\n]+?\.simruntime\/Contents\/Resources\/RuntimeRoot/g;
const DERIVED_DATA_HASH_REGEX = /(DerivedData\/[^/\s]+)-(?:[a-z]{28}|[0-9a-f]{12})(?=\/|\b)/g;
const LOCAL_TIMESTAMP_REGEX = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}/g;
const XCTEST_PARENS_DURATION_REGEX = /\(\d+\.\d+\) seconds/g;
const SWIFT_TESTING_DURATION_REGEX = /after \d+\.\d+ seconds/g;
const TEST_SUMMARY_COUNTS_REGEX =
  /\(Total: \d+(?:, Passed: \d+)?(?:, Failed: \d+)?(?:, Skipped: \d+)?, /g;
const COVERAGE_CALL_COUNT_REGEX = /called \d+x\)/g;
const DEVICE_LABEL_REGEX = /Device: (?:.+ \(<UUID>\)|<UUID>)/g;
const UPTIME_REGEX = /Uptime: \d+s/g;
const RESULT_BUNDLE_LINE_REGEX = /\S+\[\d+:\d+\] Writing error result bundle to \S+/g;
const DEVICE_TRANSPORT_TYPE_REGEX = /\b(wired|localNetwork)\b/g;
const COREDEVICE_PROVISIONING_PREAMBLE_REGEX =
  /^(\s*✗ )Failed to load provisioning paramter list due to error: Error Domain=com\.apple\.dt\.CoreDeviceError Code=1002 "No provider was found\." UserInfo=\{NSLocalizedDescription=No provider was found\.\}\.\n\s+`devicectl manage create` may support a reduced set of arguments\.\n\s+ERROR: /gm;
const COREDEVICE_NOT_FOUND_ERROR_PREFIX_REGEX =
  /(^\s*✗ )ERROR: (?=The specified device was not found\.)/gm;
const TARGET_DEVICE_IDENTIFIER_REGEX = /(TARGET_DEVICE_IDENTIFIER = )([0-9A-Fa-f]{24,40})/g;
const TARGET_DEVICE_MODEL_REGEX =
  /((?:TARGET_DEVICE_MODEL|ASSETCATALOG_FILTER_FOR_DEVICE_MODEL) = ).+$/gm;
const TARGET_DEVICE_OS_VERSION_REGEX =
  /((?:TARGET_DEVICE_OS_VERSION|ASSETCATALOG_FILTER_FOR_DEVICE_OS_VERSION) = ).+$/gm;
const DEVICE_OS_VERSION_LINE_REGEX = /(\bOS: )\d+(?:\.\d+)*(?:\s*\([^)]*\))?/g;
const XCODE_APPLICATION_PATH_REGEX = /\/Applications\/Xcode(?:[^/\s]+)?\.app/g;
const APPLE_SDK_BUNDLE_REGEX =
  /\b(?:iPhoneOS|iPhoneSimulator|AppleTVOS|AppleTVSimulator|WatchOS|WatchSimulator|XROS|XRSimulator|MacOSX)\d+(?:\.\d+)*\.sdk/g;
const XCODE_CACHE_ROOT_REGEX = /((?:CACHE_ROOT|CCHROOT) = ).+$/gm;
const BUILD_SETTINGS_GROUP_REGEX = /^(\s*(?:ALTERNATE_GROUP|GROUP|INSTALL_GROUP) = ).+$/gm;
const BUILD_SETTINGS_GID_REGEX = /^(\s*GID = )\d+$/gm;
const SDK_PATH_REGEX =
  /^(\s*(?:CORRESPONDING_SIMULATOR_SDK_DIR|SDKROOT|SDK_DIR(?:_[A-Za-z0-9_]+)?) = ).+$/gm;
const SDK_DIR_PLACEHOLDER_KEY_REGEX = /^(\s*)SDK_DIR_[A-Za-z0-9_]+ = <SDK_PATH>$/gm;
const SDK_NAME_REGEX = /^(\s*(?:CORRESPONDING_SIMULATOR_SDK_NAME|SDK_NAMES?) = ).+$/gm;
const SDK_BUILD_VERSION_REGEX =
  /^(\s*(?:PLATFORM_PRODUCT_BUILD_VERSION|SDK_PRODUCT_BUILD_VERSION|MAC_OS_X_PRODUCT_BUILD_VERSION|XCODE_PRODUCT_BUILD_VERSION) = ).+$/gm;
const SDK_STAT_CACHE_PATH_REGEX = /^(\s*SDK_STAT_CACHE_PATH = ).+$/gm;
const SDK_VERSION_REGEX =
  /^(\s*(?:SDK_VERSION|SDK_VERSION_ACTUAL|SDK_VERSION_MAJOR|SDK_VERSION_MINOR|MAC_OS_X_VERSION_ACTUAL|MAC_OS_X_VERSION_MAJOR|MAC_OS_X_VERSION_MINOR|XCODE_VERSION_ACTUAL|XCODE_VERSION_MAJOR|XCODE_VERSION_MINOR) = ).+$/gm;
const CODEX_ARG0_PATH_REGEX = /<HOME>\/\.codex\/tmp\/arg0\/codex-arg0[A-Za-z0-9]+/g;
const CODEX_WORKTREE_NODE_MODULES_REGEX =
  /<HOME>\/\.codex\/worktrees\/[^/:]+\/node_modules\/\.bin/g;
const MOBILEBUILDMCP_HOME_PREFIX_REGEX = /<HOME>(?=\/Library\/Developer\/MobileBuildMCP(?:\/|$))/g;
const MOBILEBUILDMCP_WORKSPACE_KEY_REGEX =
  /(~\/Library\/Developer\/MobileBuildMCP\/workspaces\/)[^/\n]+-[0-9a-f]{12}(?=\/|$)/g;
const XCODE_IDE_ARTIFACT_OWNER_PID_REGEX = /(\/state\/xcode-ide\/call-tool\/ownerpid)\d+_/g;
const XCODE_IDE_ARTIFACT_HASH_REGEX =
  /(\/state\/xcode-ide\/call-tool\/[^/\n]+\/[^/\n]+-)[0-9a-f]{8}(?=\.json)/g;
const ACQUIRED_USAGE_ASSERTION_TIME_REGEX =
  /(^\s*)\d{2}:\d{2}:\d{2}( {2}Acquired usage assertion\.)$/gm;
const UI_SNAPSHOT_TIME_TEXT_ROW_REGEX = /\b((?:e\d+|<REF>)\|text\|text\|)\d{1,2}:\d{2}(\|\|)/g;
const UI_COMPACT_ROW_ELEMENT_REF_REGEX =
  /\be\d+(?=\|(?:tap|typeText|longPress|touch|swipe|text)\|)/g;
const UI_CLI_ELEMENT_REF_ARG_REGEX = /(--(?:within-)?element-ref\s+)(["']?)e\d+\2/g;
const UI_OBJECT_ELEMENT_REF_REGEX = /((?:elementRef|withinElementRef|ref)\s*:\s*["'])e\d+(["'])/g;
const UI_JSON_ELEMENT_REF_REGEX = /("(?:elementRef|withinElementRef|ref)"\s*:\s*")e\d+(")/g;
const UI_PROSE_ELEMENT_REF_REGEX = /(\b(?:within\s+)?elementRef\s+)e\d+\b/g;
const UI_QUOTED_ELEMENT_REF_REGEX = /(\bElement ref\s+['"])e\d+(['"])/g;
const UI_ELEMENT_LINE_REF_REGEX = /(^\s*Element:\s*)e\d+\b/gm;
const UI_SNAPSHOT_SUMMARY_COUNTS_REGEX =
  /((?:Runtime UI snapshot captured|Wait completed; runtime UI snapshot refreshed) with )\d+( elements, )\d+( likely targets, and )\d+( scroll areas\.)/g;
const SWIFT_PACKAGE_TARGET_TRIPLE_REGEX = /(\.build\/)[^/\s]+-apple-macosx[^/\s]*(?=\/)/g;
const UI_SWIPE_NEXT_STEP_REGEX =
  /Next steps:\n1\. (?:Scroll visible content: [^\n]+|Take screenshot for verification: [^\n]+)/g;
const DEPLOYMENT_TARGET_SUGGESTED_VALUES_REGEX = /^(\s*DEPLOYMENT_TARGET_SUGGESTED_VALUES = ).+$/gm;
const PLATFORM_DEPLOYMENT_TARGET_REGEX =
  /^(\s*(?:DRIVERKIT_DEPLOYMENT_TARGET|MACOSX_DEPLOYMENT_TARGET|TVOS_DEPLOYMENT_TARGET|WATCHOS_DEPLOYMENT_TARGET|XROS_DEPLOYMENT_TARGET) = ).+$/gm;
const IOS_RUNTIME_HEADING_REGEX = /\biOS \d+(?:\.\d+)*(?=:)/g;
const SWIFT_VERSION_TEMP_FILE_REGEX = /swift-version--?[0-9A-Fa-f]+\.txt/g;
const BUILD_SETTINGS_PATH_REGEX = /^( {6}PATH = ).+$/gm;
const TRAILING_WHITESPACE_REGEX = /[ \t]+$/gm;
const SIMULATOR_FAILURE_TEST_PROGRESS_BLOCK_REGEX =
  /(?:^Running tests \(\d+ completed, \d+ failures?, \d+ skipped\)\n){30,}/gm;
const TEST_PROGRESS_LINE_REGEX =
  /^Running tests \((\d+) completed, (\d+) failures?, (\d+) skipped\)$/u;

type TestProgress = { completed: number; failed: number; skipped: number };

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseTestProgressLine(line: string): TestProgress | null {
  const match = line.match(TEST_PROGRESS_LINE_REGEX);
  if (!match) {
    return null;
  }

  return {
    completed: Number(match[1]),
    failed: Number(match[2]),
    skipped: Number(match[3]),
  };
}

function isMonotonicProgress(progress: TestProgress[]): boolean {
  return progress.every((current, index) => {
    const previous = progress[index - 1];
    return (
      previous === undefined ||
      (current.completed >= previous.completed &&
        current.failed >= previous.failed &&
        current.skipped >= previous.skipped)
    );
  });
}

function normalizeDoctorProcessTree(text: string): string {
  return text.replace(
    /(^|\n)(Process Tree\n)(?:   <PID> \(ppid <PID>\): <PROCESS>\n)+/g,
    '$1$2   <PID> (ppid <PID>): <PROCESS>\n   <PID> (ppid <PID>): <PROCESS>\n   <PID> (ppid <PID>): <PROCESS>\n',
  );
}

function trimVolatileDebugStackPrefix(text: string): string {
  const lines = text.split('\n');
  const framesIndex = lines.findIndex((line) => line.trim() === 'Frames:');
  if (framesIndex === -1) {
    return text;
  }

  const threadIndex = lines.findIndex(
    (line, index) => index > framesIndex && line.trim().startsWith('Thread <THREAD_ID>'),
  );
  if (threadIndex === -1) {
    return text;
  }

  const firstAppFrameIndex = lines.findIndex(
    (line, index) => index > threadIndex && line.includes('<SIM_APP_BUNDLE>/'),
  );
  if (firstAppFrameIndex === -1) {
    return text;
  }

  const stableLaunchBoundaryIndex = lines.findIndex(
    (line, index) =>
      index > threadIndex &&
      index < firstAppFrameIndex &&
      line.includes('GraphicsServices.framework/GraphicsServices'),
  );
  if (stableLaunchBoundaryIndex <= threadIndex + 1) {
    return text;
  }

  lines.splice(threadIndex + 1, stableLaunchBoundaryIndex - threadIndex - 1);
  return lines.join('\n');
}

function normalizeSimulatorFailureTestProgressBlock(match: string): string {
  const progress = match.trimEnd().split('\n').map(parseTestProgressLine);
  const parsedProgress = progress.filter((line): line is TestProgress => line !== null);
  if (parsedProgress.length !== progress.length) {
    return match;
  }
  const first = parsedProgress[0];
  const final = parsedProgress.at(-1);
  if (!first || !final) {
    return match;
  }

  const hasCleanStart = first.completed <= 1 && first.failed === 0 && first.skipped === 0;
  if (!hasCleanStart || final.failed === 0 || !isMonotonicProgress(parsedProgress)) {
    return match;
  }

  return `Running tests (<TEST_PROGRESS>; final: ${final.completed} completed, ${final.failed} failed, ${final.skipped} skipped)\n`;
}

function normalizeMcpTestFailureOrder(text: string): string {
  return text.replace(
    /(Test Failures \(\d+\):\n\n)([\s\S]*?)(?=\n❌)/g,
    (_match: string, heading: string, body: string) => {
      const failures = body
        .split(/\n{2,}/u)
        .map((failure) => failure.trimEnd())
        .filter((failure) => failure.length > 0);
      return `${heading}${failures.sort(compareCodePoints).join('\n\n')}\n`;
    },
  );
}

function compareCodePoints(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

export type NormalizeSnapshotOutputOptions = {
  tmpDir?: string;
};

export function normalizeSnapshotOutput(
  text: string,
  options: NormalizeSnapshotOutputOptions = {},
): string {
  let normalized = text;

  normalized = normalized.replace(ANSI_REGEX, '');

  const projectRoot = path.resolve(process.cwd());
  const projectRootAliases = new Set([projectRoot]);
  if (projectRoot.startsWith('/private/tmp/')) {
    projectRootAliases.add(projectRoot.slice('/private'.length));
  } else if (projectRoot.startsWith('/tmp/')) {
    projectRootAliases.add(`/private${projectRoot}`);
  }
  for (const projectRootAlias of projectRootAliases) {
    normalized = normalized.replace(new RegExp(escapeRegex(projectRootAlias), 'g'), '<ROOT>');
  }

  const home = os.homedir();
  normalized = normalized.replace(new RegExp(escapeRegex(home), 'g'), '<HOME>');

  const username = os.userInfo().username;
  normalized = normalized.replace(
    new RegExp(
      `((?:ALTERNATE_OWNER|INSTALL_OWNER|USER|VERSION_INFO_BUILDER)\\s*=\\s*)${escapeRegex(username)}`,
      'g',
    ),
    '$1<USER>',
  );
  normalized = normalized.replace(new RegExp(`(UID\\s*=\\s*)${os.userInfo().uid}`, 'g'), '$1<UID>');

  const tmpDir = options.tmpDir ?? os.tmpdir();
  const tmpDirAliases = new Set([tmpDir]);
  if (tmpDir.startsWith('/private/')) {
    tmpDirAliases.add(tmpDir.slice('/private'.length));
  } else if (tmpDir.startsWith('/tmp/') || tmpDir.startsWith('/var/')) {
    tmpDirAliases.add(`/private${tmpDir}`);
  }
  for (const tmpDirAlias of [...tmpDirAliases].sort((left, right) => right.length - left.length)) {
    normalized = normalized.replace(
      new RegExp(escapeRegex(tmpDirAlias) + '/[A-Za-z0-9._-]+(?=/|[^A-Za-z0-9._/-]|$)', 'g'),
      '<TMPDIR>',
    );
  }
  normalized = normalized.replace(MOBILEBUILDMCP_HOME_PREFIX_REGEX, '~');
  normalized = normalized.replace(MOBILEBUILDMCP_WORKSPACE_KEY_REGEX, '$1MobileBuildMCP-<HASH>');
  normalized = normalized.replace(XCODE_IDE_ARTIFACT_OWNER_PID_REGEX, '$1<PID>_');
  normalized = normalized.replace(XCODE_IDE_ARTIFACT_HASH_REGEX, '$1<HASH>');
  normalized = normalized.replace(
    /(Build Logs: )(?:<TMPDIR>|~\/Library\/Developer\/MobileBuildMCP)\/logs\//g,
    '$1~/Library/Developer/MobileBuildMCP/logs/',
  );
  normalized = normalized.replace(
    /Raw Response JSON: .+\/xcode-ide\/call-tool\/.+\/[A-Za-z0-9._-]+\.json/g,
    'Raw Response JSON: <RAW_RESPONSE_JSON_PATH>',
  );
  normalized = normalized.replace(
    /Found \d+ tool\(s\)(?=\. Raw response saved to artifact\.|$)/g,
    'Found <XCODE_IDE_TOOL_COUNT> tool(s)',
  );

  normalized = normalized.replace(DERIVED_DATA_HASH_REGEX, '$1-<HASH>');
  normalized = normalized.replace(ISO_TIMESTAMP_REGEX, '<TIMESTAMP>');
  normalized = normalized.replace(LOG_FILENAME_TIMESTAMP_REGEX, '<TIMESTAMP>');
  normalized = normalized.replace(APPLE_DEVICE_UDID_REGEX, '<UUID>');
  normalized = normalized.replace(UUID_REGEX, '<UUID>');
  normalized = normalized.replace(DEVICE_LABEL_REGEX, 'Device: <DEVICE> (<UUID>)');
  normalized = normalized.replace(DEVICE_TRANSPORT_TYPE_REGEX, '<CONNECTION>');
  normalized = normalized.replace(COREDEVICE_PROVISIONING_PREAMBLE_REGEX, '$1');
  normalized = normalized.replace(COREDEVICE_NOT_FOUND_ERROR_PREFIX_REGEX, '$1');
  normalized = normalized.replace(DURATION_REGEX, '<DURATION>');
  normalized = normalized.replace(PID_NUMBER_REGEX, '$1<PID>');
  normalized = normalized.replace(PID_NAME_REGEX, 'PID <PID>');
  normalized = normalized.replace(KILL_PID_REGEX, '$1<PID>');
  normalized = normalized.replace(HELPER_PID_FILENAME_SUFFIX_REGEX, '_pid<PID>.log');
  normalized = normalized.replace(PID_FILENAME_SUFFIX_REGEX, '_pid<PID>.log');
  normalized = normalized.replace(XCRESULT_FILENAME_PID_SUFFIX_REGEX, '_pid<PID>.xcresult');
  normalized = normalized.replace(
    XCTESTPRODUCTS_FILENAME_PID_SUFFIX_REGEX,
    '_pid<PID>.xctestproducts',
  );
  normalized = normalized.replace(PID_JSON_REGEX, '"pid" : <PID>');
  normalized = normalized.replace(PROCESS_ID_REGEX, 'Process ID: <PID>');
  normalized = normalized.replace(PROCESS_INLINE_PID_REGEX, 'process <PID>');
  normalized = normalized.replace(
    CLI_PROCESS_ID_ARG_REGEX,
    (_match: string, quote: string) => `--process-id ${quote}<PID>${quote}`,
  );
  normalized = normalized.replace(MCP_PROCESS_ID_ARG_REGEX, '$1<PID>');
  normalized = normalized.replace(UPTIME_REGEX, 'Uptime: <UPTIME>');

  // Normalize simulator/device state markers and boot state text
  normalized = normalized.replace(/\[✓\]/g, '[<STATUS>]');
  normalized = normalized.replace(/\[✗\]/g, '[<STATUS>]');
  normalized = normalized.replace(/\(Booted\)/g, '(<SIM_STATE>)');
  normalized = normalized.replace(/\(Shutdown\)/g, '(<SIM_STATE>)');

  normalized = normalized.replace(THREAD_ID_REGEX, 'Thread <THREAD_ID>');
  normalized = normalized.replace(HEX_ADDRESS_REGEX, '<ADDR>');
  normalized = normalized.replace(SIMULATOR_APP_DEBUG_DYLIB_REGEX, '<SIM_APP_BUNDLE>/$1');
  normalized = normalized.replace(LLDB_FRAME_OFFSET_REGEX, '$1:<OFFSET>');
  normalized = normalized.replace(LLDB_BREAKPOINT_BYTE_OFFSET_REGEX, '+ <OFFSET> at ');
  normalized = normalized.replace(LLDB_SYS_FRAME_FUNC_REGEX, '$1<FUNC>$2<FUNC>$3');
  normalized = normalized.replace(LLDB_FRAME_NUMBER_REGEX, '  frame #<N>:');
  normalized = normalized.replace(LLDB_BREAKPOINT_LOCATIONS_REGEX, 'locations = <LOCATIONS>');
  normalized = normalized.replace(CORE_SIMULATOR_RUNTIME_ROOT_REGEX, '<SIM_RUNTIME_ROOT>');
  normalized = trimVolatileDebugStackPrefix(normalized);
  normalized = normalized.replace(RESULT_BUNDLE_LINE_REGEX, '<RESULT_BUNDLE_ERROR>');

  normalized = normalized.replace(LOCAL_TIMESTAMP_REGEX, '<TIMESTAMP>');
  normalized = normalized.replace(XCTEST_PARENS_DURATION_REGEX, '(<DURATION>) seconds');
  normalized = normalized.replace(SWIFT_TESTING_DURATION_REGEX, 'after <DURATION> seconds');
  normalized = normalized.replace(TEST_SUMMARY_COUNTS_REGEX, '(<TEST_COUNTS>, ');

  normalized = normalized.replace(TARGET_DEVICE_IDENTIFIER_REGEX, '$1<UUID>');
  normalized = normalized.replace(TARGET_DEVICE_MODEL_REGEX, '$1<DEVICE_MODEL>');
  normalized = normalized.replace(TARGET_DEVICE_OS_VERSION_REGEX, '$1<OS_VERSION>');
  normalized = normalized.replace(DEVICE_OS_VERSION_LINE_REGEX, '$1<OS_VERSION>');
  normalized = normalized.replace(
    XCODE_APPLICATION_PATH_REGEX,
    '/Applications/Xcode-<VERSION>.app',
  );
  normalized = normalized.replace(APPLE_SDK_BUNDLE_REGEX, '<SDK_NAME>.sdk');
  normalized = normalized.replace(XCODE_CACHE_ROOT_REGEX, '$1<XCODE_CACHE_ROOT>');
  normalized = normalized.replace(BUILD_SETTINGS_GROUP_REGEX, '$1<GROUP>');
  normalized = normalized.replace(BUILD_SETTINGS_GID_REGEX, '$1<GID>');
  normalized = normalized.replace(SDK_PATH_REGEX, '$1<SDK_PATH>');
  normalized = normalized.replace(
    SDK_DIR_PLACEHOLDER_KEY_REGEX,
    '$1SDK_DIR_<SDK_NAME> = <SDK_PATH>',
  );
  normalized = normalized.replace(SDK_NAME_REGEX, '$1<SDK_NAME>');
  normalized = normalized.replace(SDK_BUILD_VERSION_REGEX, '$1<SDK_BUILD_VERSION>');
  normalized = normalized.replace(SDK_STAT_CACHE_PATH_REGEX, '$1<SDK_STAT_CACHE_PATH>');
  normalized = normalized.replace(SDK_VERSION_REGEX, '$1<SDK_VERSION>');
  normalized = normalized.replace(
    DEPLOYMENT_TARGET_SUGGESTED_VALUES_REGEX,
    '$1<DEPLOYMENT_TARGETS>',
  );
  normalized = normalized.replace(PLATFORM_DEPLOYMENT_TARGET_REGEX, '$1<DEPLOYMENT_TARGET>');
  normalized = normalized.replace(IOS_RUNTIME_HEADING_REGEX, 'iOS <VERSION>');
  normalized = normalized.replace(SWIFT_VERSION_TEMP_FILE_REGEX, 'swift-version--<HASH>.txt');
  normalized = normalized.replace(BUILD_SETTINGS_PATH_REGEX, '$1<PATH>');
  normalized = normalized.replace(CODEX_ARG0_PATH_REGEX, '<HOME>/.codex/tmp/arg0/codex-arg0<ARG0>');
  normalized = normalized.replace(ACQUIRED_USAGE_ASSERTION_TIME_REGEX, '$1<TIME>$2');
  normalized = normalized.replace(UI_SNAPSHOT_TIME_TEXT_ROW_REGEX, '$1<TIME>$2');
  normalized = normalized.replace(UI_COMPACT_ROW_ELEMENT_REF_REGEX, '<REF>');
  normalized = normalized.replace(
    UI_CLI_ELEMENT_REF_ARG_REGEX,
    (_match: string, prefix: string, quote: string) => `${prefix}${quote}<REF>${quote}`,
  );
  normalized = normalized.replace(UI_JSON_ELEMENT_REF_REGEX, '$1<REF>$2');
  normalized = normalized.replace(UI_OBJECT_ELEMENT_REF_REGEX, '$1<REF>$2');
  normalized = normalized.replace(UI_PROSE_ELEMENT_REF_REGEX, '$1<REF>');
  normalized = normalized.replace(UI_QUOTED_ELEMENT_REF_REGEX, '$1<REF>$2');
  normalized = normalized.replace(UI_ELEMENT_LINE_REF_REGEX, '$1<REF>');
  normalized = normalized.replace(
    UI_SNAPSHOT_SUMMARY_COUNTS_REGEX,
    '$1<ELEMENT_COUNT>$2<LIKELY_TARGET_COUNT>$3<SCROLL_AREA_COUNT>$4',
  );
  normalized = normalized.replace(SWIFT_PACKAGE_TARGET_TRIPLE_REGEX, '$1<TARGET_TRIPLE>');
  normalized = normalized.replace(
    UI_SWIPE_NEXT_STEP_REGEX,
    'Next steps:\n1. <POST_SWIPE_NEXT_STEP>',
  );
  normalized = normalized.replace(
    CODEX_WORKTREE_NODE_MODULES_REGEX,
    '<HOME>/.codex/worktrees/<WORKTREE>/node_modules/.bin',
  );

  normalized = normalized.replace(COVERAGE_CALL_COUNT_REGEX, 'called <N>x)');

  normalized = normalized.replace(
    SIMULATOR_FAILURE_TEST_PROGRESS_BLOCK_REGEX,
    normalizeSimulatorFailureTestProgressBlock,
  );

  // Normalize final test summary line (counts vary across environments)
  normalized = normalized.replace(
    /\d+ (tests? failed), \d+ (passed)(?:, \d+ (skipped))?/g,
    '<FAIL_COUNT> $1, <PASS_COUNT> $2, <SKIP_COUNT> skipped',
  );

  normalized = normalized.replace(
    /("(?:x|y|width|height)"\s*:\s*)(\d+\.\d{2,})/g,
    (_match: string, prefix: string, num: string) => `${prefix}${parseFloat(num).toFixed(1)}`,
  );

  // Round floats embedded in AXFrame strings like `{{19.5, 357.5}, {82.666664123535156, 81}}`
  // to 1 decimal for rounding-stable comparison.
  normalized = normalized.replace(
    /("AXFrame"\s*:\s*")([^"]*)(")/g,
    (_match: string, prefix: string, value: string, suffix: string) =>
      `${prefix}${value.replace(/(\d+)\.(\d{2,})/g, (__, intPart: string, fracPart: string) => {
        const parsed = parseFloat(`${intPart}.${fracPart}`);
        return (Math.round(parsed * 10) / 10).toString();
      })}${suffix}`,
  );

  normalized = normalized.replace(
    /(?<=Workspace root: )(?:<ROOT>\/[^\n]+|(?!\/)[^\n]+)/g,
    '<PATH>',
  );
  normalized = normalized.replace(/(?<=Scan path: )(?:<ROOT>\/[^\n]+|(?!\/)[^\n]+)/g, '<PATH>');

  // Doctor-specific sanitization for volatile system information
  normalized = normalized.replace(/  version: v[\d.]+/g, '  version: <NODE_VERSION>');
  normalized = normalized.replace(/^(  release: )[\d.]+/gm, '$1<OS_RELEASE>');
  normalized = normalized.replace(/^(  cpus: ).+/gm, '$1<CPUS>');
  normalized = normalized.replace(/^(  memory: ).+/gm, '$1<MEMORY>');
  normalized = normalized.replace(/^(  tmpdir: )\/var\/folders\/[^\n]+/gm, '$1<TMPDIR>');
  normalized = normalized.replace(/^(  homedir: )[^\n]+/gm, '$1<HOME>');
  normalized = normalized.replace(/  Server Version: [\d.]+[^\n]*/g, '  Server Version: <VERSION>');
  normalized = normalized.replace(/  tmpdir: \/var\/folders\/[^\n]+/g, '  tmpdir: <TMPDIR>');
  normalized = normalized.replace(/  TMPDIR: \/var\/folders\/[^\n]+/g, '  TMPDIR: <TMPDIR>');
  normalized = normalized.replace(
    /  version: Xcode [\d.]+ - Build version \w+/g,
    '  version: <XCODE_VERSION>',
  );
  normalized = normalized.replace(/  path: \/Applications\/Xcode[^\n]+/g, '  path: <XCODE_PATH>');
  normalized = normalized.replace(
    /  selectedXcode: \/Applications\/Xcode[^\n]+/g,
    '  selectedXcode: <XCODE_PATH>',
  );
  normalized = normalized.replace(/  xcrunVersion: xcrun version .+/g, '  xcrunVersion: <VERSION>');
  normalized = normalized.replace(/  axe: .+/g, '  axe: <VERSION>');
  normalized = normalized.replace(/  mise: v?[\d.]+[^\n]*/g, '  mise: <VERSION>');
  normalized = normalized.replace(
    /  mcpbridge path: \/Applications\/Xcode[^\n]+/g,
    '  mcpbridge path: <XCODE_PATH>',
  );
  normalized = normalized.replace(/^( {2}Xcode running: ).+$/gm, '$1<XCODE_RUNNING>');
  normalized = normalized.replace(/  Total Unique Tools: \d+/g, '  Total Unique Tools: <COUNT>');
  normalized = normalized.replace(/  Workflow Count: \d+/g, '  Workflow Count: <COUNT>');
  normalized = normalized.replace(/  (\w[\w-]*): \d+ tools$/gm, '  $1: <N> tools');
  normalized = normalized.replace(/  cwd: [^\n]+/g, '  cwd: <CWD>');
  normalized = normalized.replace(
    /Simulator Video Capture Supported \(AXe >= [\d.]+\): (?:Yes|No)/g,
    'Simulator Video Capture Supported (AXe >= <VERSION>): <AVAILABLE>',
  );

  // PATH section body: every entry is an absolute system path that varies by
  // host/user. Replace the entire body with a single stable placeholder.
  normalized = normalized.replace(/(\nPATH\n)(?:  [^\n]+\n)+/g, '$1  <PATH_ENTRIES>\n');

  normalized = normalizeDoctorProcessTree(normalized);
  normalized = normalizeMcpTestFailureOrder(normalized);

  normalized = normalized.replace(TRAILING_WHITESPACE_REGEX, '');
  normalized = normalized.replace(/\n*$/, '\n');

  return normalized;
}
