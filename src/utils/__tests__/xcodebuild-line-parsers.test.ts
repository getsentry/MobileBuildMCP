import { describe, expect, it } from 'vitest';
import {
  isBuildErrorDiagnosticLine,
  parseBuildErrorDiagnostic,
  parseDurationMs,
  parseRawTestName,
} from '../xcodebuild-line-parsers.ts';

describe('parseDurationMs', () => {
  it('parses xcodebuild-style seconds text into milliseconds', () => {
    expect(parseDurationMs('0.002 seconds')).toBe(2);
    expect(parseDurationMs('1.234s')).toBe(1234);
  });

  it('returns undefined for unparseable duration text', () => {
    expect(parseDurationMs('unknown')).toBeUndefined();
    expect(parseDurationMs()).toBeUndefined();
  });
});

describe('parseBuildErrorDiagnostic', () => {
  it('parses structured compiler and xcodebuild errors', () => {
    expect(
      parseBuildErrorDiagnostic(
        "/tmp/App.swift:8:17: error: cannot convert value of type 'String' to specified type 'Int'",
      ),
    ).toEqual({
      location: '/tmp/App.swift:8',
      message: "cannot convert value of type 'String' to specified type 'Int'",
      renderedLine:
        "/tmp/App.swift:8:17: error: cannot convert value of type 'String' to specified type 'Int'",
    });

    expect(parseBuildErrorDiagnostic('/tmp/MyApp.xcodeproj: error: No such project')).toEqual({
      location: '/tmp/MyApp.xcodeproj',
      message: 'No such project',
      renderedLine: '/tmp/MyApp.xcodeproj: error: No such project',
    });

    expect(parseBuildErrorDiagnostic('xcodebuild: error: Unable to find destination')).toEqual({
      message: 'Unable to find destination',
      renderedLine: 'xcodebuild: error: Unable to find destination',
    });

    expect(parseBuildErrorDiagnostic('clang++: error: linker command failed')).toEqual({
      message: 'linker command failed',
      renderedLine: 'clang++: error: linker command failed',
    });

    expect(parseBuildErrorDiagnostic('error: emit-module command failed')).toEqual({
      message: 'emit-module command failed',
      renderedLine: 'error: emit-module command failed',
    });
  });

  it('preserves the full raw line for diagnostic-looking errors without a known structure', () => {
    const line = '2026-04-23 12:00:00.000 xcodebuild[123:456] error: IDE operation failed';

    expect(parseBuildErrorDiagnostic(line)).toEqual({
      message: line,
      renderedLine: line,
    });
  });

  it('uses header severity rather than quoted diagnostic text', () => {
    for (const line of [
      '/tmp/Bridge.cpp:4:2: warning: quoted execution error: message',
      '/tmp/Bridge.cpp:4:2: note: quoted execution error: message',
      '4 | log("execution error: message");',
      '4 | log("/tmp/Bridge.cpp:1: error: message");',
      'ld: warning: quoted error: message',
    ]) {
      expect(isBuildErrorDiagnosticLine(line)).toBe(false);
      expect(parseBuildErrorDiagnostic(line)).toBeNull();
    }
    expect(
      isBuildErrorDiagnosticLine('xcodebuild: error: invalid destination\n  available devices'),
    ).toBe(true);
    expect(parseBuildErrorDiagnostic('/tmp/Bridge.cpp:1:1: fatal error: missing.h')).toEqual({
      location: '/tmp/Bridge.cpp:1',
      message: 'missing.h',
      renderedLine: '/tmp/Bridge.cpp:1:1: fatal error: missing.h',
    });
  });

  it('does not classify Objective-C selector fragments or NSError dump lines as build errors', () => {
    const selectorLine = 'pid:error:,';
    const nserrorLine =
      '} (error = Error Domain=FBSOpenApplicationServiceErrorDomain Code=1 "The request was denied" UserInfo={BSErrorCodeDescription=RequestDenied, SimCallingSelector=launchApplicationWithID:options:pid:error:, NSLocalizedDescription=The request was denied})';
    const nsMachLine =
      '} (error = Error Domain=NSMachErrorDomain Code=3 "No such process" UserInfo={NSLocalizedDescription=No such process})';

    for (const line of [selectorLine, nserrorLine, nsMachLine]) {
      expect(isBuildErrorDiagnosticLine(line)).toBe(false);
      expect(parseBuildErrorDiagnostic(line)).toBeNull();
    }
  });
});

describe('parseRawTestName', () => {
  it('normalizes module-prefixed slash test names', () => {
    expect(
      parseRawTestName('CalculatorAppTests.CalculatorAppTests/testCalculatorServiceFailure'),
    ).toEqual({
      suiteName: 'CalculatorAppTests',
      testName: 'testCalculatorServiceFailure',
    });
  });

  it('normalizes module-prefixed objective-c style test names', () => {
    expect(parseRawTestName('-[CalculatorAppTests.IntentionalFailureTests test]')).toEqual({
      suiteName: 'IntentionalFailureTests',
      testName: 'test',
    });
  });

  it('keeps multi-segment slash suite names for swift-testing output', () => {
    expect(parseRawTestName('TestLibTests/IntentionalFailureSuite/test')).toEqual({
      suiteName: 'TestLibTests/IntentionalFailureSuite',
      testName: 'test',
    });
  });

  it('keeps display names ending in a period as test names', () => {
    expect(parseRawTestName('Decimal point at start creates 0.')).toEqual({
      testName: 'Decimal point at start creates 0.',
    });
  });
});
