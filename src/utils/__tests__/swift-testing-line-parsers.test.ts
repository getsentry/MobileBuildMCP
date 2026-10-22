import { describe, it, expect } from 'vitest';
import {
  parseSwiftTestingResultLine,
  parseSwiftTestingIssueLine,
  parseSwiftTestingRunSummary,
  parseSwiftTestingContinuationLine,
} from '../swift-testing-line-parsers.ts';

describe('Swift Testing line parsers', () => {
  describe('parseSwiftTestingResultLine', () => {
    it('should parse a passed test', () => {
      const result = parseSwiftTestingResultLine(
        '✔ Test "Basic math operations" passed after 0.001 seconds.',
      );
      expect(result).toEqual({
        status: 'passed',
        rawName: 'Basic math operations',
        testName: 'Basic math operations',
        durationText: '0.001s',
      });
    });

    it('should parse a passed test with verbose aka suffix', () => {
      const result = parseSwiftTestingResultLine(
        '✔ Test "String operations" (aka \'stringTest()\') passed after 0.001 seconds.',
      );
      expect(result).toEqual({
        status: 'passed',
        rawName: 'String operations',
        testName: 'String operations',
        durationText: '0.001s',
      });
    });

    it('should parse a passed parameterized test with case count', () => {
      const result = parseSwiftTestingResultLine(
        '✔ Test "Parameterized test" with 3 test cases passed after 0.001 seconds.',
      );
      expect(result).toEqual({
        status: 'passed',
        rawName: 'Parameterized test',
        testName: 'Parameterized test',
        durationText: '0.001s',
        caseCount: 3,
      });
    });

    it('should parse a failed parameterized test with case count', () => {
      const result = parseSwiftTestingResultLine(
        '✘ Test "Parameterized failure" with 3 test cases failed after 0.001 seconds with 1 issue.',
      );
      expect(result).toEqual({
        status: 'failed',
        rawName: 'Parameterized failure',
        testName: 'Parameterized failure',
        durationText: '0.001s',
        caseCount: 3,
      });
    });

    it('should parse a failed test', () => {
      const result = parseSwiftTestingResultLine(
        '✘ Test "Expected failure" failed after 0.001 seconds with 1 issue.',
      );
      expect(result).toEqual({
        status: 'failed',
        rawName: 'Expected failure',
        testName: 'Expected failure',
        durationText: '0.001s',
      });
    });

    it('should parse a failed test with verbose aka suffix', () => {
      const result = parseSwiftTestingResultLine(
        '✘ Test "Expected failure" (aka \'deliberateFailure()\') failed after 0.001 seconds with 1 issue.',
      );
      expect(result).toEqual({
        status: 'failed',
        rawName: 'Expected failure',
        testName: 'Expected failure',
        durationText: '0.001s',
      });
    });

    it('should parse a skipped test (arrow format)', () => {
      const result = parseSwiftTestingResultLine('➜ Test disabledTest() skipped: "Not ready yet"');
      expect(result).toEqual({
        status: 'skipped',
        rawName: 'disabledTest',
        testName: 'disabledTest',
      });
    });

    it('should parse a skipped test (legacy diamond format)', () => {
      const result = parseSwiftTestingResultLine('◇ Test "Disabled test" skipped.');
      expect(result).toEqual({
        status: 'skipped',
        rawName: 'Disabled test',
        testName: 'Disabled test',
      });
    });

    it('should parse a skipped test without reason', () => {
      const result = parseSwiftTestingResultLine('➜ Test disabledTest skipped');
      expect(result).toEqual({
        status: 'skipped',
        rawName: 'disabledTest',
        testName: 'disabledTest',
      });
    });

    it('should parse a passed test without a display name', () => {
      const result = parseSwiftTestingResultLine('✔ Test passes() passed after 0.001 seconds.');
      expect(result).toEqual({
        status: 'passed',
        rawName: 'passes()',
        testName: 'passes()',
        durationText: '0.001s',
      });
    });

    it('should parse a failed test without a display name', () => {
      const result = parseSwiftTestingResultLine(
        '✘ Test fails() failed after 0.004 seconds with 3 issues.',
      );
      expect(result).toEqual({
        status: 'failed',
        rawName: 'fails()',
        testName: 'fails()',
        durationText: '0.004s',
      });
    });

    it('should parse a failed parameterized test without a display name', () => {
      const result = parseSwiftTestingResultLine(
        '✘ Test param(x:) with 3 test cases failed after 0.004 seconds with 1 issue.',
      );
      expect(result).toEqual({
        status: 'failed',
        rawName: 'param(x:)',
        testName: 'param(x:)',
        durationText: '0.004s',
        caseCount: 3,
      });
    });

    it('should parse a skipped test with a display name (arrow format)', () => {
      const result = parseSwiftTestingResultLine(
        '➜ Test "Skipped with display name" skipped: "later"',
      );
      expect(result).toEqual({
        status: 'skipped',
        rawName: 'Skipped with display name',
        testName: 'Skipped with display name',
      });
    });

    it('should not parse run summary lines as test results', () => {
      expect(
        parseSwiftTestingResultLine(
          '✔ Test run with 6 tests in 1 suite passed after 0.005 seconds.',
        ),
      ).toBeNull();
      expect(
        parseSwiftTestingResultLine(
          '✘ Test run with 6 tests in 1 suite failed after 0.005 seconds with 5 issues.',
        ),
      ).toBeNull();
    });

    it('should return null for non-matching lines', () => {
      expect(parseSwiftTestingResultLine('◇ Test "Foo" started.')).toBeNull();
      expect(parseSwiftTestingResultLine('random text')).toBeNull();
    });
  });

  describe('parseSwiftTestingIssueLine', () => {
    it('should parse an issue with location', () => {
      const result = parseSwiftTestingIssueLine(
        '✘ Test "Expected failure" recorded an issue at SimpleTests.swift:48:5: Expectation failed: true == false',
      );
      expect(result).toEqual({
        rawTestName: 'Expected failure',
        testName: 'Expected failure',
        location: 'SimpleTests.swift:48',
        message: 'Expectation failed: true == false',
      });
    });

    it('should parse an issue with verbose aka suffix', () => {
      const result = parseSwiftTestingIssueLine(
        '✘ Test "Expected failure" (aka \'deliberateFailure()\') recorded an issue at AuditTests.swift:5:5: Expectation failed: true == false',
      );
      expect(result).toEqual({
        rawTestName: 'Expected failure',
        testName: 'Expected failure',
        location: 'AuditTests.swift:5',
        message: 'Expectation failed: true == false',
      });
    });

    it('should parse a parameterized issue with argument values', () => {
      const result = parseSwiftTestingIssueLine(
        '✘ Test "Parameterized failure" recorded an issue with 1 argument value → 0 at ParameterizedTests.swift:10:5: Expectation failed: (value → 0) > 0',
      );
      expect(result).toEqual({
        rawTestName: 'Parameterized failure',
        testName: 'Parameterized failure',
        location: 'ParameterizedTests.swift:10',
        message: 'Expectation failed: (value → 0) > 0',
      });
    });

    it('should parse a parameterized issue with colon in argument value', () => {
      const result = parseSwiftTestingIssueLine(
        '✘ Test "Dict test" recorded an issue with 1 argument value → key:value at DictTests.swift:5:3: failed',
      );
      expect(result).toEqual({
        rawTestName: 'Dict test',
        testName: 'Dict test',
        location: 'DictTests.swift:5',
        message: 'failed',
      });
    });

    it('should parse an issue for a test without a display name', () => {
      const result = parseSwiftTestingIssueLine(
        '✘ Test fails() recorded an issue at CountsTests.swift:6:24: Expectation failed: (one() → 1) == 2',
      );
      expect(result).toEqual({
        rawTestName: 'fails()',
        testName: 'fails()',
        location: 'CountsTests.swift:6',
        message: 'Expectation failed: (one() → 1) == 2',
      });
    });

    it('should parse a parameterized issue for a test without a display name', () => {
      const result = parseSwiftTestingIssueLine(
        '✘ Test param(x:) recorded an issue with 1 argument x → 2 at CountsTests.swift:10:52: Expectation failed: (x → 2) != 2',
      );
      expect(result).toEqual({
        rawTestName: 'param(x:)',
        testName: 'param(x:)',
        location: 'CountsTests.swift:10',
        message: 'Expectation failed: (x → 2) != 2',
      });
    });

    it('should parse an issue without location', () => {
      const result = parseSwiftTestingIssueLine(
        '✘ Test "Some test" recorded an issue: Something went wrong',
      );
      expect(result).toEqual({
        rawTestName: 'Some test',
        testName: 'Some test',
        message: 'Something went wrong',
      });
    });

    it('should parse an issue without location with verbose aka suffix', () => {
      const result = parseSwiftTestingIssueLine(
        '✘ Test "Some test" (aka \'someFunc()\') recorded an issue: Something went wrong',
      );
      expect(result).toEqual({
        rawTestName: 'Some test',
        testName: 'Some test',
        message: 'Something went wrong',
      });
    });

    it('preserves the full raw line when an issue line has an unknown shape', () => {
      const line =
        '✘ Test "Parameterized failure" recorded an issue with 1 argument value → key:value: opaque failure';

      expect(parseSwiftTestingIssueLine(line)).toEqual({
        rawTestName: 'Parameterized failure',
        testName: 'Parameterized failure',
        message: line,
      });
    });

    it('should return null for non-matching lines', () => {
      expect(parseSwiftTestingIssueLine('✘ Test "Foo" failed after 0.001 seconds')).toBeNull();
    });
  });

  describe('parseSwiftTestingRunSummary', () => {
    it('should parse a failed run summary', () => {
      const result = parseSwiftTestingRunSummary(
        '✘ Test run with 6 tests in 0 suites failed after 0.001 seconds with 1 issue.',
      );
      expect(result).toEqual({
        executed: 6,
        failed: 1,
        displayDurationText: '0.001s',
      });
    });

    it('should parse a passed run summary', () => {
      const result = parseSwiftTestingRunSummary(
        '✔ Test run with 5 tests in 2 suites passed after 0.003 seconds.',
      );
      expect(result).toEqual({
        executed: 5,
        failed: 0,
        displayDurationText: '0.003s',
      });
    });

    it('should parse a summary with singular suite', () => {
      const result = parseSwiftTestingRunSummary(
        '✘ Test run with 5 tests in 1 suite failed after 0.001 seconds with 3 issues.',
      );
      expect(result).toEqual({
        executed: 5,
        failed: 3,
        displayDurationText: '0.001s',
      });
    });

    it('should return null for non-matching lines', () => {
      expect(parseSwiftTestingRunSummary('random text')).toBeNull();
    });
  });

  describe('parseSwiftTestingContinuationLine', () => {
    it('should parse a continuation line', () => {
      expect(parseSwiftTestingContinuationLine('↳ This test should fail')).toBe(
        'This test should fail',
      );
    });

    it('should parse a continuation with version info', () => {
      expect(parseSwiftTestingContinuationLine('↳ Testing Library Version: 1743')).toBe(
        'Testing Library Version: 1743',
      );
    });

    it('should return null for non-continuation lines', () => {
      expect(parseSwiftTestingContinuationLine('regular line')).toBeNull();
    });
  });
});
