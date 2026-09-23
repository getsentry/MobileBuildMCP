import type { Argv } from 'yargs';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as clack from '@clack/prompts';
import { getResourceRoot } from '../../core/resource-root.ts';
import { createPrompter, isInteractiveTTY, type Prompter } from '../interactive/prompts.ts';
import { resolvePathFromCwd } from '../../utils/path.ts';

type SkillType = 'mcp' | 'cli';

interface ClientInfo {
  name: string;
  id: string;
  skillsDir: string;
}

const CLIENT_DEFINITIONS: { id: string; name: string; skillsSubdir: string }[] = [
  { id: 'claude', name: 'Claude Code', skillsSubdir: '.claude/skills' },
  { id: 'agents', name: 'Agents Skills', skillsSubdir: '.agents/skills' },
];

const AGENTS_FILE_NAME = 'AGENTS.md';
const AGENTS_LEGACY_GUIDANCE_LINE =
  '- If using MobileBuildMCP, first find and read the installed MobileBuildMCP skill before calling MobileBuildMCP tools.';
const AGENTS_GUIDANCE_LINE =
  '- If using MobileBuildMCP, use the installed MobileBuildMCP skill before calling MobileBuildMCP tools.';

function writeLine(text: string): void {
  process.stdout.write(`${text}\n`);
}

function skillDirName(skillType: SkillType): string {
  return skillType === 'mcp' ? 'mobilebuildmcp' : 'mobilebuildmcp-cli';
}

function altSkillDirName(skillType: SkillType): string {
  return skillType === 'mcp' ? 'mobilebuildmcp-cli' : 'mobilebuildmcp';
}

function skillDisplayName(skillType: SkillType): string {
  return skillType === 'mcp' ? 'MobileBuildMCP (MCP server)' : 'MobileBuildMCP CLI';
}

function detectClients(): ClientInfo[] {
  const home = os.homedir();
  const detected: ClientInfo[] = [];

  for (const def of CLIENT_DEFINITIONS) {
    const clientDir = path.join(home, def.skillsSubdir.split('/')[0]);
    if (fs.existsSync(clientDir)) {
      detected.push({
        name: def.name,
        id: def.id,
        skillsDir: path.join(home, def.skillsSubdir),
      });
    }
  }

  return detected;
}

function getSkillSourcePath(skillType: SkillType): string {
  const resourceRoot = getResourceRoot();
  return path.join(resourceRoot, 'skills', skillDirName(skillType), 'SKILL.md');
}

