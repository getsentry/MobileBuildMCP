import type {
  PatternFailureRecord,
  ToolCallRecord,
  ToolFailureRecord,
  ToolAnalysisConfig,
  ToolMatcher,
  TranscriptAudit,
  FailurePatternTarget,
} from './types.ts';

const DEFAULT_UI_AUTOMATION_TOOLS = [
  'batch',
  'button',
  'drag',
  'gesture',
  'key_press',
  'key_sequence',
  'long_press',
  'screenshot',
  'snapshot_ui',
  'swipe',
  'tap',
  'touch',
  'type_text',
  'wait_for_ui',
];

interface AnalyzeOptions {
  mcpToolPrefix?: string;
  toolAnalysis?: ToolAnalysisConfig;
  failurePatterns?: string[];
  failurePatternTargets?: FailurePatternTarget[];
  ignoredFailurePatterns?: string[];
}

interface ToolClassification {
  shortName: string;
  isMcp: boolean;
  isUiAutomation: boolean;
  offset: number;
  matchLength: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function shortToolName(fullName: string): string {
  const parts = fullName.split('__');
  return parts[parts.length - 1] ?? fullName;
}

function defaultToolAnalysisConfig(mcpToolPrefix: string): ToolAnalysisConfig {
  return {
    matchers: [
      {
        kind: 'namePrefix',
        prefix: mcpToolPrefix,
        shortName: 'afterLastDoubleUnderscore',
        uiAutomationNames: DEFAULT_UI_AUTOMATION_TOOLS,
      },
    ],
  };
}

function incrementCount(counts: Record<string, number>, name: string): void {
  counts[name] = (counts[name] ?? 0) + 1;
}

function parseEmbeddedJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trimStart();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function stringifyContent(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value) ?? '';
}

function extractContentBlocks(entry: Record<string, unknown>): unknown[] {
  const message = entry.message;
  if (!isRecord(message)) return [];
  const content = message.content;
  if (Array.isArray(content)) return content;
  return [];
}

function extractStatus(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const data = value.data;
  if (!isRecord(data)) return undefined;
  const summary = data.summary;
  if (!isRecord(summary)) return undefined;
  return asString(summary.status);
}

function extractStructuredResult(
  block: Record<string, unknown>,
  entry: Record<string, unknown>,
): unknown {
  const direct = block.structuredContent;
  if (direct !== undefined) return direct;

  const content = parseEmbeddedJson(block.content);
  if (isRecord(content)) return content;

  const toolUseResult = entry.tool_use_result;
  if (isRecord(toolUseResult)) {
    if (toolUseResult.structuredContent !== undefined) return toolUseResult.structuredContent;
    const parsed = parseEmbeddedJson(toolUseResult.content);
    if (isRecord(parsed)) return parsed;
  }

  return content;
}

function resultDidError(block: Record<string, unknown>, structured: unknown): boolean {
  if (block.is_error === true) return true;
  if (isRecord(structured)) {
    if (structured.didError === true) return true;
    const status = extractStatus(structured);
    if (status === 'FAILED') return true;
  }
  return false;
}

function createPatternMatchers(
  patterns: string[] | undefined,
): Array<{ pattern: string; regex: RegExp }> {
  return (patterns ?? []).map((pattern) => ({ pattern, regex: new RegExp(pattern, 'i') }));
}

function matchesAnyPattern(
  text: string,
  matchers: Array<{ pattern: string; regex: RegExp }>,
): boolean {
  return matchers.some((matcher) => matcher.regex.test(text));
}

function patternMatcherIsIgnored(
  matcher: { pattern: string },
  ignoredFailureMatchers: Array<{ pattern: string; regex: RegExp }>,
): boolean {
  return matchesAnyPattern(matcher.pattern, ignoredFailureMatchers);
}

function hasReportablePatternMatch(
  text: string,
  patternMatchers: Array<{ pattern: string; regex: RegExp }>,
  ignoredFailureMatchers: Array<{ pattern: string; regex: RegExp }>,
): boolean {
  return patternMatchers.some(
    (matcher) =>
      matcher.regex.test(text) && !patternMatcherIsIgnored(matcher, ignoredFailureMatchers),
  );
}

function appendPatternFailures(opts: {
  text: string;
  line: number;
  excerpt: string;
  patternMatchers: Array<{ pattern: string; regex: RegExp }>;
  ignoredFailureMatchers: Array<{ pattern: string; regex: RegExp }>;
  patternFailures: PatternFailureRecord[];
}): void {
  for (const matcher of opts.patternMatchers) {
    if (patternMatcherIsIgnored(matcher, opts.ignoredFailureMatchers)) continue;
    if (matcher.regex.test(opts.text)) {
      opts.patternFailures.push({
        pattern: matcher.pattern,
        line: opts.line,
        excerpt: opts.excerpt,
      });
    }
  }
}

