import { describe, expect, it } from 'vitest';
import type { StructuredOutputEnvelope } from '../../types/structured-output.ts';
import { formatStructuredEnvelopeFixture, normalizeStructuredEnvelope } from '../json-normalize.ts';

describe('normalizeStructuredEnvelope', () => {
  it('keeps suite-less simulator test cases while normalizing volatile durations', () => {
    const envelope: StructuredOutputEnvelope<unknown> = {
      schema: 'mobilebuildmcp.output.test-result',
      schemaVersion: '1',
      didError: true,
      error: 'Tests failed',
      data: {
        summary: { target: 'simulator' },
        testCases: [
          { test: 'Volatile Swift Testing pass', status: 'passed', durationMs: 12 },
          { test: 'Swift Testing failure', status: 'failed', durationMs: 34 },
          { suite: 'XCTestSuite', test: 'testStablePass', status: 'passed', durationMs: 56 },
        ],
      },
    };

    expect(normalizeStructuredEnvelope(envelope)).toEqual({
      schema: 'mobilebuildmcp.output.test-result',
      schemaVersion: '1',
      didError: true,
      error: 'Tests failed',
      data: {
        summary: { target: 'simulator' },
        testCases: [{ test: 'Swift Testing failure', status: 'failed', durationMs: 0 }],
      },
    });
  });

  it('preserves non-temp xcresult paths in test result artifacts', () => {
    const envelope: StructuredOutputEnvelope<unknown> = {
      schema: 'mobilebuildmcp.output.test-result',
      schemaVersion: '1',
      didError: false,
      error: null,
      data: {
        summary: { target: 'simulator' },
        artifacts: {
          buildLogPath: '/snapshot-fixtures/build.log',
          xcresultPath: '/snapshot-fixtures/App Tests.xcresult',
        },
      },
    };

    expect(normalizeStructuredEnvelope(envelope)).toEqual(envelope);
  });

  it('normalizes test result artifact paths under an injected temp directory', () => {
    const tmpDir = '/__mobilebuildmcp_tmp__';
    const envelope: StructuredOutputEnvelope<unknown> = {
      schema: 'mobilebuildmcp.output.test-result',
      schemaVersion: '1',
      didError: false,
      error: null,
      data: {
        summary: { target: 'simulator' },
        artifacts: {
          buildLogPath: `${tmpDir}/run/build.log`,
          xcresultPath: `${tmpDir}/run/App Tests.xcresult`,
        },
      },
    };

    expect(normalizeStructuredEnvelope(envelope, { tmpDir })).toEqual({
      schema: 'mobilebuildmcp.output.test-result',
      schemaVersion: '1',
      didError: false,
      error: null,
      data: {
        summary: { target: 'simulator' },
        artifacts: {
          buildLogPath: '<TMPDIR>/build.log',
          xcresultPath: '<TMPDIR>/App Tests.xcresult',
        },
      },
    });
  });

  it('keeps suite-less passed test cases for non-simulator results', () => {
    const envelope: StructuredOutputEnvelope<unknown> = {
      schema: 'mobilebuildmcp.output.test-result',
      schemaVersion: '1',
      didError: false,
      error: null,
      data: {
        summary: { target: 'swift-package' },
        testCases: [{ test: 'Package Swift Testing pass', status: 'passed', durationMs: 12 }],
      },
    };

    expect(normalizeStructuredEnvelope(envelope)).toEqual({
      schema: 'mobilebuildmcp.output.test-result',
      schemaVersion: '1',
      didError: false,
      error: null,
      data: {
        summary: { target: 'swift-package' },
        testCases: [{ test: 'Package Swift Testing pass', status: 'passed', durationMs: 0 }],
      },
    });
  });

  it('sorts diagnostic test failures while normalizing volatile Swift Testing suite names', () => {
    const envelope: StructuredOutputEnvelope<unknown> = {
      schema: 'mobilebuildmcp.output.test-result',
      schemaVersion: '2',
      didError: true,
      error: 'Tests failed',
      data: {
        diagnostics: {
          testFailures: [
            {
              suite: 'CalculatorAppTests',
              test: 'testCalculatorServiceFailure',
              message: 'XCTAssertEqual failed',
              location: '<ROOT>/example_projects/iOS_Calculator/CalculatorAppTests.swift:52',
            },
            {
              suite: 'Calculator Basic Functionality',
              test: 'This test should fail to verify error reporting',
              message: 'Expectation failed',
              location: 'CalculatorServiceTests.swift:37',
            },
          ],
        },
      },
    };

    expect(normalizeStructuredEnvelope(envelope)).toEqual({
      schema: 'mobilebuildmcp.output.test-result',
      schemaVersion: '2',
      didError: true,
      error: 'Tests failed',
      data: {
        diagnostics: {
          testFailures: [
            {
              suite: '<SWIFT_TEST_SUITE>',
              test: 'This test should fail to verify error reporting',
              message: 'Expectation failed',
              location: 'CalculatorServiceTests.swift:37',
            },
            {
              suite: 'CalculatorAppTests',
              test: 'testCalculatorServiceFailure',
              message: 'XCTAssertEqual failed',
              location: '<ROOT>/example_projects/iOS_Calculator/CalculatorAppTests.swift:52',
            },
          ],
        },
      },
    });
  });

  it('normalizes iOS and watchOS simulator runtime versions', () => {
    const envelope = {
      schema: 'mobilebuildmcp.output.simulators-result',
      schemaVersion: '1',
      didError: false,
      error: null,
      data: { simulators: [{ runtime: 'iOS 26.4' }, { runtime: 'watchOS 27.0' }] },
    } as StructuredOutputEnvelope<unknown>;

    expect(normalizeStructuredEnvelope(envelope)).toEqual({
      ...envelope,
      data: { simulators: [{ runtime: 'iOS <VERSION>' }, { runtime: 'watchOS <VERSION>' }] },
    });
  });

  it('normalizes UI element refs without hiding action content', () => {
    const envelope: StructuredOutputEnvelope<unknown> = {
      schema: 'mobilebuildmcp.output.ui-action-result',
      schemaVersion: '2',
      didError: false,
      error: null,
      data: {
        action: {
          type: 'swipe',
          withinElementRef: 'e1',
        },
        capture: {
          type: 'runtime-snapshot',
          rs: '1',
          screenHash: 'screen-hash',
          seq: 7,
          count: 99999,
          targets: ['e48|tap|button|Camera||com.apple.settings.camera'],
          scroll: ['e1|swipe|application|Calculator||Calculator'],
          text: ['e42|text|text|12:34||'],
        },
      },
      nextSteps: [
        'Take screenshot for verification: screenshot({ simulatorId: "SIMULATOR-1" })',
        'Scroll visible content: swipe({ withinElementRef: "e1" })',
      ],
    };

    expect(normalizeStructuredEnvelope(envelope)).toEqual({
      schema: 'mobilebuildmcp.output.ui-action-result',
      schemaVersion: '2',
      didError: false,
      error: null,
      data: {
        action: {
          type: 'swipe',
          withinElementRef: '<ELEMENT_REF>',
        },
        capture: {
          type: 'runtime-snapshot',
          rs: '1',
          screenHash: '<SCREEN_HASH>',
          seq: 1,
          count: 99999,
          targets: ['<REF>|tap|button|Camera||com.apple.settings.camera'],
          scroll: ['<REF>|swipe|application|Calculator||Calculator'],
          text: ['<REF>|text|text|<TIME>||'],
        },
      },
      nextSteps: ['<POST_SWIPE_NEXT_STEP>', '<POST_SWIPE_NEXT_STEP>'],
    });
  });

  it('preserves schema-constrained verbose runtime snapshot refs', () => {
    const envelope: StructuredOutputEnvelope<unknown> = {
      schema: 'mobilebuildmcp.output.capture-result',
      schemaVersion: '2',
      didError: false,
      error: null,
      data: {
        capture: {
          type: 'runtime-snapshot',
          protocol: 'rs/1',
          simulatorId: 'SIMULATOR-1',
          screenHash: 'screen-hash',
          seq: 9,
          capturedAtMs: 123,
          expiresAtMs: 456,
          elements: [{ ref: 'e12', role: 'button', frame: { x: 1, y: 2, width: 3, height: 4 } }],
          actions: [{ action: 'tap', elementRef: 'e12', label: '7' }],
        },
      },
    };

    expect(normalizeStructuredEnvelope(envelope)).toEqual({
      schema: 'mobilebuildmcp.output.capture-result',
      schemaVersion: '2',
      didError: false,
      error: null,
      data: {
        capture: {
          type: 'runtime-snapshot',
          protocol: 'rs/1',
          simulatorId: 'SIMULATOR-1',
          screenHash: '<SCREEN_HASH>',
          seq: 1,
          capturedAtMs: 1_700_000_000_000,
          expiresAtMs: 1_700_000_060_000,
          elements: [{ ref: 'e12', role: 'button', frame: { x: 0, y: 0, width: 1, height: 1 } }],
          actions: [{ action: 'tap', elementRef: 'e12', label: '7' }],
        },
      },
    });
  });

  it('normalizes Settings.app compact capture refs without hiding capture content', () => {
    const envelope: StructuredOutputEnvelope<unknown> = {
      schema: 'mobilebuildmcp.output.ui-action-result',
      schemaVersion: '2',
      didError: false,
      error: null,
      data: {
        settingsCapture: {
          type: 'runtime-snapshot',
          rs: '1',
          screenHash: 'settings-screen-hash',
          seq: 9,
          count: 99999,
          targets: ['e48|tap|button|Camera||com.apple.settings.camera'],
          scroll: ['e1|swipe|application|Settings||'],
          text: ['e42|text|text|Camera||'],
        },
        appCapture: {
          type: 'runtime-snapshot',
          rs: '1',
          screenHash: 'app-screen-hash',
          seq: 10,
          count: 99999,
          targets: ['e14|tap|button|7||'],
          scroll: ['e6|swipe|application|Calculator||Calculator'],
          text: ['e31|text|text|Calculator||'],
        },
      },
    };

    expect(normalizeStructuredEnvelope(envelope)).toEqual({
      schema: 'mobilebuildmcp.output.ui-action-result',
      schemaVersion: '2',
      didError: false,
      error: null,
      data: {
        settingsCapture: {
          type: 'runtime-snapshot',
          rs: '1',
          screenHash: '<SCREEN_HASH>',
          seq: 9,
          count: 99999,
          targets: ['<REF>|tap|button|Camera||com.apple.settings.camera'],
          scroll: ['<REF>|swipe|application|Settings||'],
          text: ['<REF>|text|text|Camera||'],
        },
        appCapture: {
          type: 'runtime-snapshot',
          rs: '1',
          screenHash: '<SCREEN_HASH>',
          seq: 10,
          count: 99999,
          targets: ['<REF>|tap|button|7||'],
          scroll: ['<REF>|swipe|application|Calculator||Calculator'],
          text: ['<REF>|text|text|Calculator||'],
        },
      },
    });
  });

  it('normalizes only volatile SpringBoard home compact capture count and transient open hint', () => {
    const envelope: StructuredOutputEnvelope<unknown> = {
      schema: 'mobilebuildmcp.output.ui-action-result',
      schemaVersion: '2',
      didError: false,
      error: null,
      data: {
        capture: {
          type: 'runtime-snapshot',
          rs: '1',
          screenHash: 'home-screen-hash',
          seq: 3,
          count: 240,
          targets: [
            'e1|tap|button|Settings||Settings',
            'e2|tap|button|Double-tap to open||',
            'e3|tap|button|Safari||Safari',
          ],
          scroll: ['e4|swipe|other|||Home screen icons'],
          text: ['e5|text|text|Search||'],
        },
      },
    };

    expect(normalizeStructuredEnvelope(envelope)).toEqual({
      schema: 'mobilebuildmcp.output.ui-action-result',
      schemaVersion: '2',
      didError: false,
      error: null,
      data: {
        capture: {
          type: 'runtime-snapshot',
          rs: '1',
          screenHash: '<SCREEN_HASH>',
          seq: 1,
          count: 99999,
          targets: ['<REF>|tap|button|Settings||Settings', '<REF>|tap|button|Safari||Safari'],
          scroll: ['<REF>|swipe|other|||Home screen icons'],
          text: ['<REF>|text|text|Search||'],
        },
      },
    });
  });

  it('normalizes system-owned debug stack frames while preserving app-owned frames', () => {
    const runtimeRoot =
      '/Library/Developer/CoreSimulator/Volumes/iOS_23E244/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS 26.4.simruntime/Contents/Resources/RuntimeRoot';
    const envelope: StructuredOutputEnvelope<unknown> = {
      schema: 'mobilebuildmcp.output.debug-stack-result',
      schemaVersion: '2',
      didError: false,
      error: null,
      data: {
        threads: [
          {
            threadId: 12345,
            name: 'Thread 1 Queue: com.apple.main-thread (serial)',
            truncated: false,
            frames: [
              {
                index: 0,
                symbol: '__CFRunLoopRun',
                displayLocation: `${runtimeRoot}/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation\`__CFRunLoopRun:<OFFSET>`,
              },
              {
                index: 1,
                symbol: 'start',
                displayLocation: '/usr/lib/dyld`start:<OFFSET>',
              },
              {
                index: 2,
                symbol: 'static CalculatorApp.$main()',
                displayLocation:
                  '<SIM_APP_BUNDLE>/CalculatorApp.app/CalculatorApp.debug.dylib`static CalculatorApp.CalculatorApp.$main() -> ():<OFFSET>',
              },
              {
                index: 3,
                symbol: 'main',
                displayLocation:
                  '<SIM_APP_BUNDLE>/CalculatorApp.app/CalculatorApp.debug.dylib`main:<OFFSET>',
              },
            ],
          },
        ],
      },
    };

    expect(normalizeStructuredEnvelope(envelope)).toEqual({
      schema: 'mobilebuildmcp.output.debug-stack-result',
      schemaVersion: '2',
      didError: false,
      error: null,
      data: {
        threads: [
          {
            threadId: 1,
            name: 'Thread 1 Queue: com.apple.main-thread (serial)',
            truncated: false,
            frames: [
              {
                index: 0,
                symbol: '<FUNC>',
                displayLocation:
                  '<SIM_RUNTIME_ROOT>/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation`<FUNC>:<OFFSET>',
              },
              {
                index: 1,
                symbol: '<FUNC>',
                displayLocation: '/usr/lib/dyld`<FUNC>:<OFFSET>',
              },
              {
                index: 2,
                symbol: 'static CalculatorApp.$main()',
                displayLocation:
                  '<SIM_APP_BUNDLE>/CalculatorApp.app/CalculatorApp.debug.dylib`static CalculatorApp.CalculatorApp.$main() -> ():<OFFSET>',
              },
              {
                index: 3,
                symbol: 'main',
                displayLocation:
                  '<SIM_APP_BUNDLE>/CalculatorApp.app/CalculatorApp.debug.dylib`main:<OFFSET>',
              },
            ],
          },
        ],
      },
    });
  });

  it('trims volatile system debug stack frame prefixes while preserving app launch frames', () => {
    const envelope: StructuredOutputEnvelope<unknown> = {
      schema: 'mobilebuildmcp.output.debug-stack-result',
      schemaVersion: '2',
      didError: false,
      error: null,
      data: {
        threads: [
          {
            threadId: 1,
            name: 'Thread 1 Queue: com.apple.main-thread (serial)',
            truncated: false,
            frames: [
              {
                index: 0,
                symbol: 'AXPerform',
                displayLocation:
                  '<SIM_RUNTIME_ROOT>/System/Library/PrivateFrameworks/AXRuntime.framework/AXRuntime`AXPerform:<OFFSET>',
              },
              {
                index: 1,
                symbol: 'GSEventRunModal',
                displayLocation:
                  '<SIM_RUNTIME_ROOT>/System/Library/PrivateFrameworks/GraphicsServices.framework/GraphicsServices`GSEventRunModal:<OFFSET>',
              },
              {
                index: 2,
                symbol: 'UIApplicationMain',
                displayLocation:
                  '<SIM_RUNTIME_ROOT>/System/Library/PrivateFrameworks/UIKitCore.framework/UIKitCore`UIApplicationMain:<OFFSET>',
              },
              {
                index: 3,
                symbol: 'static CalculatorApp.$main()',
                displayLocation:
                  '<SIM_APP_BUNDLE>/CalculatorApp.app/CalculatorApp.debug.dylib`static CalculatorApp.CalculatorApp.$main() -> ():<OFFSET>',
              },
              {
                index: 4,
                symbol: 'main',
                displayLocation:
                  '<SIM_APP_BUNDLE>/CalculatorApp.app/CalculatorApp.debug.dylib`main:<OFFSET>',
              },
            ],
          },
        ],
      },
    };

    expect(normalizeStructuredEnvelope(envelope)).toEqual({
      schema: 'mobilebuildmcp.output.debug-stack-result',
      schemaVersion: '2',
      didError: false,
      error: null,
      data: {
        threads: [
          {
            threadId: 1,
            name: 'Thread 1 Queue: com.apple.main-thread (serial)',
            truncated: false,
            frames: [
              {
                index: 0,
                symbol: '<FUNC>',
                displayLocation:
                  '<SIM_RUNTIME_ROOT>/System/Library/PrivateFrameworks/GraphicsServices.framework/GraphicsServices`<FUNC>:<OFFSET>',
              },
              {
                index: 1,
                symbol: '<FUNC>',
                displayLocation:
                  '<SIM_RUNTIME_ROOT>/System/Library/PrivateFrameworks/UIKitCore.framework/UIKitCore`<FUNC>:<OFFSET>',
              },
              {
                index: 2,
                symbol: 'static CalculatorApp.$main()',
                displayLocation:
                  '<SIM_APP_BUNDLE>/CalculatorApp.app/CalculatorApp.debug.dylib`static CalculatorApp.CalculatorApp.$main() -> ():<OFFSET>',
              },
              {
                index: 3,
                symbol: 'main',
                displayLocation:
                  '<SIM_APP_BUNDLE>/CalculatorApp.app/CalculatorApp.debug.dylib`main:<OFFSET>',
              },
            ],
          },
        ],
      },
    });
  });

  it('normalizes volatile runtime snapshot timestamps', () => {
    const envelope: StructuredOutputEnvelope<unknown> = {
      schema: 'mobilebuildmcp.output.capture-result',
      schemaVersion: '2',
      didError: false,
      error: null,
      data: {
        summary: { status: 'SUCCEEDED' },
        artifacts: { simulatorId: 'SIMULATOR-1' },
        capture: {
          type: 'runtime-snapshot',
          protocol: 'rs/1',
          simulatorId: 'SIMULATOR-1',
          screenHash: 'screen-hash',
          seq: 9,
          capturedAtMs: 123,
          expiresAtMs: 456,
          elements: [],
          actions: [],
        },
        uiError: {
          code: 'TARGET_NOT_ACTIONABLE',
          message: 'Target is not actionable.',
          recoveryHint: 'Refresh the snapshot and choose another element.',
          snapshotAgeMs: 42,
        },
      },
    };

    expect(normalizeStructuredEnvelope(envelope)).toEqual({
      schema: 'mobilebuildmcp.output.capture-result',
      schemaVersion: '2',
      didError: false,
      error: null,
      data: {
        summary: { status: 'SUCCEEDED' },
        artifacts: { simulatorId: 'SIMULATOR-1' },
        capture: {
          type: 'runtime-snapshot',
          protocol: 'rs/1',
          simulatorId: 'SIMULATOR-1',
          screenHash: '<SCREEN_HASH>',
          seq: 1,
          capturedAtMs: 1_700_000_000_000,
          expiresAtMs: 1_700_000_060_000,
          elements: [],
          actions: [],
        },
        uiError: {
          code: 'TARGET_NOT_ACTIONABLE',
          message: 'Target is not actionable.',
          recoveryHint: 'Refresh the snapshot and choose another element.',
          snapshotAgeMs: 1234,
        },
      },
    });
  });

  it('normalizes and sorts SwiftPM build progress lines in stderr arrays', () => {
    const envelope: StructuredOutputEnvelope<unknown> = {
      schema: 'mobilebuildmcp.output.build-run-result',
      schemaVersion: '1',
      didError: false,
      error: null,
      data: {
        output: {
          stderr: [
            'Building for debugging...',
            '[5/8] Emitting module spm',
            '[4/8] Compiling spm main.swift',
            "Build of product 'spm' complete! (0.42s)",
          ],
        },
      },
    };

    expect(normalizeStructuredEnvelope(envelope)).toEqual({
      schema: 'mobilebuildmcp.output.build-run-result',
      schemaVersion: '1',
      didError: false,
      error: null,
      data: {
        output: {
          stderr: [
            'Building for debugging...',
            '[<STEP>] Compiling spm main.swift',
            '[<STEP>] Emitting module spm',
            "Build of product 'spm' complete! (<DURATION>)",
          ],
        },
      },
    });
  });

  it('normalizes volatile build settings entry values without dropping entries', () => {
    const envelope: StructuredOutputEnvelope<unknown> = {
      schema: 'mobilebuildmcp.output.build-settings',
      schemaVersion: '1',
      didError: false,
      error: null,
      data: {
        entries: [
          { key: 'ALTERNATE_OWNER', value: 'cameroncooke' },
          { key: 'ALTERNATE_GROUP', value: 'staff' },
          { key: 'CACHE_ROOT', value: '/var/folders/hash/C/com.apple.DeveloperTools/26.4/Xcode' },
          { key: 'GID', value: '20' },
          { key: 'TARGET_DEVICE_MODEL', value: 'iPhone17,2' },
          { key: 'TARGET_DEVICE_OS_VERSION', value: '26.4.2' },
          {
            key: 'SDKROOT',
            value:
              '/Applications/Xcode-26.4.0.app/Contents/Developer/Platforms/iPhoneOS.platform/Developer/SDKs/iPhoneOS26.4.sdk',
          },
          {
            key: 'SDK_DIR_iphoneos26_4',
            value:
              '/Applications/Xcode-26.4.0.app/Contents/Developer/Platforms/iPhoneOS.platform/Developer/SDKs/iPhoneOS26.4.sdk',
          },
          { key: 'SDK_NAME', value: 'iphoneos26.4' },
          { key: 'SDK_VERSION_ACTUAL', value: '260400' },
          { key: 'SDK_PRODUCT_BUILD_VERSION', value: '23E237' },
          { key: 'MAC_OS_X_VERSION_ACTUAL', value: '260301' },
          { key: 'MAC_OS_X_PRODUCT_BUILD_VERSION', value: '25D2128' },
          { key: 'XCODE_PRODUCT_BUILD_VERSION', value: '17F42' },
          { key: 'XCODE_VERSION_ACTUAL', value: '2650' },
          { key: 'DEPLOYMENT_TARGET_SUGGESTED_VALUES', value: '12.0 26.5' },
          { key: 'MACOSX_DEPLOYMENT_TARGET', value: '26.5' },
          { key: 'XROS_DEPLOYMENT_TARGET', value: '26.5' },
          {
            key: 'PLATFORM_DEVELOPER_APPLICATIONS_DIR',
            value: '/Applications/Xcode-26.4.0.app/Contents/Developer/Applications',
          },
          {
            key: 'SDK_STAT_CACHE_PATH',
            value:
              '<HOME>/Library/Developer/Xcode/DerivedData/SDKStatCaches.noindex/iphoneos26.4-23E237-c1e9.sdkstatcache',
          },
        ],
      },
    };

    expect(normalizeStructuredEnvelope(envelope)).toEqual({
      schema: 'mobilebuildmcp.output.build-settings',
      schemaVersion: '1',
      didError: false,
      error: null,
      data: {
        entries: [
          { key: 'ALTERNATE_OWNER', value: '<USER>' },
          { key: 'ALTERNATE_GROUP', value: '<GROUP>' },
          { key: 'CACHE_ROOT', value: '<XCODE_CACHE_ROOT>' },
          { key: 'GID', value: '<GID>' },
          { key: 'TARGET_DEVICE_MODEL', value: '<DEVICE_MODEL>' },
          { key: 'TARGET_DEVICE_OS_VERSION', value: '<OS_VERSION>' },
          { key: 'SDKROOT', value: '<SDK_PATH>' },
          { key: 'SDK_DIR_<SDK_NAME>', value: '<SDK_PATH>' },
          { key: 'SDK_NAME', value: '<SDK_NAME>' },
          { key: 'SDK_VERSION_ACTUAL', value: '<SDK_VERSION>' },
          { key: 'SDK_PRODUCT_BUILD_VERSION', value: '<SDK_BUILD_VERSION>' },
          { key: 'MAC_OS_X_VERSION_ACTUAL', value: '<SDK_VERSION>' },
          { key: 'MAC_OS_X_PRODUCT_BUILD_VERSION', value: '<SDK_BUILD_VERSION>' },
          { key: 'XCODE_PRODUCT_BUILD_VERSION', value: '<SDK_BUILD_VERSION>' },
          { key: 'XCODE_VERSION_ACTUAL', value: '<SDK_VERSION>' },
          { key: 'DEPLOYMENT_TARGET_SUGGESTED_VALUES', value: '<DEPLOYMENT_TARGETS>' },
          { key: 'MACOSX_DEPLOYMENT_TARGET', value: '<DEPLOYMENT_TARGET>' },
          { key: 'XROS_DEPLOYMENT_TARGET', value: '<DEPLOYMENT_TARGET>' },
          {
            key: 'PLATFORM_DEVELOPER_APPLICATIONS_DIR',
            value: '/Applications/Xcode-<VERSION>.app/Contents/Developer/Applications',
          },
          { key: 'SDK_STAT_CACHE_PATH', value: '<SDK_STAT_CACHE_PATH>' },
        ],
      },
    });
  });

  it('normalizes physical device connection state without hiding device identity', () => {
    const envelope: StructuredOutputEnvelope<unknown> = {
      schema: 'mobilebuildmcp.output.device-list',
      schemaVersion: '2',
      didError: false,
      error: null,
      data: {
        devices: [
          {
            name: 'Cameron’s Apple Watch',
            deviceId: '00008110-001455903AEB401E',
            platform: 'watchOS',
            state: 'disconnected',
            isAvailable: false,
            osVersion: '26.5',
          },
        ],
      },
    };

    expect(normalizeStructuredEnvelope(envelope)).toEqual({
      schema: 'mobilebuildmcp.output.device-list',
      schemaVersion: '2',
      didError: false,
      error: null,
      data: {
        devices: [
          {
            name: 'Cameron’s Apple Watch',
            deviceId: '<UUID>',
            platform: 'watchOS',
            state: '<DEVICE_STATE>',
            isAvailable: true,
            osVersion: '<OS_VERSION>',
          },
        ],
      },
    });
  });

  it('compacts frame objects emitted with y before x', () => {
    const envelope: StructuredOutputEnvelope<unknown> = {
      schema: 'mobilebuildmcp.output.ui-snapshot',
      schemaVersion: '1',
      didError: false,
      error: null,
      data: {
        frame: { y: 2, x: 1, width: 3, height: 4 },
      },
    };

    expect(formatStructuredEnvelopeFixture(envelope)).toContain(
      '"frame": { "x": 1, "y": 2, "width": 3, "height": 4 }',
    );
  });

  it('normalizes volatile build settings PATH entry values without dropping the entry', () => {
    const envelope: StructuredOutputEnvelope<unknown> = {
      schema: 'mobilebuildmcp.output.build-settings',
      schemaVersion: '1',
      didError: false,
      error: null,
      data: {
        entries: [
          { key: 'SDKROOT', value: 'iphoneos' },
          { key: 'PATH', value: '/volatile/bin:/another/volatile/bin' },
        ],
      },
    };

    expect(normalizeStructuredEnvelope(envelope)).toEqual({
      schema: 'mobilebuildmcp.output.build-settings',
      schemaVersion: '1',
      didError: false,
      error: null,
      data: {
        entries: [
          { key: 'SDKROOT', value: '<SDK_PATH>' },
          { key: 'PATH', value: '<PATH_ENTRIES>' },
        ],
      },
    });
  });
});
