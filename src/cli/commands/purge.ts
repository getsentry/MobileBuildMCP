import type { Argv } from 'yargs';
import {
  PURGE_STORAGE_DELETABLE_CLASSES,
  enumeratePurgeStorage,
  executePurgeStoragePlan,
  planPurgeStorage,
  type PurgeStorageDeletableClass,
  type PurgeStoragePlan,
  type PurgeStorageScope,
} from '../../utils/purge-storage.ts';
import { createPrompter, isInteractiveTTY, type Prompter } from '../interactive/prompts.ts';
import {
  defaultClassKeys,
  executionToJson,
  planToJson,
  renderExecutionText,
  renderPlanText,
  renderReportText,
  reportToJson,
} from './purge-ui.ts';
import { runInteractivePurge } from './purge-interactive.ts';

const DELETE_CONFIRMATION = 'delete-mobilebuildmcp-storage';
const DAY_MS = 24 * 60 * 60 * 1000;

type PurgeMode = 'report' | 'dry-run' | 'delete' | 'interactive';
type CliScope = 'current' | 'workspace' | 'family' | 'all';

export interface PurgeCommandDependencies {
  currentWorkspaceKey: string;
  prompter?: Prompter;
  isTTY?: boolean;
  now?: number;
  write?: (text: string) => void;
}

export interface PurgeCommandArguments {
  report?: boolean;
  dryRun?: boolean;
  delete?: boolean;
  scope?: CliScope;
  workspaceKey?: string;
  family?: string;
  classes?: string | string[];
  olderThan?: string;
  confirm?: string;
  json?: boolean;
}

function writeJson(write: (text: string) => void, value: object): void {
  write(`${JSON.stringify(value, null, 2)}\n`);
}

function determineMode(args: PurgeCommandArguments, isTTY: boolean): PurgeMode {
  const selected = [args.report, args.dryRun, args.delete].filter(Boolean).length;
  if (selected > 1) {
    throw new Error('Choose only one purge mode: --report, --dry-run, or --delete.');
  }
  if (args.report) return 'report';
  if (args.dryRun) return 'dry-run';
  if (args.delete) return 'delete';
  return isTTY && !args.json ? 'interactive' : 'report';
}

function suppliedModeSpecificFlagNames(args: PurgeCommandArguments): string[] {
  const supplied: string[] = [];
  if (args.scope !== undefined) supplied.push('--scope');
  if (args.workspaceKey !== undefined) supplied.push('--workspace-key');
  if (args.family !== undefined) supplied.push('--family');
  if (args.classes !== undefined) supplied.push('--classes');
  if (args.olderThan !== undefined) supplied.push('--older-than');
  if (args.confirm !== undefined) supplied.push('--confirm');
  return supplied;
}

function validateModeSpecificArgs(mode: PurgeMode, args: PurgeCommandArguments): void {
  const explicitMode = args.report === true || args.dryRun === true || args.delete === true;
  const suppliedFlags = suppliedModeSpecificFlagNames(args);
  if (mode === 'interactive') {
    if (!explicitMode && suppliedFlags.length > 0) {
      throw new Error(
        `Purge flags require an explicit mode: --report, --dry-run, or --delete. Supplied: ${suppliedFlags.join(', ')}.`,
      );
    }
    return;
  }

  if (mode === 'report') {
    if (args.classes !== undefined) {
      throw new Error('--report cannot be combined with --classes.');
    }
    if (args.olderThan !== undefined) {
      throw new Error('--report cannot be combined with --older-than.');
    }
    if (args.confirm !== undefined) {
      throw new Error('--report cannot be combined with --confirm.');
    }
    return;
  }

  if (mode === 'dry-run' && args.confirm !== undefined) {
    throw new Error('--dry-run cannot be combined with --confirm.');
  }
}

function parseOlderThan(value: string | undefined): number | undefined {
  if (value == null || value.trim().length === 0) {
    return undefined;
  }

  const match = value.trim().match(/^(\d+)\s*d$/u);
  if (!match) {
    throw new Error('--older-than must use a day value such as 1d, 7d, 14d, or 30d.');
  }

  const days = Number(match[1]);
  if (!Number.isSafeInteger(days) || days <= 0) {
    throw new Error('--older-than must be a positive day value.');
  }
  return days * DAY_MS;
}

