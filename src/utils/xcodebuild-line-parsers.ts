export const packageResolutionPatterns = [
  /^Resolve Package Graph$/u,
  /^Resolved source packages:/u,
  /^Fetching from /u,
  /^Checking out /u,
  /^Creating working copy /u,
  /^Updating https?:\/\//u,
];

export const compilePatterns = [
  /^CompileSwift /u,
  /^SwiftCompile /u,
  /^CompileC /u,
  /^ProcessInfoPlistFile /u,
  /^PhaseScriptExecution /u,
  /^CodeSign /u,
  /^CompileAssetCatalog /u,
  /^ProcessProductPackaging /u,
];

export const linkPatterns = [/^Ld /u];

export interface ParsedTestCase {
  status: 'passed' | 'failed' | 'skipped';
  rawName: string;
  suiteName?: string;
  testName: string;
  durationText?: string;
  caseCount?: number;
}

export interface ParsedTotals {
  executed: number;
  failed: number;
  displayDurationText?: string;
}

export interface ParsedFailureDiagnostic {
  rawTestName?: string;
  suiteName?: string;
  testName?: string;
  location?: string;
  message: string;
}

export interface ParsedBuildError {
  location?: string;
  message: string;
  renderedLine: string;
}

export interface ParsedBuildDiagnostic extends ParsedBuildError {
  severity: 'error' | 'warning' | 'note';
}

export function isBuildErrorDiagnosticLine(line: string): boolean {
  return parseBuildDiagnostic(line.trim().split(/\r?\n/u, 1)[0])?.severity === 'error';
}

function normalizeSuiteName(rawSuiteName: string): string {
  const parts = rawSuiteName.split('.').filter(Boolean);
  const normalized = parts.length >= 2 ? (parts.at(-1) ?? rawSuiteName) : rawSuiteName;
  return normalized.replaceAll('_', ' ');
}

export function parseRawTestName(rawName: string): { suiteName?: string; testName: string } {
  const objcMatch = rawName.match(/^-\[(.+?)\s+(.+)\]$/u);
  if (objcMatch) {
    return { suiteName: normalizeSuiteName(objcMatch[1]), testName: objcMatch[2] };
  }

  const slashParts = rawName.split('/').filter(Boolean);
  if (slashParts.length >= 3) {
    return { suiteName: slashParts.slice(0, -1).join('/'), testName: slashParts.at(-1)! };
  }

  if (slashParts.length === 2) {
    return {
      suiteName: normalizeSuiteName(slashParts[0]),
      testName: slashParts[1],
    };
  }

  const dotIndex = rawName.lastIndexOf('.');
  if (dotIndex > 0 && dotIndex < rawName.length - 1) {
    return { suiteName: rawName.slice(0, dotIndex), testName: rawName.slice(dotIndex + 1) };
  }

  return { testName: rawName };
}

export function parseTestCaseLine(line: string): ParsedTestCase | null {
  const match = line.match(
    /^Test [Cc]ase '(.+)' (passed|failed|skipped)(?: on '.+')? \(([^)]+)\)/u,
  );
  if (!match) {
    return null;
  }
  const [, rawName, status, durationText] = match;
  const { suiteName, testName } = parseRawTestName(rawName);
  return {
    status: status as 'passed' | 'failed' | 'skipped',
    rawName,
    suiteName,
    testName,
    durationText,
  };
}

export function parseTotalsLine(line: string): ParsedTotals | null {
  const match = line.match(
    /^Executed (\d+) tests?, with (\d+) failures?(?: \(\d+ unexpected\))? in (.+)$/u,
  );
  if (!match) {
    return null;
  }
  return { executed: Number(match[1]), failed: Number(match[2]), displayDurationText: match[3] };
}

export function parseFailureDiagnostic(line: string): ParsedFailureDiagnostic | null {
  const match = line.match(/^(.*?):(\d+): error: -\[(.+?)\s+(.+?)\] : (.+)$/u);
  if (!match) {
    return null;
  }
  const [, filePath, lineNumber, suiteName, testName, message] = match;
  return {
    rawTestName: `-[${suiteName} ${testName}]`,
    suiteName: normalizeSuiteName(suiteName),
    testName,
    location: lineNumber === '0' ? undefined : `${filePath}:${lineNumber}`,
    message: message.replace(/^failed\s*-\s*/u, ''),
  };
}

export function parseDurationMs(durationText?: string): number | undefined {
  if (!durationText) {
    return undefined;
  }

  const normalized = durationText.trim().replace(/\s+seconds?$/u, 's');
  const match = normalized.match(/^([\d.]+)s$/u);
  if (!match) {
    return undefined;
  }

  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds)) {
    return undefined;
  }

  return Math.round(seconds * 1000);
}

export function parseBuildDiagnostic(line: string): ParsedBuildDiagnostic | null {
  // numbered source and caret gutters are diagnostic context, not headers.
  if (/^\s*(?:\d+\s*)?\|/u.test(line)) {
    return null;
  }

  // located compiler diagnostics carry the severity before the message.
  const locationMatch = line.match(
    /^(.*?):(\d+)(?::\d+)?:\s+(fatal error|error|warning|note):\s+(.+)$/iu,
  );
  if (locationMatch) {
    const [, filePath, lineNumber, severity, message] = locationMatch;
    return {
      severity: normalizeSeverity(severity),
      location: `${filePath}:${lineNumber}`,
      message,
      renderedLine: line,
    };
  }

  // project paths and tool prefixes have no line number.
  const prefixedMatch = line.match(
    /^(?:(\/[^:]+|[\w.+-]+):\s+)?(fatal error|error|warning|note):\s+(.+)$/iu,
  );
  if (prefixedMatch) {
    const [, prefix, severity, message] = prefixedMatch;
    return {
      severity: normalizeSeverity(severity),
      ...(prefix?.startsWith('/') ? { location: prefix } : {}),
      message,
      renderedLine: line,
    };
  }

  // preserve timestamped tool diagnostics as raw messages.
  const timestampedMatch = line.match(
    /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+\s+[^\s[]+\[[^\]]+\]\s+(fatal error|error|warning|note):\s+\S.*$/iu,
  );
  if (timestampedMatch) {
    return {
      severity: normalizeSeverity(timestampedMatch[1]),
      message: line,
      renderedLine: line,
    };
  }

  return null;
}

function normalizeSeverity(severity: string): ParsedBuildDiagnostic['severity'] {
  const normalized = severity.toLowerCase();
  return normalized === 'warning' || normalized === 'note' ? normalized : 'error';
}

export function parseBuildErrorDiagnostic(line: string): ParsedBuildError | null {
  const diagnostic = parseBuildDiagnostic(line);
  if (diagnostic?.severity !== 'error') {
    return null;
  }

  const { severity: _severity, ...error } = diagnostic;
  return error;
}
