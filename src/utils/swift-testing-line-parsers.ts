import {
  type ParsedTestCase,
  type ParsedFailureDiagnostic,
  type ParsedTotals,
  parseRawTestName,
} from './xcodebuild-line-parsers.ts';

// Optional verbose suffix: (aka 'funcName()')
// Optional parameterized suffix: with N test cases
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
 *   ➜ Test funcName() skipped: "reason"
 *   ➜ Test funcName() skipped
 */
export function parseSwiftTestingResultLine(line: string): ParsedTestCase | null {
  const passedRegex = new RegExp(
    `^[✔] Test "(.+)"${OPTIONAL_AKA}${OPTIONAL_PARAMETERIZED} passed after ([\\d.]+) seconds\\.?$`,
    'u',
  );
  const passedMatch = line.match(passedRegex);
  if (passedMatch) {
    const [, name, caseCountStr, duration] = passedMatch;
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
    `^[✘] Test "(.+)"${OPTIONAL_AKA}${OPTIONAL_PARAMETERIZED} failed after ([\\d.]+) seconds`,
    'u',
  );
  const failedMatch = line.match(failedRegex);
  if (failedMatch) {
    const [, name, caseCountStr, duration] = failedMatch;
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

  // Skipped: ➜ Test funcName() skipped: "reason"
  // Also handle legacy format: ◇ Test "Name" skipped
  const skippedMatch =
    line.match(/^[➜] Test (\S+?)(?:\(\))? skipped/u) ?? line.match(/^[◇] Test "(.+)" skipped/u);
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
 */
export function parseSwiftTestingIssueLine(line: string): ParsedFailureDiagnostic | null {
  // Match with location -- handle both aka suffix and parameterized argument values before "at"
  const locationRegex = new RegExp(
    `^[✘] Test "(.+)"${OPTIONAL_AKA} recorded an issue(?:\\s+with \\d+ argument values?.*?)? at (.+?):(\\d+):\\d+: (.+)$`,
    'u',
  );
  const locationMatch = line.match(locationRegex);
  if (locationMatch) {
    const [, rawTestName, filePath, lineNumber, message] = locationMatch;
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
  const simpleRegex = new RegExp(`^[✘] Test "(.+)"${OPTIONAL_AKA} recorded an issue: (.+)$`, 'u');
  const simpleMatch = line.match(simpleRegex);
  if (simpleMatch) {
    const [, rawTestName, message] = simpleMatch;
    const { suiteName, testName } = parseRawTestName(rawTestName);
    return {
      rawTestName,
      suiteName,
      testName,
      message,
    };
  }

  const fallbackRegex = new RegExp(`^[✘] Test "(.+)"${OPTIONAL_AKA} recorded an issue\\b.*$`, 'u');
  const fallbackMatch = line.match(fallbackRegex);
  if (fallbackMatch) {
    const [, rawTestName] = fallbackMatch;
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
  // summary line. The event parser subtracts issues already attributed to
  // individually reported failed tests before using this value.
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
