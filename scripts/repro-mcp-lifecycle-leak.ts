import { spawn } from 'node:child_process';
import process from 'node:process';

interface CliOptions {
  iterations: number;
  closeDelayMs: number;
  settleMs: number;
  shutdownMode: 'graceful-stdin' | 'parent-hard-exit';
}

interface PeerProcess {
  pid: number;
  ppid: number;
  ageSeconds: number;
  rssKb: number;
  command: string;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    iterations: 20,
    closeDelayMs: 0,
    settleMs: 2000,
    shutdownMode: 'parent-hard-exit',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    if (arg === '--iterations' && value) {
      options.iterations = Number(value);
      index += 1;
    } else if (arg === '--close-delay-ms' && value) {
      options.closeDelayMs = Number(value);
      index += 1;
    } else if (arg === '--settle-ms' && value) {
      options.settleMs = Number(value);
      index += 1;
    } else if (arg === '--shutdown-mode' && value) {
      if (value !== 'graceful-stdin' && value !== 'parent-hard-exit') {
        throw new Error('--shutdown-mode must be graceful-stdin or parent-hard-exit');
      }
      options.shutdownMode = value;
      index += 1;
    }
  }

  if (!Number.isFinite(options.iterations) || options.iterations < 1) {
    throw new Error('--iterations must be a positive number');
  }
  if (!Number.isFinite(options.closeDelayMs) || options.closeDelayMs < 0) {
    throw new Error('--close-delay-ms must be a non-negative number');
  }
  if (!Number.isFinite(options.settleMs) || options.settleMs < 0) {
    throw new Error('--settle-ms must be a non-negative number');
  }

  return options;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLikelyMcpCommand(command: string): boolean {
  const normalized = command.toLowerCase();
  return (
    /(^|\s)mcp(\s|$)/.test(normalized) &&
    !/(^|\s)daemon(\s|$)/.test(normalized) &&
    (normalized.includes('mobilebuildmcp') ||
      normalized.includes('build/cli.js') ||
      normalized.includes('/cli.js'))
  );
}

function parseElapsedSeconds(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const daySplit = trimmed.split('-');
  const timePart = daySplit.length === 2 ? daySplit[1] : daySplit[0];
  const dayCount = daySplit.length === 2 ? Number(daySplit[0]) : 0;
  const parts = timePart.split(':').map((part) => Number(part));

  if (!Number.isFinite(dayCount) || parts.some((part) => !Number.isFinite(part))) {
    return null;
  }

  if (parts.length === 1) {
    return dayCount * 86400 + parts[0];
  }
  if (parts.length === 2) {
    return dayCount * 86400 + parts[0] * 60 + parts[1];
  }
  if (parts.length === 3) {
    return dayCount * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2];
  }

  return null;
}

async function sampleMcpProcesses(): Promise<PeerProcess[]> {
  return new Promise((resolve, reject) => {
    const child = spawn('ps', ['-axo', 'pid=,ppid=,etime=,rss=,command='], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `ps exited with code ${code}`));
        return;
      }

      const processes = stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.+)$/);
          if (!match) {
            return null;
          }
          const ageSeconds = parseElapsedSeconds(match[3]);
          return {
            pid: Number(match[1]),
            ppid: Number(match[2]),
            ageSeconds,
            rssKb: Number(match[4]),
            command: match[5],
          };
        })
        .filter((entry): entry is PeerProcess => {
          return (
            entry !== null &&
            Number.isFinite(entry.pid) &&
            Number.isFinite(entry.ageSeconds) &&
            Number.isFinite(entry.rssKb) &&
            isLikelyMcpCommand(entry.command)
          );
        });

      resolve(processes);
    });
  });
}

interface IterationResult {
  helperExited: boolean;
  childExited: boolean;
  childPid: number | null;
}

