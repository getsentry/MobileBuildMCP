import { displayPath } from '../../utils/build-preflight.ts';
import {
  PURGE_STORAGE_DELETABLE_CLASSES,
  type PurgeStorageClass,
  type PurgeStorageDeletableClass,
  type PurgeStorageExecutionResult,
  type PurgeStoragePlan,
  type PurgeStorageReport,
  type PurgeStorageScope,
  type PurgeWorkspaceSummary,
} from '../../utils/purge-storage.ts';

const CLASS_LABELS: Record<PurgeStorageClass, string> = {
  derivedData: 'DerivedData',
  logs: 'Logs',
  resultBundles: 'Result bundles',
  testProducts: 'Test products',
  stateTransients: 'State transients',
  locks: 'Locks',
};

const BAR_WIDTH = 18;

export const SKIPPED_FOR_SAFETY_HINT =
  'Some paths were skipped for safety. Run `mobilebuildmcp purge --report --json` for diagnostics.';

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ['KB', 'MB', 'GB', 'TB'] as const;
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[unitIndex]}`;
}

export function storageClassLabel(storageClass: PurgeStorageClass): string {
  return CLASS_LABELS[storageClass];
}

export function renderInteractiveOverview(
  groups: Array<{ name: string; bytes: number; workspaces: readonly unknown[] }>,
  warningsCount: number,
): string {
  const totalBytes = groups.reduce((total, group) => total + group.bytes, 0);
  const workspaceCount = groups.reduce((total, group) => total + group.workspaces.length, 0);
  let output = 'MobileBuildMCP storage\n\n';
  output += `Purgeable: ${formatBytes(totalBytes)} across ${groups.length} projects / ${workspaceCount} workspaces\n`;
  if (groups.length > 0) {
    output += '\nLargest projects:\n';
    for (const group of groups.slice(0, 5)) {
      output += `  ${group.name}  ${formatBytes(group.bytes)}  ${group.workspaces.length} workspace${group.workspaces.length === 1 ? '' : 's'}\n`;
    }
  }
  if (warningsCount > 0) {
    output += `\nNote: ${SKIPPED_FOR_SAFETY_HINT}\n`;
  }
  output += '\n';
  return output;
}

export function scopeLabel(scope: PurgeStorageScope): string {
  switch (scope.type) {
    case 'all':
      return 'all recognized workspaces';
    case 'family':
      return `family ${scope.family}`;
    case 'workspace':
      return `workspace ${scope.workspaceKey}`;
    case 'workspaces':
      return `${scope.workspaceKeys.length} selected workspaces`;
  }
}

function usageBar(bytes: number, maxBytes: number): string {
  if (maxBytes <= 0) {
    return `[${'-'.repeat(BAR_WIDTH)}]`;
  }

  const filled = Math.max(1, Math.round((bytes / maxBytes) * BAR_WIDTH));
  return `[${'#'.repeat(filled)}${'-'.repeat(BAR_WIDTH - filled)}]`;
}

function line(parts: string[]): string {
  return `${parts.join('  ')}\n`;
}

function warningMarker(workspace: PurgeWorkspaceSummary): string {
  if (!workspace.recognized) {
    return 'unknown key';
  }
  if (workspace.warnings.length > 0) {
    return 'warnings';
  }
  return '';
}

const ABSOLUTE_PATH_PATTERN = /\/[^\s'":]+/g;

function displayWarning(warning: string): string {
  return warning.replace(ABSOLUTE_PATH_PATTERN, (match) => displayPath(match));
}

function renderWarningsSection(warnings: string[]): string {
  if (warnings.length === 0) {
    return '';
  }
  return `\nWarnings:\n${warnings.map((warning) => `- ${displayWarning(warning)}`).join('\n')}\n`;
}

export function renderWorkspaceUsage(
  report: PurgeStorageReport,
  currentWorkspaceKey: string,
): string {
  const maxBytes = Math.max(0, ...report.workspaces.map((workspace) => workspace.totals.bytes));
  const rows = [...report.workspaces].sort((left, right) => {
    if (left.workspaceKey === currentWorkspaceKey) return -1;
    if (right.workspaceKey === currentWorkspaceKey) return 1;
    return right.totals.bytes - left.totals.bytes;
  });

  let output = line(['Workspace', 'Family', 'Size', 'Usage', 'Notes']);
  output += line(['---------', '------', '----', '-----', '-----']);
  for (const workspace of rows) {
    const name =
      workspace.workspaceKey === currentWorkspaceKey
        ? `${workspace.workspaceKey} (current)`
        : workspace.workspaceKey;
    output += line([
      name,
      workspace.family ?? '-',
      formatBytes(workspace.totals.bytes).padStart(9),
      usageBar(workspace.totals.bytes, maxBytes),
      warningMarker(workspace),
    ]);
  }
  return output;
}

export function renderFamilyUsage(report: PurgeStorageReport): string {
  if (report.families.length === 0) {
    return 'No recognized workspace families found.\n';
  }

  const maxBytes = Math.max(0, ...report.families.map((family) => family.bytes));
  let output = line(['Family', 'Workspaces', 'Size', 'Usage']);
  output += line(['------', '----------', '----', '-----']);
  for (const family of [...report.families].sort((left, right) => right.bytes - left.bytes)) {
    output += line([
      family.family,
      String(family.workspaceKeys.length).padStart(10),
      formatBytes(family.bytes).padStart(9),
      usageBar(family.bytes, maxBytes),
    ]);
  }
  return output;
}

export function renderClassUsage(
  workspaces: PurgeWorkspaceSummary[],
  classes: readonly PurgeStorageClass[],
): string {
  const totals = new Map<PurgeStorageClass, number>();
  for (const storageClass of classes) {
    totals.set(storageClass, 0);
  }

  for (const workspace of workspaces) {
    for (const storageClass of classes) {
      totals.set(
        storageClass,
        (totals.get(storageClass) ?? 0) + workspace.classes[storageClass].bytes,
      );
    }
  }

  const maxBytes = Math.max(0, ...Array.from(totals.values()));
  let output = line(['Class', 'Size', 'Usage']);
  output += line(['-----', '----', '-----']);
  for (const storageClass of classes) {
    const bytes = totals.get(storageClass) ?? 0;
    output += line([
      storageClassLabel(storageClass),
      formatBytes(bytes).padStart(9),
      usageBar(bytes, maxBytes),
    ]);
  }
  return output;
}

export function workspacesForScope(
  report: PurgeStorageReport,
  scope: PurgeStorageScope,
): PurgeWorkspaceSummary[] {
  switch (scope.type) {
    case 'all':
      return report.workspaces.filter((workspace) => workspace.recognized);
    case 'family':
      return report.workspaces.filter(
        (workspace) => workspace.recognized && workspace.family === scope.family,
      );
    case 'workspace':
      return report.workspaces.filter((workspace) => workspace.workspaceKey === scope.workspaceKey);
    case 'workspaces': {
      const workspaceKeys = new Set(scope.workspaceKeys);
      return report.workspaces.filter((workspace) => workspaceKeys.has(workspace.workspaceKey));
    }
  }
}

export function renderReportText(
  report: PurgeStorageReport,
  currentWorkspaceKey: string,
  selectedScope: PurgeStorageScope,
): string {
  const selectedWorkspaces = workspacesForScope(report, selectedScope);
  let output = 'MobileBuildMCP storage report\n';
  output += `App root: ${displayPath(report.appRoot)}\n`;
  output += `Total: ${formatBytes(report.totals.bytes)} (${report.totals.fileCount} files, ${report.totals.directoryCount} directories)\n`;
  output += `Selected scope: ${scopeLabel(selectedScope)} (${selectedWorkspaces.length} workspaces)\n\n`;
  output += 'Workspace usage:\n';
  output += renderWorkspaceUsage(report, currentWorkspaceKey);
  output += '\nFamily usage:\n';
  output += renderFamilyUsage(report);
  output += '\nSelected scope by class:\n';
  output += renderClassUsage(selectedWorkspaces, PURGE_STORAGE_DELETABLE_CLASSES);
  output += renderWarningsSection(report.warnings);

  return output;
}

export function renderPlanText(plan: PurgeStoragePlan): string {
  let output = 'Purge dry run\n';
  output += `Scope: ${scopeLabel(plan.scope)}\n`;
  output += `Classes: ${plan.classes.map(storageClassLabel).join(', ')}\n`;
  output += `Candidates: ${plan.totals.candidateCount}\n`;
  output += `Reclaimable: ${formatBytes(plan.totals.bytes)} (${plan.totals.fileCount} files, ${plan.totals.directoryCount} directories)\n`;
  if (plan.skipped.length > 0) {
    output += `Skipped: ${plan.skipped.length}\n`;
  }
  if (plan.candidates.length > 0) {
    output += '\nCandidates:\n';
    for (const candidate of plan.candidates.slice(0, 20)) {
      output += `- ${storageClassLabel(candidate.storageClass)} ${formatBytes(candidate.bytes)} ${displayPath(candidate.path)}\n`;
    }
    if (plan.candidates.length > 20) {
      output += `- ... ${plan.candidates.length - 20} more\n`;
    }
  }
  output += renderWarningsSection(plan.warnings);
  return output;
}

export function renderExecutionText(result: PurgeStorageExecutionResult): string {
  let output = 'Purge delete result\n';
  output += `Scope: ${scopeLabel(result.scope)}\n`;
  output += `Classes: ${result.classes.map(storageClassLabel).join(', ')}\n`;
  output += `Deleted: ${result.totals.deletedCount}\n`;
  output += `Freed: ${formatBytes(result.totals.bytes)}\n`;
  output += `Skipped: ${result.totals.skippedCount}\n`;
  output += renderWarningsSection(result.warnings);
  return output;
}

function jsonWorkspace(workspace: PurgeWorkspaceSummary): object {
  return {
    workspaceKey: workspace.workspaceKey,
    path: displayPath(workspace.path),
    recognized: workspace.recognized,
    family: workspace.family,
    hash: workspace.hash,
    totals: workspace.totals,
    classes: Object.fromEntries(
      Object.entries(workspace.classes).map(([storageClass, census]) => [
        storageClass,
        {
          ...census,
          path: displayPath(census.path),
          warnings: census.warnings.map(displayWarning),
        },
      ]),
    ),
    warnings: workspace.warnings.map(displayWarning),
  };
}

export function reportToJson(report: PurgeStorageReport, selectedScope: PurgeStorageScope): object {
  return {
    action: 'report',
    deletionHappened: false,
    appRoot: displayPath(report.appRoot),
    workspacesDir: displayPath(report.workspacesDir),
    selectedScope,
    totals: report.totals,
    families: report.families,
    workspaces: report.workspaces.map(jsonWorkspace),
    warnings: report.warnings.map(displayWarning),
  };
}

export function planToJson(plan: PurgeStoragePlan): object {
  return {
    action: 'dry-run',
    deletionHappened: false,
    selectedScope: plan.scope,
    classes: plan.classes,
    selectedWorkspaceKeys: plan.selectedWorkspaceKeys,
    totals: plan.totals,
    candidates: plan.candidates.map((candidate) => ({
      ...candidate,
      path: displayPath(candidate.path),
      sidecarPaths: candidate.sidecarPaths.map(displayPath),
    })),
    skipped: plan.skipped.map((candidate) => ({
      ...candidate,
      path: displayPath(candidate.path),
      reason: displayWarning(candidate.reason),
    })),
    warnings: plan.warnings.map(displayWarning),
    report: reportToJson(plan.report, plan.scope),
  };
}

export function executionToJson(result: PurgeStorageExecutionResult): object {
  return {
    action: 'delete',
    deletionHappened: result.deleted.length > 0,
    selectedScope: result.scope,
    classes: result.classes,
    selectedWorkspaceKeys: result.selectedWorkspaceKeys,
    totals: result.totals,
    deleted: result.deleted.map((entry) => ({ ...entry, path: displayPath(entry.path) })),
    skipped: result.skipped.map((candidate) => ({
      ...candidate,
      path: displayPath(candidate.path),
      reason: displayWarning(candidate.reason),
    })),
    warnings: result.warnings.map(displayWarning),
  };
}

export function defaultClassKeys(): PurgeStorageDeletableClass[] {
  return ['logs', 'resultBundles', 'testProducts', 'stateTransients'];
}
