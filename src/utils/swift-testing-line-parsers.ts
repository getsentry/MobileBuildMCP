import {
  type ParsedTestCase,
  type ParsedFailureDiagnostic,
  type ParsedTotals,
  parseRawTestName,
} from './xcodebuild-line-parsers.ts';

// Test name: quoted display name ("Name") or bare function name (name(), name(x:))
// Optional verbose suffix: (aka 'funcName()')
// Optional parameterized suffix: with N test cases
const TEST_NAME = `(?:"(.+)"|([^\\s"]\\S*))`;
const OPTIONAL_AKA = `(?:\\s*\\(aka '[^']*'\\))?`;
const OPTIONAL_PARAMETERIZED = `(?:\\s+with (\\d+) test cases?)?`;

/**
 * Parse a Swift Testing result line (passed/failed/skipped).
 *
 * Matches (non-verbose and verbose):
 *   ✔ Test "Name" passed after 0.001 seconds.
 *   ✔ Test "Name" (aka 'func()') passed after 0.001 seconds.
 *   ✔ Test "Name" with 3 test cases passed after 0.001 seconds.
 *   ✘ Test "Name" failed after 0.001 seconds with 1 issue.
 *   ✘ Test "Name" (aka 'func()') failed after 0.001 seconds with 1 issue.
 *   ✔ Test funcName() passed after 0.001 seconds.
 *   ✘ Test funcName(x:) with 3 test cases failed after 0.001 seconds with 1 issue.
 *   ➜ Test funcName() skipped: "reason"
 *   ➜ Test "Name" skipped: "reason"
 *   ➜ Test funcName() skipped
 */
export function parseSwiftTestingResultLine(line: string): ParsedTestCase | null {
  const passedRegex = new RegExp(
    `^[✔] Test ${TEST_NAME}${OPTIONAL_AKA}${OPTIONAL_PARAMETERIZED} passed after ([\\d.]+) seconds\\.?$`,
    'u',
  );
  const passedMatch = line.match(passedRegex);
  if (passedMatch) {
    const [, quotedName, bareName, caseCountStr, duration] = passedMatch;
    const name = quotedName ?? bareName;
    const { suiteName, testName } = parseRawTestName(name);
    const caseCount = caseCountStr ? Number(caseCountStr) : undefined;
    return {
      status: 'passed',
      rawName: name,
      suiteName,
      testName,
      durationText: `${duration}s`,
      ...(caseCount !== undefined && { caseCount }),
    };
  }

  const failedRegex = new RegExp(
    `^[✘] Test ${TEST_NAME}${OPTIONAL_AKA}${OPTIONAL_PARAMETERIZED} failed after ([\\d.]+) seconds`,
    'u',
  );
  const failedMatch = line.match(failedRegex);
  if (failedMatch) {
    const [, quotedName, bareName, caseCountStr, duration] = failedMatch;
    const name = quotedName ?? bareName;
    const { suiteName, testName } = parseRawTestName(name);
    const caseCount = caseCountStr ? Number(caseCountStr) : undefined;
    return {
      status: 'failed',
      rawName: name,
      suiteName,
      testName,
      durationText: `${duration}s`,
      ...(caseCount !== undefined && { caseCount }),
    };
  }

  // Skipped: ➜ Test funcName() skipped: "reason" or ➜ Test "Name" skipped: "reason"
  // Also handle legacy format: ◇ Test "Name" skipped
  const skippedMatch =
    line.match(/^[➜] Test "(.+?)" skipped/u) ??
    line.match(/^[➜] Test (\S+?)(?:\(\))? skipped/u) ??
    line.match(/^[◇] Test "(.+)" skipped/u);
  if (skippedMatch) {
    const rawName = skippedMatch[1];
    const { suiteName, testName } = parseRawTestName(rawName);
    return {
      status: 'skipped',
      rawName,
      suiteName,
      testName,
    };
  }

  return null;
}