function commandFromInput(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  return asString(input.command);
}

function classifyNamePrefixTool(
  fullName: string,
  matcher: Extract<ToolMatcher, { kind: 'namePrefix' }>,
): ToolClassification | undefined {
  if (!fullName.startsWith(matcher.prefix)) return undefined;

  let shortName: string;
  switch (matcher.shortName) {
    case 'afterPrefix':
      shortName = fullName.slice(matcher.prefix.length);
      break;
    case 'full':
      shortName = fullName;
      break;
    default:
      shortName = shortToolName(fullName);
      break;
  }

  return {
    shortName,
    isMcp: matcher.prefix.includes('__'),
    isUiAutomation: (matcher.uiAutomationNames ?? []).includes(shortName),
    offset: 0,
    matchLength: matcher.prefix.length,
  };
}

function commandPrefixMatchesAt(command: string, prefix: string, index: number): boolean {
  if (!command.startsWith(prefix, index)) return false;

  const before = command.slice(0, index).trimEnd();
  if (before.length > 0 && !/[;&|]$/.test(before)) return false;

  const next = command[index + prefix.length];
  return next === undefined || /\s/.test(next);
}

function commandPrefixOffsets(command: string, prefix: string): number[] {
  const offsets: number[] = [];
  let start = 0;
  while (start < command.length) {
    const index = command.indexOf(prefix, start);
    if (index === -1) break;
    if (commandPrefixMatchesAt(command, prefix, index)) offsets.push(index);
    start = index + prefix.length;
  }
  return offsets;
}

function classifyBashCommandTool(
  fullName: string,
  input: unknown,
  matcher: Extract<ToolMatcher, { kind: 'bashCommand' }>,
): ToolClassification[] {
  if (fullName !== 'Bash') return [];
  const command = commandFromInput(input);
  if (!command) return [];
  return commandPrefixOffsets(command, matcher.commandPrefix).map((offset) => ({
    shortName: matcher.shortName,
    isMcp: false,
    isUiAutomation: matcher.uiAutomation === true,
    offset,
    matchLength: matcher.commandPrefix.length,
  }));
}

function classifyToolUse(
  fullName: string,
  input: unknown,
  toolAnalysis: ToolAnalysisConfig,
): ToolClassification[] {
  const classifications: ToolClassification[] = [];
  for (const matcher of toolAnalysis.matchers) {
    if (matcher.kind === 'namePrefix') {
      const classification = classifyNamePrefixTool(fullName, matcher);
      if (classification) classifications.push(classification);
    }
    if (matcher.kind === 'bashCommand') {
      classifications.push(...classifyBashCommandTool(fullName, input, matcher));
    }
  }
  const mostSpecificByOffset = new Map<number, ToolClassification>();
  for (const classification of classifications) {
    const existing = mostSpecificByOffset.get(classification.offset);
    if (!existing || classification.matchLength > existing.matchLength) {
      mostSpecificByOffset.set(classification.offset, classification);
    }
  }
  return [...mostSpecificByOffset.values()].sort((left, right) => left.offset - right.offset);
}