function readSkillContent(skillType: SkillType): string {
  const sourcePath = getSkillSourcePath(skillType);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Skill source not found: ${sourcePath}`);
  }
  return fs.readFileSync(sourcePath, 'utf8');
}

async function promptConfirm(question: string): Promise<boolean> {
  if (!isInteractiveTTY()) {
    return false;
  }

  const result = await clack.confirm({
    message: question,
    initialValue: false,
  });

  if (clack.isCancel(result)) {
    clack.cancel('Operation cancelled.');
    return false;
  }

  return result;
}

interface InstallResult {
  client: string;
  location: string;
}

interface InstallPolicyResult {
  allowedTargets: ClientInfo[];
  skippedClients: Array<{ client: string; reason: string }>;
}

function formatSkippedClients(skippedClients: Array<{ client: string; reason: string }>): string {
  if (skippedClients.length === 0) {
    return '';
  }

  return skippedClients.map((skipped) => `${skipped.client}: ${skipped.reason}`).join('; ');
}

type AgentsGuidanceStatus = 'created' | 'updated' | 'no_change' | 'skipped' | 'error';

interface InitReport {
  action: 'install' | 'uninstall';
  skillType?: SkillType;
  installed?: InstallResult[];
  removed?: Array<{ client: string; variant: string; path: string }>;
  skipped?: Array<{ client: string; reason: string }>;
  agentsGuidance?: {
    status: AgentsGuidanceStatus;
    path: string;
    error?: string;
  };
  message: string;
}

async function installSkill(
  skillsDir: string,
  clientName: string,
  skillType: SkillType,
  opts: { force: boolean; removeConflict: boolean },
): Promise<InstallResult> {
  const targetDir = path.join(skillsDir, skillDirName(skillType));
  const altDir = path.join(skillsDir, altSkillDirName(skillType));
  const targetFile = path.join(targetDir, 'SKILL.md');
  const content = readSkillContent(skillType);

  if (fs.existsSync(altDir)) {
    if (opts.removeConflict) {
      fs.rmSync(altDir, { recursive: true, force: true });
    } else {
      const altType = skillType === 'mcp' ? 'cli' : 'mcp';
      if (!isInteractiveTTY()) {
        throw new Error(
          `Installing ${skillDisplayName(skillType)} but conflicting ${altType} skill found in ${skillsDir}. ` +
            `Use --remove-conflict to auto-remove it, or uninstall the ${altType} skill first.`,
        );
      }

      const confirmed = await promptConfirm(
        `Installing ${skillDisplayName(skillType)} but a conflicting ${altType} skill exists in ${skillsDir}. Remove it?`,
      );
      if (!confirmed) {
        throw new Error('Installation cancelled due to conflicting skill.');
      }
      fs.rmSync(altDir, { recursive: true, force: true });
    }
  }

  if (fs.existsSync(targetFile) && !opts.force) {
    if (!isInteractiveTTY()) {
      throw new Error(`Skill already installed at ${targetFile}. Use --force to overwrite.`);
    }

    const confirmed = await promptConfirm(`Skill already installed at ${targetFile}. Overwrite?`);
    if (!confirmed) {
      throw new Error('Installation cancelled.');
    }
  }

  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(targetFile, content, 'utf8');

  return { client: clientName, location: targetFile };
}

function uninstallSkill(
  skillsDir: string,
  clientName: string,
): { client: string; removed: Array<{ variant: string; path: string }> } | null {
  const removed: Array<{ variant: string; path: string }> = [];
  for (const variant of ['mobilebuildmcp', 'mobilebuildmcp-cli']) {
    const dir = path.join(skillsDir, variant);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push({ variant, path: dir });
    }
  }

  if (removed.length === 0) {
    return null;
  }

  return { client: clientName, removed };
}

function resolveTargets(
  clientFlag: string | undefined,
  destFlag: string | undefined,
  operation: 'install' | 'uninstall',
): ClientInfo[] {
  if (destFlag) {
    const resolvedDest = resolvePathFromCwd(destFlag);
    if (resolvedDest === path.parse(resolvedDest).root) {
      throw new Error(
        'Refusing to use filesystem root as skills destination. Use a dedicated directory.',
      );
    }
    return [{ name: 'Custom', id: 'custom', skillsDir: resolvedDest }];
  }

  if (clientFlag && clientFlag !== 'auto') {
    const def = CLIENT_DEFINITIONS.find((d) => d.id === clientFlag);
    if (!def) {
      throw new Error(`Unknown client: ${clientFlag}. Valid clients: claude, agents`);
    }
    const home = os.homedir();
    return [{ name: def.name, id: def.id, skillsDir: path.join(home, def.skillsSubdir) }];
  }

  const detected = detectClients();
  if (detected.length === 0) {
    if (operation === 'uninstall') {
      return [];
    }

    throw new Error(
      'No supported AI clients detected.\n' +
        'Use --client to specify a client, --dest to specify a custom path, or --print to output the skill content.',
    );
  }
  return detected;
}

function renderAgentsAppendDiff(fileName: string): string {
  return `--- ${fileName}\n+++ ${fileName}\n@@\n+${AGENTS_GUIDANCE_LINE}`;
}

async function ensureAgentsGuidance(
  projectRoot: string,
  force: boolean,
  emitOutput: boolean,
): Promise<'created' | 'updated' | 'no_change' | 'skipped'> {
  const agentsPath = path.join(projectRoot, AGENTS_FILE_NAME);
  if (!fs.existsSync(agentsPath)) {
    const newContent = `# ${AGENTS_FILE_NAME}\n\n${AGENTS_GUIDANCE_LINE}\n`;
    fs.writeFileSync(agentsPath, newContent, 'utf8');
    if (emitOutput) {
      writeLine(`Created ${AGENTS_FILE_NAME} with MobileBuildMCP guidance at ${agentsPath}`);
    }
    return 'created';
  }

  const currentContent = fs.readFileSync(agentsPath, 'utf8');
  if (currentContent.includes(AGENTS_GUIDANCE_LINE)) {
    if (emitOutput) {
      writeLine(`${AGENTS_FILE_NAME} already includes MobileBuildMCP guidance.`);
    }
    return 'no_change';
  }

  if (currentContent.includes(AGENTS_LEGACY_GUIDANCE_LINE)) {
    const updatedFromLegacy = currentContent.replace(
      AGENTS_LEGACY_GUIDANCE_LINE,
      AGENTS_GUIDANCE_LINE,
    );
    fs.writeFileSync(agentsPath, updatedFromLegacy, 'utf8');
    if (emitOutput) {
      writeLine(`Updated ${AGENTS_FILE_NAME} at ${agentsPath}`);
    }
    return 'updated';
  }

  const diff = renderAgentsAppendDiff(AGENTS_FILE_NAME);
  if (emitOutput) {
    writeLine(`Proposed update for ${agentsPath}:`);
    writeLine(diff);
  }

  if (!force) {
    if (!isInteractiveTTY()) {
      throw new Error(
        `${AGENTS_FILE_NAME} exists and requires confirmation to update. Re-run with --force to apply the change in non-interactive mode.`,
      );
    }

    const confirmed = await promptConfirm(`Update ${AGENTS_FILE_NAME} with the guidance above?`);
    if (!confirmed) {
      if (emitOutput) {
        writeLine(`Skipped updating ${AGENTS_FILE_NAME}.`);
      }
      return 'skipped';
    }
  }

  const updatedContent = currentContent.endsWith('\n')
    ? `${currentContent}${AGENTS_GUIDANCE_LINE}\n`
    : `${currentContent}\n${AGENTS_GUIDANCE_LINE}\n`;

  fs.writeFileSync(agentsPath, updatedContent, 'utf8');
  if (emitOutput) {
    writeLine(`Updated ${AGENTS_FILE_NAME} at ${agentsPath}`);
  }
  return 'updated';
}