/**
 * Parse a Swift Testing issue line.
 *
 * Matches (non-verbose and verbose, including parameterized):
 *   ✘ Test "Name" recorded an issue at File.swift:48:5: Expectation failed: ...
 *   ✘ Test "Name" (aka 'func()') recorded an issue at File.swift:48:5: msg
 *   ✘ Test "Name" recorded an issue with 1 argument value → 0 at File.swift:10:5: msg
 *   ✘ Test "Name" recorded an issue: message
 *   ✘ Test funcName() recorded an issue at File.swift:48:5: msg
 *   ✘ Test funcName(x:) recorded an issue with 1 argument x → 2 at File.swift:10:5: msg
 */
export function parseSwiftTestingIssueLine(line: string): ParsedFailureDiagnostic | null {
  // Match with location -- handle both aka suffix and parameterized argument values before "at"
  const locationRegex = new RegExp(
    `^[✘] Test ${TEST_NAME}${OPTIONAL_AKA} recorded an issue(?:\\s+with \\d+ arguments?\\b.*?)? at (.+?):(\\d+):\\d+: (.+)$`,
    'u',
  );
  const locationMatch = line.match(locationRegex);
  if (locationMatch) {
    const [, quotedName, bareName, filePath, lineNumber, message] = locationMatch;
    const rawTestName = quotedName ?? bareName;
    const { suiteName, testName } = parseRawTestName(rawTestName);
    return {
      rawTestName,
      suiteName,
      testName,
      location: `${filePath}:${lineNumber}`,
      message,
    };
  }

  // Match without location
  const simpleRegex = new RegExp(
    `^[✘] Test ${TEST_NAME}${OPTIONAL_AKA} recorded an issue: (.+)$`,
    'u',
  );
  const simpleMatch = line.match(simpleRegex);
  if (simpleMatch) {
    const [, quotedName, bareName, message] = simpleMatch;
    const rawTestName = quotedName ?? bareName;
    const { suiteName, testName } = parseRawTestName(rawTestName);
    return {
      rawTestName,
      suiteName,
      testName,
      message,
    };
  }

  const fallbackRegex = new RegExp(
    `^[✘] Test ${TEST_NAME}${OPTIONAL_AKA} recorded an issue\\b.*$`,
    'u',
  );
  const fallbackMatch = line.match(fallbackRegex);
  if (fallbackMatch) {
    const [, quotedName, bareName] = fallbackMatch;
    const rawTestName = quotedName ?? bareName;
    const { suiteName, testName } = parseRawTestName(rawTestName);
    return {
      rawTestName,
      suiteName,
      testName,
      message: line,
    };
  }

  return null;
}

/**
 * Parse a Swift Testing run summary line.
 *
 * Matches:
 *   ✔ Test run with 6 tests in 2 suites passed after 0.001 seconds.
 *   ✘ Test run with 6 tests in 0 suites failed after 0.001 seconds with 1 issue.
 */
export function parseSwiftTestingRunSummary(line: string): ParsedTotals | null {
  const match = line.match(
    /^[✔✘] Test run with (\d+) tests? in \d+ suites? (?:passed|failed) after ([\d.]+) seconds/u,
  );
  if (!match) {
    return null;
  }

  const total = Number(match[1]);
  const displayDurationText = `${match[2]}s`;

  // Swift Testing reports "issues" not "failed tests" -- a single test can produce
  // multiple issues (e.g. multiple #expect failures). This is the best available
  // approximation; the framework doesn't report a distinct failed-test count in its
  // summary line. Downstream reconciliation via Math.max(failedTests, testFailures.length)
  // partially mitigates overcounting.
  const issueMatch = line.match(/with (\d+) issues?/u);
  const failed = issueMatch ? Number(issueMatch[1]) : 0;

  return { executed: total, failed, displayDurationText };
}

/**
 * Parse a Swift Testing continuation line (additional context for an issue).
 *
 * Matches:
 *   ↳ This test should fail...
 */
export function parseSwiftTestingContinuationLine(line: string): string | null {
  const match = line.match(/^↳ (.+)$/u);
  return match ? match[1] : null;
}