export function analyzeClaudeJsonl(text: string, options: AnalyzeOptions): TranscriptAudit {
  const trackedToolsById = new Map<string, Array<ToolClassification & { fullName: string }>>();
  const parseErrors: string[] = [];
  const failures: ToolFailureRecord[] = [];
  const failureKeys = new Set<string>();
  const patternFailures: PatternFailureRecord[] = [];
  const trackedSequence: ToolCallRecord[] = [];
  const mcpSequence: ToolCallRecord[] = [];
  const totalToolCallsByName: Record<string, number> = {};
  const trackedToolCallsByName: Record<string, number> = {};
  const mcpToolCallsByName: Record<string, number> = {};
  const uiAutomationCallsByName: Record<string, number> = {};
  const patternMatchers = createPatternMatchers(options.failurePatterns);
  const ignoredFailureMatchers = createPatternMatchers(options.ignoredFailurePatterns);
  const failurePatternTargets = new Set<FailurePatternTarget>(
    options.failurePatternTargets ?? ['commands', 'toolResults'],
  );
  const toolAnalysis =
    options.toolAnalysis ??
    defaultToolAnalysisConfig(options.mcpToolPrefix ?? 'mcp__mobilebuildmcp-dev__');
  let records = 0;
  let claudeDurationSeconds = 0;
  let claudeApiDurationSeconds = 0;
  let finalText: string | undefined;
  let resultSummary: Record<string, unknown> | undefined;

  const lines = text.split(/\r?\n/);

  for (const [index, rawLine] of lines.entries()) {
    const line = index + 1;
    if (!rawLine.trim()) continue;

    let entry: unknown;
    try {
      entry = JSON.parse(rawLine) as unknown;
    } catch (error) {
      parseErrors.push(`line ${line}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    if (!isRecord(entry)) {
      parseErrors.push(`line ${line}: expected JSON object`);
      continue;
    }

    records += 1;
    claudeDurationSeconds += (asFiniteNumber(entry.duration_ms) ?? 0) / 1_000;
    claudeApiDurationSeconds += (asFiniteNumber(entry.duration_api_ms) ?? 0) / 1_000;
    const timestamp = asString(entry.timestamp);
    const entryType = asString(entry.type);
    const lineText = rawLine.length > 600 ? `${rawLine.slice(0, 600)}…` : rawLine;

    if (entryType === 'result') {
      resultSummary = entry;
      finalText = asString(entry.result) ?? finalText;
      if (entry.is_error === true) {
        failures.push({ line, message: finalText ?? 'Claude result reported an error' });
      }
      continue;
    }

    if (entryType === 'assistant') {
      for (const block of extractContentBlocks(entry)) {
        if (!isRecord(block)) continue;
        if (block.type === 'text') {
          finalText = asString(block.text) ?? finalText;
          continue;
        }
        if (block.type !== 'tool_use') continue;

        const fullName = asString(block.name);
        const id = asString(block.id);
        if (!fullName || !id) continue;

        const command = commandFromInput(block.input);
        if (command && failurePatternTargets.has('commands')) {
          appendPatternFailures({
            text: command,
            line,
            excerpt: command.length > 600 ? `${command.slice(0, 600)}…` : command,
            patternMatchers,
            ignoredFailureMatchers,
            patternFailures,
          });
        }

        incrementCount(totalToolCallsByName, fullName);

        const classifications = classifyToolUse(fullName, block.input, toolAnalysis);
        if (classifications.length === 0) continue;

        trackedToolsById.set(
          id,
          classifications.map((classification) => ({ ...classification, fullName })),
        );
        for (const classification of classifications) {
          incrementCount(trackedToolCallsByName, classification.shortName);
          const record: ToolCallRecord = {
            id,
            fullName,
            shortName: classification.shortName,
            input: block.input,
            line,
            timestamp,
            isTracked: true,
            isMcp: classification.isMcp,
            isUiAutomation: classification.isUiAutomation,
          };
          trackedSequence.push(record);

          if (classification.isMcp) {
            incrementCount(mcpToolCallsByName, classification.shortName);
            mcpSequence.push(record);
          }

          if (classification.isUiAutomation) {
            incrementCount(uiAutomationCallsByName, classification.shortName);
          }
        }
      }
      continue;
    }

    if (entryType === 'user') {
      for (const block of extractContentBlocks(entry)) {
        if (!isRecord(block) || block.type !== 'tool_result') continue;
        const id = asString(block.tool_use_id);
        const trackedTools = id ? trackedToolsById.get(id) : undefined;
        if (!trackedTools || trackedTools.length === 0) continue;

        const structured = extractStructuredResult(block, entry);
        const message = stringifyContent(block.content);
        if (failurePatternTargets.has('toolResults')) {
          appendPatternFailures({
            text: message,
            line,
            excerpt: message.length > 600 ? `${message.slice(0, 600)}…` : message,
            patternMatchers,
            ignoredFailureMatchers,
            patternFailures,
          });
        }
        if (!resultDidError(block, structured)) continue;

        if (
          matchesAnyPattern(message, ignoredFailureMatchers) &&
          !hasReportablePatternMatch(message, patternMatchers, ignoredFailureMatchers)
        ) {
          continue;
        }

        for (const trackedTool of trackedTools) {
          const failureKey = [id, trackedTool.fullName, trackedTool.shortName, line, message].join(
            '\0',
          );
          if (failureKeys.has(failureKey)) continue;
          failureKeys.add(failureKey);
          failures.push({
            id,
            fullName: trackedTool.fullName,
            shortName: trackedTool.shortName,
            line,
            message,
          });
        }
      }
    }
  }

  return {
    records,
    parseErrors,
    claudeDurationSeconds,
    claudeApiDurationSeconds,
    totalToolCalls: Object.values(totalToolCallsByName).reduce((sum, count) => sum + count, 0),
    totalToolCallsByName,
    trackedToolCalls: trackedSequence.length,
    trackedToolCallsByName,
    mcpToolCalls: mcpSequence.length,
    mcpToolCallsByName,
    uiAutomationCalls: Object.values(uiAutomationCallsByName).reduce(
      (sum, count) => sum + count,
      0,
    ),
    uiAutomationCallsByName,
    trackedSequence,
    mcpSequence,
    failures,
    patternFailures,
    finalText,
    resultSummary,
  };
}