const CUSTOM_PATH_SENTINEL = '__custom__';

interface InitSelection {
  skillType: SkillType;
  targets: ClientInfo[];
  selectionMode: 'flags_or_dest' | 'interactive';
}

async function collectInitSelection(
  argv: { skill?: string; client?: string; dest?: string },
  prompter: Prompter,
): Promise<InitSelection> {
  const destProvided = argv.dest !== undefined;

  const interactive = isInteractiveTTY();

  let skillType: SkillType;
  if (argv.skill !== undefined) {
    skillType = argv.skill as SkillType;
  } else if (interactive) {
    skillType = await prompter.selectOne<SkillType>({
      message: 'Which skill variant to install?',
      options: [
        {
          value: 'cli',
          label: 'MobileBuildMCP CLI',
          description: 'Recommended for most users',
        },
        {
          value: 'mcp',
          label: 'MobileBuildMCP MCP Server',
          description: 'For MCP server usage',
        },
      ],
      initialIndex: 0,
    });
  } else {
    skillType = 'cli';
  }

  if (destProvided) {
    const resolvedDest = resolvePathFromCwd(argv.dest!);
    if (resolvedDest === path.parse(resolvedDest).root) {
      throw new Error(
        'Refusing to use filesystem root as skills destination. Use a dedicated directory.',
      );
    }
    return {
      skillType,
      targets: [{ name: 'Custom', id: 'custom', skillsDir: resolvedDest }],
      selectionMode: 'flags_or_dest',
    };
  }

  if (argv.client !== undefined) {
    const targets = resolveTargets(argv.client, undefined, 'install');
    return { skillType, targets, selectionMode: 'flags_or_dest' };
  }

  if (!interactive) {
    throw new Error(
      'Non-interactive mode requires --client or --dest for init. Use --print to output the skill content without installing.',
    );
  }

  const home = os.homedir();
  const detected = detectClients();
  const detectedIds = new Set(detected.map((c) => c.id));

  const options: { value: string; label: string; description?: string }[] = [];
  for (const def of CLIENT_DEFINITIONS) {
    const isDetected = detectedIds.has(def.id);
    const dir = path.join(home, def.skillsSubdir);
    options.push({
      value: def.id,
      label: `${def.name}${isDetected ? ' (detected)' : ''}`,
      description: dir,
    });
  }
  options.push({
    value: CUSTOM_PATH_SENTINEL,
    label: 'Custom path...',
    description: 'Enter a custom directory path',
  });

  const selected = await prompter.selectMany<string>({
    message: 'Where should the skill be installed?',
    options,
    initialSelectedKeys: detectedIds,
    getKey: (value) => value,
    minSelected: 1,
  });

  const targets: ClientInfo[] = [];
  for (const id of selected) {
    if (id === CUSTOM_PATH_SENTINEL) {
      const customPath = await promptCustomPath();
      targets.push({ name: 'Custom', id: 'custom', skillsDir: customPath });
    } else {
      const def = CLIENT_DEFINITIONS.find((d) => d.id === id);
      if (!def) {
        throw new Error(`Unknown client target: ${id}`);
      }
      targets.push({
        name: def.name,
        id: def.id,
        skillsDir: path.join(home, def.skillsSubdir),
      });
    }
  }

  return { skillType, targets, selectionMode: 'interactive' };
}