async function runGracefulStdinIteration(closeDelayMs: number): Promise<IterationResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['build/cli.js', 'mcp'], {
      cwd: process.cwd(),
      stdio: ['pipe', 'ignore', 'ignore'],
    });

    let settled = false;
    const finish = (result: IterationResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    child.once('close', () => {
      finish({ helperExited: true, childExited: true, childPid: child.pid ?? null });
    });
    child.once('error', () => {
      finish({ helperExited: false, childExited: false, childPid: child.pid ?? null });
    });

    setTimeout(() => {
      child.stdin.end();
    }, closeDelayMs);

    setTimeout(
      () => {
        finish({ helperExited: false, childExited: false, childPid: child.pid ?? null });
      },
      Math.max(1000, closeDelayMs + 1000),
    );
  });
}

async function runParentHardExitIteration(closeDelayMs: number): Promise<IterationResult> {
  return new Promise((resolve) => {
    const helper = spawn(
      process.execPath,
      [
        'scripts/repro-mcp-parent-exit-helper.mjs',
        process.execPath,
        'build/cli.js',
        process.cwd(),
        String(closeDelayMs),
      ],
      {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let childPid: number | null = null;
    let settled = false;
    let stdout = '';

    const finish = (result: IterationResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    helper.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      const candidate = stdout.split('\n')[0]?.trim();
      if (candidate && /^\d+$/.test(candidate)) {
        childPid = Number(candidate);
      }
    });

    helper.once('error', () => {
      finish({ helperExited: false, childExited: false, childPid });
    });

    helper.once('close', (code) => {
      finish({ helperExited: code === 0, childExited: false, childPid });
    });

    setTimeout(
      () => {
        finish({ helperExited: false, childExited: false, childPid });
      },
      Math.max(1500, closeDelayMs + 1500),
    );
  });
}

async function runIteration(options: CliOptions): Promise<IterationResult> {
  if (options.shutdownMode === 'parent-hard-exit') {
    return runParentHardExitIteration(options.closeDelayMs);
  }

  return runGracefulStdinIteration(options.closeDelayMs);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const before = await sampleMcpProcesses();
  const baselinePids = new Set(before.map((entry) => entry.pid));

  let helperExitedCount = 0;
  let childExitedCount = 0;
  const spawnedChildPids = new Set<number>();

  for (let index = 0; index < options.iterations; index += 1) {
    const result = await runIteration(options);
    if (result.helperExited) {
      helperExitedCount += 1;
    }
    if (result.childExited) {
      childExitedCount += 1;
    }
    if (result.childPid !== null) {
      spawnedChildPids.add(result.childPid);
    }
  }

  await delay(options.settleMs);

  const after = await sampleMcpProcesses();
  const lingering = after.filter((entry) => !baselinePids.has(entry.pid));
  const lingeringSpawned = lingering.filter((entry) => spawnedChildPids.has(entry.pid));

  console.log(
    JSON.stringify(
      {
        shutdownMode: options.shutdownMode,
        iterations: options.iterations,
        helperExitedCount,
        childExitedCount,
        spawnedChildPidCount: spawnedChildPids.size,
        baselineProcessCount: before.length,
        finalProcessCount: after.length,
        lingeringProcessCount: lingering.length,
        lingeringSpawnedProcessCount: lingeringSpawned.length,
        lingeringSpawned: lingeringSpawned.map(({ pid, ppid, ageSeconds, rssKb, command }) => ({
          pid,
          ppid,
          ageSeconds,
          rssKb,
          command,
        })),
        lingering: lingering.map(({ pid, ppid, ageSeconds, rssKb, command }) => ({
          pid,
          ppid,
          ageSeconds,
          rssKb,
          command,
        })),
        orphanedLingeringCount: lingering.filter((entry) => entry.ppid === 1).length,
        maxLingeringRssKb: lingering.reduce((max, entry) => Math.max(max, entry.rssKb), 0),
      },
      null,
      2,
    ),
  );

  process.exit(lingeringSpawned.length === 0 ? 0 : 1);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