function parseClasses(value: string | string[] | undefined): {
  classes: PurgeStorageDeletableClass[];
  explicit: boolean;
} {
  if (value == null) {
    return { classes: defaultClassKeys(), explicit: false };
  }

  const rawValues = (Array.isArray(value) ? value : [value])
    .flatMap((entry) => entry.split(','))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (rawValues.length === 0) {
    throw new Error('--classes must include at least one storage class.');
  }

  const validClasses = new Set<string>(PURGE_STORAGE_DELETABLE_CLASSES);
  const parsed: PurgeStorageDeletableClass[] = [];
  for (const rawValue of rawValues) {
    if (rawValue === 'all') {
      parsed.push(...defaultClassKeys());
      continue;
    }
    if (!validClasses.has(rawValue)) {
      throw new Error(
        `Unknown purge storage class '${rawValue}'. Use one of: ${PURGE_STORAGE_DELETABLE_CLASSES.join(', ')}.`,
      );
    }
    parsed.push(rawValue as PurgeStorageDeletableClass);
  }

  return { classes: Array.from(new Set(parsed)), explicit: true };
}

function normalizedScopeValue(value: string | undefined, flagName: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${flagName} must not be empty.`);
  }
  return trimmed;
}

function resolveScope(args: PurgeCommandArguments, currentWorkspaceKey: string): PurgeStorageScope {
  const workspaceKey = normalizedScopeValue(args.workspaceKey, '--workspace-key');
  const family = normalizedScopeValue(args.family, '--family');

  if (args.scope === 'current' && (workspaceKey !== undefined || family !== undefined)) {
    throw new Error('--scope current cannot be combined with --workspace-key or --family.');
  }

  if (args.scope === 'workspace' && family !== undefined) {
    throw new Error('--scope workspace cannot be combined with --family.');
  }

  if (args.scope === 'all') {
    if (workspaceKey !== undefined || family !== undefined) {
      throw new Error('--scope all cannot be combined with --workspace-key or --family.');
    }
    return { type: 'all' };
  }

  if (args.scope === 'family' || family !== undefined) {
    if (family === undefined) {
      throw new Error('--scope family requires --family <basename-prefix>.');
    }
    if (workspaceKey !== undefined) {
      throw new Error('--family cannot be combined with --workspace-key.');
    }
    return { type: 'family', family };
  }

  if (args.scope === 'workspace' || workspaceKey !== undefined) {
    return { type: 'workspace', workspaceKey: workspaceKey ?? currentWorkspaceKey };
  }

  if (args.scope === 'current') {
    return { type: 'workspace', workspaceKey: currentWorkspaceKey };
  }

  return { type: 'all' };
}

function resolvePlanningScope(
  args: PurgeCommandArguments,
  currentWorkspaceKey: string,
): PurgeStorageScope {
  if (args.scope == null && args.workspaceKey == null && args.family == null) {
    return { type: 'workspace', workspaceKey: currentWorkspaceKey };
  }
  return resolveScope(args, currentWorkspaceKey);
}

function validateDelete(args: PurgeCommandArguments, classesWereExplicit: boolean): void {
  if (args.confirm !== DELETE_CONFIRMATION) {
    throw new Error(`Destructive purge requires --confirm ${DELETE_CONFIRMATION}.`);
  }
  if (!classesWereExplicit) {
    throw new Error('Destructive purge requires explicit --classes.');
  }
}

interface ResolvedPlanOptions {
  scope: PurgeStorageScope;
  classes: PurgeStorageDeletableClass[];
  olderThanMs?: number;
  derivedDataExplicit: boolean;
  classesWereExplicit: boolean;
}

function planOptionsForArgs(
  args: PurgeCommandArguments,
  currentWorkspaceKey: string,
): ResolvedPlanOptions {
  const parsedClasses = parseClasses(args.classes);
  const scope = resolvePlanningScope(args, currentWorkspaceKey);
  return {
    scope,
    classes: parsedClasses.classes,
    olderThanMs: parseOlderThan(args.olderThan),
    derivedDataExplicit: parsedClasses.classes.includes('derivedData') && parsedClasses.explicit,
    classesWereExplicit: parsedClasses.explicit,
  };
}

async function buildPlan(options: ResolvedPlanOptions, now: number): Promise<PurgeStoragePlan> {
  return planPurgeStorage({
    scope: options.scope,
    classes: options.classes,
    now,
    olderThanMs: options.olderThanMs,
    derivedDataExplicit: options.derivedDataExplicit,
  });
}

export async function runPurgeCommand(
  args: PurgeCommandArguments,
  deps: PurgeCommandDependencies,
): Promise<void> {
  const resolvedDeps: Required<PurgeCommandDependencies> = {
    currentWorkspaceKey: deps.currentWorkspaceKey,
    prompter: deps.prompter ?? createPrompter(),
    isTTY: deps.isTTY ?? isInteractiveTTY(),
    now: deps.now ?? Date.now(),
    write: deps.write ?? ((text): void => void process.stdout.write(text)),
  };

  const mode = determineMode(args, resolvedDeps.isTTY);
  validateModeSpecificArgs(mode, args);
  if (mode === 'interactive') {
    await runInteractivePurge(resolvedDeps);
    return;
  }

  if (mode === 'report') {
    const selectedScope = resolvePlanningScope(args, resolvedDeps.currentWorkspaceKey);
    const report = await enumeratePurgeStorage({
      now: resolvedDeps.now,
      scope: selectedScope,
    });
    if (args.json) {
      writeJson(resolvedDeps.write, reportToJson(report, selectedScope));
    } else {
      resolvedDeps.write(renderReportText(report, resolvedDeps.currentWorkspaceKey, selectedScope));
    }
    return;
  }

  const planArgs = planOptionsForArgs(args, resolvedDeps.currentWorkspaceKey);
  if (mode === 'delete') {
    validateDelete(args, planArgs.classesWereExplicit);
  }

  const plan = await buildPlan(planArgs, resolvedDeps.now);
  if (mode === 'dry-run') {
    if (args.json) {
      writeJson(resolvedDeps.write, planToJson(plan));
    } else {
      resolvedDeps.write(renderPlanText(plan));
    }
    return;
  }

  const result = await executePurgeStoragePlan(plan, { now: resolvedDeps.now });
  if (args.json) {
    writeJson(resolvedDeps.write, executionToJson(result));
  } else {
    resolvedDeps.write(renderExecutionText(result));
  }
}

export function registerPurgeCommand(app: Argv, opts: { currentWorkspaceKey: string }): void {
  app.command(
    'purge',
    'Report and clean MobileBuildMCP workspace storage',
    (yargs) =>
      yargs
        .option('report', {
          type: 'boolean',
          describe: 'Report storage usage without planning or deleting',
        })
        .option('dry-run', {
          type: 'boolean',
          describe: 'Plan purge candidates without deleting anything',
        })
        .option('delete', {
          type: 'boolean',
          describe: 'Delete planned purge candidates',
        })
        .option('scope', {
          type: 'string',
          choices: ['current', 'workspace', 'family', 'all'] as const,
          describe: 'Storage scope to report, plan, or delete',
        })
        .option('workspace-key', {
          type: 'string',
          describe: 'Explicit workspace key for --scope workspace',
        })
        .option('family', {
          type: 'string',
          describe: 'Workspace family basename prefix for --scope family',
        })
        .option('classes', {
          type: 'string',
          describe:
            'Comma-separated storage classes: derivedData,logs,resultBundles,testProducts,stateTransients. "all" excludes DerivedData.',
        })
        .option('older-than', {
          type: 'string',
          describe: 'Only purge entries older than a day value such as 1d, 7d, 14d, or 30d',
        })
        .option('confirm', {
          type: 'string',
          describe: `Required for --delete: ${DELETE_CONFIRMATION}`,
        })
        .option('json', {
          type: 'boolean',
          default: false,
          describe: 'Output deterministic JSON',
        }),
    async (argv) => {
      await runPurgeCommand(
        {
          report: argv.report as boolean | undefined,
          dryRun: argv.dryRun as boolean | undefined,
          delete: argv.delete as boolean | undefined,
          scope: argv.scope as CliScope | undefined,
          workspaceKey: argv.workspaceKey as string | undefined,
          family: argv.family as string | undefined,
          classes: argv.classes as string | undefined,
          olderThan: argv.olderThan as string | undefined,
          confirm: argv.confirm as string | undefined,
          json: argv.json as boolean | undefined,
        },
        { currentWorkspaceKey: opts.currentWorkspaceKey },
      );
    },
  );
}
