import { describe, expect, it } from 'vitest';
import { normalizeSnapshotOutput } from '../normalize.ts';

function progressBlock(total: number, failed: number): string {
  return Array.from({ length: total + 1 }, (_, completed) => {
    const failures = completed === total ? failed : 0;
    const label = failures === 1 ? 'failure' : 'failures';
    return `Running tests (${completed} completed, ${failures} ${label}, 0 skipped)`;
  }).join('\n');
}

describe('normalizeSnapshotOutput', () => {
  it('normalizes volatile device and build-settings values', () => {
    expect(
      normalizeSnapshotOutput(
        [
          '1. Stop app: mobilebuildmcp device stop --device-id <UUID> --process-id 12345',
          'Device: iPhone, OS: 26.4.2 (a)',
          '      TARGET_DEVICE_MODEL = iPhone17,2',
          '      TARGET_DEVICE_OS_VERSION = 26.4.2',
          '      CACHE_ROOT = /var/folders/ab/cache/com.apple.DeveloperTools/26.4-17E192/Xcode',
          '      SDK_STAT_CACHE_PATH = <HOME>/Library/Developer/Xcode/DerivedData/SDKStatCaches.noindex/iphoneos26.4-23E237-c1e9.sdkstatcache',
          '      SDK_DIR_iphoneos26_4 = /Applications/Xcode-26.4.0.app/Contents/Developer/Platforms/iPhoneOS.platform/Developer/SDKs/iPhoneOS26.4.sdk',
          '      MAC_OS_X_PRODUCT_BUILD_VERSION = 25D2128',
          '      MAC_OS_X_VERSION_ACTUAL = 260301',
          '      XCODE_PRODUCT_BUILD_VERSION = 17F42',
          '      XCODE_VERSION_ACTUAL = 2650',
          '      DEPLOYMENT_TARGET_SUGGESTED_VALUES = 12.0 26.5',
          '      MACOSX_DEPLOYMENT_TARGET = 26.5',
          '      XROS_DEPLOYMENT_TARGET = 26.5',
          '      PLATFORM_DEVELOPER_APPLICATIONS_DIR = /Applications/Xcode-26.4.0.app/Contents/Developer/Applications',
          '      XCODE_APP_SUPPORT_DIR = /Applications/Xcode.app/Contents/Developer/Library/Xcode',
        ].join('\n') + '\n',
      ),
    ).toBe(
      [
        '1. Stop app: mobilebuildmcp device stop --device-id <UUID> --process-id <PID>',
        'Device: iPhone, OS: <OS_VERSION>',
        '      TARGET_DEVICE_MODEL = <DEVICE_MODEL>',
        '      TARGET_DEVICE_OS_VERSION = <OS_VERSION>',
        '      CACHE_ROOT = <XCODE_CACHE_ROOT>',
        '      SDK_STAT_CACHE_PATH = <SDK_STAT_CACHE_PATH>',
        '      SDK_DIR_<SDK_NAME> = <SDK_PATH>',
        '      MAC_OS_X_PRODUCT_BUILD_VERSION = <SDK_BUILD_VERSION>',
        '      MAC_OS_X_VERSION_ACTUAL = <SDK_VERSION>',
        '      XCODE_PRODUCT_BUILD_VERSION = <SDK_BUILD_VERSION>',
        '      XCODE_VERSION_ACTUAL = <SDK_VERSION>',
        '      DEPLOYMENT_TARGET_SUGGESTED_VALUES = <DEPLOYMENT_TARGETS>',
        '      MACOSX_DEPLOYMENT_TARGET = <DEPLOYMENT_TARGET>',
        '      XROS_DEPLOYMENT_TARGET = <DEPLOYMENT_TARGET>',
        '      PLATFORM_DEVELOPER_APPLICATIONS_DIR = /Applications/Xcode-<VERSION>.app/Contents/Developer/Applications',
        '      XCODE_APP_SUPPORT_DIR = /Applications/Xcode-<VERSION>.app/Contents/Developer/Library/Xcode',
      ].join('\n') + '\n',
    );
  });

  it('normalizes both cached and uncached device labels', () => {
    expect(normalizeSnapshotOutput('Device: iPhone 16 (<UUID>)\nDevice: <UUID>\n')).toBe(
      'Device: <DEVICE> (<UUID>)\nDevice: <DEVICE> (<UUID>)\n',
    );
  });

  it('normalizes volatile CoreDevice not-found preambles', () => {
    expect(
      normalizeSnapshotOutput(
        [
          '  ✗ Failed to load provisioning paramter list due to error: Error Domain=com.apple.dt.CoreDeviceError Code=1002 "No provider was found." UserInfo={NSLocalizedDescription=No provider was found.}.',
          '    `devicectl manage create` may support a reduced set of arguments.',
          '    ERROR: The specified device was not found. (Name: <UUID>) (com.apple.dt.CoreDeviceError error 1000 (0x3E8))',
          '           DeviceName = <UUID>',
        ].join('\n') + '\n',
      ),
    ).toBe(
      [
        '  ✗ The specified device was not found. (Name: <UUID>) (com.apple.dt.CoreDeviceError error 1000 (0x3E8))',
        '           DeviceName = <UUID>',
      ].join('\n') + '\n',
    );
  });

  it('normalizes volatile CoreDevice not-found ERROR prefixes without a preamble', () => {
    expect(
      normalizeSnapshotOutput(
        '  ✗ ERROR: The specified device was not found. (Name: <UUID>) (com.apple.dt.CoreDeviceError error 1000 (0x3E8))\n',
      ),
    ).toBe(
      '  ✗ The specified device was not found. (Name: <UUID>) (com.apple.dt.CoreDeviceError error 1000 (0x3E8))\n',
    );
  });

  it('normalizes doctor process tree depth without hiding the section', () => {
    expect(
      normalizeSnapshotOutput(
        [
          'Process Tree',
          '   <PID> (ppid <PID>): <PROCESS>',
          '   <PID> (ppid <PID>): <PROCESS>',
          '   <PID> (ppid <PID>): <PROCESS>',
          '   <PID> (ppid <PID>): <PROCESS>',
          '',
        ].join('\n'),
      ),
    ).toBe(
      [
        'Process Tree',
        '   <PID> (ppid <PID>): <PROCESS>',
        '   <PID> (ppid <PID>): <PROCESS>',
        '   <PID> (ppid <PID>): <PROCESS>',
        '',
      ].join('\n'),
    );
  });

  it('normalizes LLDB breakpoint byte offsets', () => {
    expect(
      normalizeSnapshotOutput(
        '  1.1: where = App.debug.dylib`ContentView.body.getter + 1428 at ContentView.swift:42:31, address = 0x123456789, unresolved, hit count = 0\n',
      ),
    ).toBe(
      '  1.1: where = App.debug.dylib`ContentView.body.getter + <OFFSET> at ContentView.swift:42:31, address = <ADDR>, unresolved, hit count = 0\n',
    );
  });

  it('normalizes CoreSimulator runtime roots in LLDB stack output', () => {
    const runtimeRoot =
      '/Library/Developer/CoreSimulator/Volumes/iOS_23E244/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS 26.4.simruntime/Contents/Resources/RuntimeRoot';

    expect(
      normalizeSnapshotOutput(
        [
          `  frame #12: 0x123456789 at ${runtimeRoot}/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation\`__CFRunLoopRun:1234`,
          '  frame #13: static CalculatorApp.$main() at <HOME>/Library/Developer/CoreSimulator/Devices/<UUID>/data/Containers/Bundle/Application/<UUID>/CalculatorApp.app/CalculatorApp.debug.dylib`static CalculatorApp.CalculatorApp.$main() -> ():1234',
          '  frame #14: main at <HOME>/Library/Developer/CoreSimulator/Devices/<UUID>/data/Library/Caches/com.apple.containermanagerd/Dead/temp.7Nradi/<UUID>/CalculatorApp.app/CalculatorApp.debug.dylib`main:1234',
        ].join('\n') + '\n',
      ),
    ).toBe(
      [
        '  frame #<N>: <FUNC> at <SIM_RUNTIME_ROOT>/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation`<FUNC>:<OFFSET>',
        '  frame #<N>: static CalculatorApp.$main() at <SIM_APP_BUNDLE>/CalculatorApp.app/CalculatorApp.debug.dylib`static CalculatorApp.CalculatorApp.$main() -> ():<OFFSET>',
        '  frame #<N>: main at <SIM_APP_BUNDLE>/CalculatorApp.app/CalculatorApp.debug.dylib`main:<OFFSET>',
      ].join('\n') + '\n',
    );
  });

  it('trims volatile system stack prefixes while preserving the app launch suffix', () => {
    expect(
      normalizeSnapshotOutput(
        [
          'Frames:',
          '  Thread 123456 (Thread 1 Queue: com.apple.main-thread (serial))',
          '  frame #0: 0x1111 at /Library/Developer/CoreSimulator/Volumes/iOS_23E244/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS 26.4.simruntime/Contents/Resources/RuntimeRoot/System/Library/PrivateFrameworks/AXRuntime.framework/AXRuntime`AXPerform:1234',
          '  frame #1: 0x2222 at /Library/Developer/CoreSimulator/Volumes/iOS_23E244/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS 26.4.simruntime/Contents/Resources/RuntimeRoot/System/Library/PrivateFrameworks/GraphicsServices.framework/GraphicsServices`GSEventRunModal:1234',
          '  frame #2: 0x3333 at /Library/Developer/CoreSimulator/Volumes/iOS_23E244/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS 26.4.simruntime/Contents/Resources/RuntimeRoot/System/Library/Frameworks/SwiftUI.framework/SwiftUI`static SwiftUI.App.main() -> ():1234',
          '  frame #3: static CalculatorApp.$main() at <HOME>/Library/Developer/CoreSimulator/Devices/<UUID>/data/Containers/Bundle/Application/<UUID>/CalculatorApp.app/CalculatorApp.debug.dylib`static CalculatorApp.CalculatorApp.$main() -> ():1234',
          '  frame #4: main at <HOME>/Library/Developer/CoreSimulator/Devices/<UUID>/data/Containers/Bundle/Application/<UUID>/CalculatorApp.app/CalculatorApp.debug.dylib`main:1234',
        ].join('\n') + '\n',
      ),
    ).toBe(
      [
        'Frames:',
        '  Thread <THREAD_ID> (Thread 1 Queue: com.apple.main-thread (serial))',
        '  frame #<N>: <FUNC> at <SIM_RUNTIME_ROOT>/System/Library/PrivateFrameworks/GraphicsServices.framework/GraphicsServices`<FUNC>:<OFFSET>',
        '  frame #<N>: <FUNC> at <SIM_RUNTIME_ROOT>/System/Library/Frameworks/SwiftUI.framework/SwiftUI`<FUNC>:<OFFSET>',
        '  frame #<N>: static CalculatorApp.$main() at <SIM_APP_BUNDLE>/CalculatorApp.app/CalculatorApp.debug.dylib`static CalculatorApp.CalculatorApp.$main() -> ():<OFFSET>',
        '  frame #<N>: main at <SIM_APP_BUNDLE>/CalculatorApp.app/CalculatorApp.debug.dylib`main:<OFFSET>',
      ].join('\n') + '\n',
    );
  });

  it('normalizes process identifiers in string output', () => {
    expect(normalizeSnapshotOutput('appName: PID 123456\nkill: 123456: No such process\n')).toBe(
      'appName: PID <PID>\nkill: <PID>: No such process\n',
    );
  });

  it('normalizes both macOS spellings of a temporary directory without leaving a prefix', () => {
    const tmpDir = '/var/folders/ab/cd/T';

    expect(
      normalizeSnapshotOutput(
        [`${tmpDir}/spm-one/Package.swift`, `/private${tmpDir}/spm-two/Package.swift`].join('\n'),
        { tmpDir },
      ),
    ).toBe('<TMPDIR>/Package.swift\n<TMPDIR>/Package.swift\n');
  });

  it('preserves display-formatted home paths while normalizing workspace hashes', () => {
    expect(
      normalizeSnapshotOutput(
        '~/Library/Developer/MobileBuildMCP/workspaces/MobileBuildMCP-c5da0cbe19a7/logs/build.log\n',
      ),
    ).toBe('~/Library/Developer/MobileBuildMCP/workspaces/MobileBuildMCP-<HASH>/logs/build.log\n');
  });

  it('normalizes worktree-specific workspace names to the canonical fixture label', () => {
    expect(
      normalizeSnapshotOutput(
        '~/Library/Developer/MobileBuildMCP/workspaces/issue-450-c5da0cbe19a7/logs/build.log\n',
      ),
    ).toBe('~/Library/Developer/MobileBuildMCP/workspaces/MobileBuildMCP-<HASH>/logs/build.log\n');
  });

  it('normalizes generated test products process and random suffixes', () => {
    expect(
      normalizeSnapshotOutput(
        '~/Library/Developer/MobileBuildMCP/workspaces/issue-450-c5da0cbe19a7/test-products/test_sim_2026-07-16T13-20-13-467Z_pid31212_06abe32f.xctestproducts\n',
      ),
    ).toBe(
      '~/Library/Developer/MobileBuildMCP/workspaces/MobileBuildMCP-<HASH>/test-products/test_sim_<TIMESTAMP>_pid<PID>.xctestproducts\n',
    );
  });

  it('normalizes absolute home MobileBuildMCP paths to ~/', () => {
    expect(
      normalizeSnapshotOutput(
        '<HOME>/Library/Developer/MobileBuildMCP/workspaces/MobileBuildMCP-c5da0cbe19a7/logs/build.log\n',
      ),
    ).toBe('~/Library/Developer/MobileBuildMCP/workspaces/MobileBuildMCP-<HASH>/logs/build.log\n');
  });

  it('normalizes workspace hash and derived data hash together', () => {
    expect(
      normalizeSnapshotOutput(
        '~/Library/Developer/MobileBuildMCP/workspaces/MobileBuildMCP-c5da0cbe19a7/DerivedData/CalculatorApp-7834e7689e33\n',
      ),
    ).toBe(
      '~/Library/Developer/MobileBuildMCP/workspaces/MobileBuildMCP-<HASH>/DerivedData/CalculatorApp-<HASH>\n',
    );
  });

  it('normalizes workspace root nodes with trailing slash', () => {
    expect(
      normalizeSnapshotOutput(
        '~/Library/Developer/MobileBuildMCP/workspaces/MobileBuildMCP-c5da0cbe19a7/\n',
      ),
    ).toBe('~/Library/Developer/MobileBuildMCP/workspaces/MobileBuildMCP-<HASH>/\n');
  });

  it('normalizes xcode-ide raw response artifact path volatility', () => {
    expect(
      normalizeSnapshotOutput(
        '~/Library/Developer/MobileBuildMCP/workspaces/MobileBuildMCP-c5da0cbe19a7/state/xcode-ide/call-tool/ownerpid22817_6DDCB226-377E-4F3F-93D4-3CA386249E80/2026-05-07T17-21-14-001Z-list-tools-44fa9782.json — Raw Response JSON\n',
      ),
    ).toBe(
      '~/Library/Developer/MobileBuildMCP/workspaces/MobileBuildMCP-<HASH>/state/xcode-ide/call-tool/ownerpid<PID>_<UUID>/<TIMESTAMP>-list-tools-<HASH>.json — Raw Response JSON\n',
    );
  });

  it('normalizes UI snapshot clock text and volatile compact element refs', () => {
    expect(normalizeSnapshotOutput('"e42|text|text|12:34||"\n')).toBe(
      '"<REF>|text|text|<TIME>||"\n',
    );
  });

  it('normalizes UI element refs in next-step syntax and prose', () => {
    expect(
      normalizeSnapshotOutput(
        [
          'Tap: mobilebuildmcp ui-automation tap --simulator-id <UUID> --element-ref e48',
          'Scroll: mobilebuildmcp ui-automation swipe --within-element-ref "e1" --direction up',
          'MCP: tap({ simulatorId: "<UUID>", elementRef: "e48" })',
          'JSON: {"action":"tap","elementRef":"e40"}',
          'Message: acted on within elementRef e6',
        ].join('\n') + '\n',
      ),
    ).toBe(
      [
        'Tap: mobilebuildmcp ui-automation tap --simulator-id <UUID> --element-ref <REF>',
        'Scroll: mobilebuildmcp ui-automation swipe --within-element-ref "<REF>" --direction up',
        'MCP: tap({ simulatorId: "<UUID>", elementRef: "<REF>" })',
        'JSON: {"action":"tap","elementRef":"<REF>"}',
        'Message: acted on within elementRef <REF>',
      ].join('\n') + '\n',
    );
  });

  it('normalizes UI recovery refs and accessibility summary counts', () => {
    expect(
      normalizeSnapshotOutput(
        [
          "Message: Element ref 'e7' does not support 'swipeWithin'.",
          '  Element: e7',
          "❌ Element ref 'e7' does not support 'swipeWithin'.",
          '✅ Runtime UI snapshot captured with 21 elements, 19 likely targets, and 0 scroll areas.',
          '✅ Wait completed; runtime UI snapshot refreshed with 28 elements, 19 likely targets, and 0 scroll areas.',
        ].join('\n'),
      ),
    ).toBe(
      [
        "Message: Element ref '<REF>' does not support 'swipeWithin'.",
        '  Element: <REF>',
        "❌ Element ref '<REF>' does not support 'swipeWithin'.",
        '✅ Runtime UI snapshot captured with <ELEMENT_COUNT> elements, <LIKELY_TARGET_COUNT> likely targets, and <SCROLL_AREA_COUNT> scroll areas.',
        '✅ Wait completed; runtime UI snapshot refreshed with <ELEMENT_COUNT> elements, <LIKELY_TARGET_COUNT> likely targets, and <SCROLL_AREA_COUNT> scroll areas.',
      ].join('\n') + '\n',
    );
  });

  it('normalizes Swift package target triples', () => {
    expect(
      normalizeSnapshotOutput('App Path: <TMPDIR>/spm/.build/arm64-apple-macosx/debug/spm\n'),
    ).toBe('App Path: <TMPDIR>/spm/.build/<TARGET_TRIPLE>/debug/spm\n');
  });

  it('normalizes state-dependent swipe follow-up advice', () => {
    expect(
      normalizeSnapshotOutput(
        'Next steps:\n1. Take screenshot for verification: screenshot --simulator-id <UUID>\n',
      ),
    ).toBe('Next steps:\n1. <POST_SWIPE_NEXT_STEP>\n');
    expect(
      normalizeSnapshotOutput(
        'Next steps:\n1. Scroll visible content: swipe --simulator-id <UUID> --distance 0.5\n',
      ),
    ).toBe('Next steps:\n1. <POST_SWIPE_NEXT_STEP>\n');
  });

  it('sorts MCP test failures deterministically', () => {
    expect(
      normalizeSnapshotOutput(
        [
          'Test Failures (2):',
          '',
          '  ✗ ZebraSuite / testZebra: failed',
          '    Zebra.swift:2',
          '',
          '  ✗ AlphaSuite / testAlpha: failed',
          '    Alpha.swift:1',
          '',
          '❌ 2 tests failed, 1 passed',
        ].join('\n'),
      ),
    ).toBe(
      [
        'Test Failures (2):',
        '',
        '  ✗ AlphaSuite / testAlpha: failed',
        '    Alpha.swift:1',
        '',
        '  ✗ ZebraSuite / testZebra: failed',
        '    Zebra.swift:2',
        '',
        '❌ <FAIL_COUNT> tests failed, <PASS_COUNT> passed, <SKIP_COUNT> skipped',
      ].join('\n') + '\n',
    );
  });

  it('normalizes runtime and compact UI action rows without hiding action content', () => {
    expect(
      normalizeSnapshotOutput(
        [
          '  iOS 26.5:',
          '  e48|tap|button|Camera||com.apple.settings.camera',
          '  e1|swipe|application|Settings||',
          '  [5/8] Write swift-version--58304C5D6DBC2206.txt',
          '  [6/8] Write swift-version-69A768CDF2A0BEE1.txt',
        ].join('\n') + '\n',
      ),
    ).toBe(
      [
        '  iOS <VERSION>:',
        '  <REF>|tap|button|Camera||com.apple.settings.camera',
        '  <REF>|swipe|application|Settings||',
        '  [5/8] Write swift-version--<HASH>.txt',
        '  [6/8] Write swift-version--<HASH>.txt',
      ].join('\n') + '\n',
    );
  });

  it('collapses long simulator failure progress streams while preserving final counts', () => {
    const normalized = normalizeSnapshotOutput(`${progressBlock(42, 3)}\n`);

    expect(normalized).toBe(
      'Running tests (<TEST_PROGRESS>; final: 42 completed, 3 failed, 0 skipped)\n',
    );
  });

  it('does not collapse short progress streams', () => {
    const block = `${progressBlock(4, 1)}\n`;

    expect(normalizeSnapshotOutput(block)).toBe(block);
  });

  it('does not collapse long successful progress streams', () => {
    const block = `${progressBlock(40, 0)}\n`;

    expect(normalizeSnapshotOutput(block)).toBe(block);
  });

  it('collapses long simulator failure progress streams that start after the initial zero update', () => {
    const normalized = normalizeSnapshotOutput(
      `${progressBlock(42, 3).split('\n').slice(1).join('\n')}\n`,
    );

    expect(normalized).toBe(
      'Running tests (<TEST_PROGRESS>; final: 42 completed, 3 failed, 0 skipped)\n',
    );
  });

  it('does not collapse progress streams with non-monotonic counts', () => {
    const block = [
      progressBlock(20, 0),
      'Running tests (19 completed, 0 failures, 0 skipped)',
      progressBlock(40, 2).split('\n').slice(21).join('\n'),
    ].join('\n');

    expect(normalizeSnapshotOutput(`${block}\n`)).toBe(`${block}\n`);
  });
});