async function promptCustomPath(): Promise<string> {
  if (!isInteractiveTTY()) {
    throw new Error('Cannot prompt for custom path in non-interactive mode. Use --dest instead.');
  }

  const result = await clack.text({
    message: 'Enter the destination directory path:',
    validate: (value: string | undefined) => {
      if (!value?.trim()) return 'Path cannot be empty.';
      const resolved = resolvePathFromCwd(value);
      if (resolved === path.parse(resolved).root) {
        return 'Refusing to use filesystem root. Use a dedicated directory.';
      }
      return undefined;
    },
  });

  if (clack.isCancel(result)) {
    clack.cancel('Operation cancelled.');
    throw new Error('Operation cancelled.');
  }

  return resolvePathFromCwd(result as string);
}

export function registerInitCommand(app: Argv, ctx?: { workspaceRoot: string }): void {
  app.command(
    'init',
    'Install MobileBuildMCP agent skill',
    (yargs) => {
      return yargs
        .option('client', {
          type: 'string',
          describe: 'Target client: claude, agents (default: auto-detect)',
          choices: ['auto', 'claude', 'agents'] as const,
        })
        .option('skill', {
          type: 'string',
          describe: 'Skill variant: mcp or cli (default: cli)',
          choices: ['mcp', 'cli'] as const,
        })
        .option('dest', {
          type: 'string',
          describe: 'Custom destination directory (overrides --client)',
        })
        .option('force', {
          type: 'boolean',
          default: false,
          describe: 'Replace existing skill without prompting',
        })
        .option('remove-conflict', {
          type: 'boolean',
          default: false,
          describe: 'Auto-remove conflicting skill variant',
        })
        .option('uninstall', {
          type: 'boolean',
          default: false,
          describe: 'Remove the installed skill',
        })
        .option('print', {
          type: 'boolean',
          default: false,
          describe: 'Print the skill content to stdout instead of installing',
        });
    },
    async (argv) => {
      if (argv.print) {
        const content = readSkillContent((argv.skill as SkillType | undefined) ?? 'cli');
        process.stdout.write(content);
        return;
      }

      const isTTY = isInteractiveTTY();
      const clientFlag = argv.client as string | undefined;
      const destFlag = argv.dest as string | undefined;

      if (argv.uninstall) {
        if (isTTY) {
          clack.intro('MobileBuildMCP Init');
          clack.log.info('Removing MobileBuildMCP agent skills from detected AI clients.');
        }

        const targets = resolveTargets(clientFlag ?? 'auto', destFlag, 'uninstall');
        const removedEntries: Array<{ client: string; variant: string; path: string }> = [];

        for (const target of targets) {
          const result = uninstallSkill(target.skillsDir, target.name);
          if (!result) {
            continue;
          }

          for (const removed of result.removed) {
            removedEntries.push({
              client: result.client,
              variant: removed.variant,
              path: removed.path,
            });
          }
        }

        const report: InitReport = {
          action: 'uninstall',
          removed: removedEntries,
          message:
            removedEntries.length > 0
              ? 'Uninstalled skill directories'
              : 'No installed skill directories found to remove.',
        };

        if (isTTY) {
          if (removedEntries.length > 0) {
            clack.log.step(report.message);
            for (const removed of removedEntries) {
              clack.log.message(
                `  Client: ${removed.client}\n  Removed (${removed.variant}): ${removed.path}`,
              );
            }
          } else {
            clack.log.info(report.message);
          }
          clack.outro('Done.');
        } else {
          process.stdout.write(`${JSON.stringify(report)}\n`);
        }

        return;
      }

      if (isTTY) {
        clack.intro('MobileBuildMCP Init');
        clack.log.info(
          'Install the MobileBuildMCP agent skill to your AI coding clients.\n' +
            'The skill teaches your AI assistant how to use MobileBuildMCP\n' +
            'effectively for building, testing, and debugging your apps.',
        );
      }

      const prompter = createPrompter();
      const selection = await collectInitSelection(
        {
          skill: argv.skill as string | undefined,
          client: argv.client as string | undefined,
          dest: argv.dest as string | undefined,
        },
        prompter,
      );

      const policy = enforceInstallPolicy(
        selection.targets,
        selection.skillType,
        clientFlag,
        destFlag,
        selection.selectionMode,
      );

      if (policy.allowedTargets.length === 0) {
        for (const skipped of policy.skippedClients) {
          writeLine(`Skipped ${skipped.client}: ${skipped.reason}`);
        }
        const skippedSummary = formatSkippedClients(policy.skippedClients);
        const reasonSuffix = skippedSummary.length > 0 ? ` Skipped: ${skippedSummary}` : '';
        throw new Error(`No eligible install targets after applying skill policy.${reasonSuffix}`);
      }

      const results: InstallResult[] = [];
      for (const target of policy.allowedTargets) {
        const result = await installSkill(target.skillsDir, target.name, selection.skillType, {
          force: argv.force as boolean,
          removeConflict: argv['remove-conflict'] as boolean,
        });
        results.push(result);
      }

      let agentsGuidanceStatus: AgentsGuidanceStatus | undefined;
      let agentsGuidancePath: string | undefined;
      let agentsGuidanceError: string | undefined;
      if (!isTTY && ctx?.workspaceRoot) {
        const projectRoot = path.resolve(ctx.workspaceRoot);
        agentsGuidancePath = path.join(projectRoot, AGENTS_FILE_NAME);
        try {
          agentsGuidanceStatus = await ensureAgentsGuidance(
            projectRoot,
            argv.force as boolean,
            false,
          );
        } catch (error) {
          agentsGuidanceStatus = 'error';
          agentsGuidanceError = error instanceof Error ? error.message : String(error);
        }
      }

      const agentsGuidance =
        agentsGuidanceStatus && agentsGuidancePath
          ? { status: agentsGuidanceStatus, path: agentsGuidancePath, error: agentsGuidanceError }
          : undefined;

      const report: InitReport = {
        action: 'install',
        skillType: selection.skillType,
        installed: results,
        skipped: policy.skippedClients,
        ...(agentsGuidance ? { agentsGuidance } : {}),
        message: `Installed ${skillDisplayName(selection.skillType)} skill`,
      };

      if (isTTY) {
        for (const skipped of report.skipped ?? []) {
          clack.log.info(`Skipped ${skipped.client}: ${skipped.reason}`);
        }
        clack.log.success(report.message);
        for (const result of results) {
          clack.log.message(`  Client: ${result.client}\n  Location: ${result.location}`);
        }
        clack.outro('Done.');
      } else {
        process.stdout.write(`${JSON.stringify(report)}\n`);
      }

      if (agentsGuidanceStatus === 'error' && agentsGuidanceError) {
        throw new Error(agentsGuidanceError);
      }

      if (ctx?.workspaceRoot && isTTY) {
        const projectRoot = path.resolve(ctx.workspaceRoot);
        await ensureAgentsGuidance(projectRoot, argv.force as boolean, true);
      }
    },
  );
}

function enforceInstallPolicy(
  targets: ClientInfo[],
  skillType: SkillType,
  clientFlag: string | undefined,
  destFlag: string | undefined,
  selectionMode: InitSelection['selectionMode'],
): InstallPolicyResult {
  const skipPolicy =
    skillType !== 'mcp' ||
    destFlag != null ||
    clientFlag === 'claude' ||
    selectionMode === 'interactive';

  if (skipPolicy) {
    return { allowedTargets: targets, skippedClients: [] };
  }

  const allowedTargets: ClientInfo[] = [];
  const skippedClients: Array<{ client: string; reason: string }> = [];

  for (const target of targets) {
    if (target.id === 'claude') {
      skippedClients.push({
        client: target.name,
        reason: 'MCP skill is unnecessary because Claude Code already uses server instructions.',
      });
      continue;
    }
    allowedTargets.push(target);
  }

  return { allowedTargets, skippedClients };
}
