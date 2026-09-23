import type { InteractiveProcess, InteractiveSpawner } from '../../execution/index.ts';
import { getDefaultInteractiveSpawner } from '../../execution/index.ts';
import type { DebuggerBackend } from './DebuggerBackend.ts';
import type { BreakpointInfo, BreakpointSpec, DebugExecutionState } from '../types.ts';

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const LLDB_PROMPT = 'MOBILEBUILDMCP_LLDB> ';
const COMMAND_SENTINEL = '__MOBILEBUILDMCP_DONE__';
const COMMAND_SENTINEL_REGEX = new RegExp(`(^|\\r?\\n)${COMMAND_SENTINEL}(\\r?\\n)`);

class LldbCliBackend implements DebuggerBackend {
  readonly kind = 'lldb-cli' as const;

  private readonly spawner: InteractiveSpawner;
  private readonly prompt = LLDB_PROMPT;
  private readonly process: InteractiveProcess;
  private buffer = '';
  private pending: {
    resolve: (output: string) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  } | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private ready: Promise<void>;
  private disposed = false;
  private processExitDescription: string | null = null;
  // The sentinel queued after continue owns all output until the next command drains it.
  private resumeOutputPending = false;

  constructor(spawner: InteractiveSpawner) {
    this.spawner = spawner;
    const lldbCommand = [
      'xcrun',
      'lldb',
      '--no-lldbinit',
      '-o',
      `settings set prompt "${this.prompt}"`,
    ];

    this.process = this.spawner(lldbCommand);

    this.process.process.stdout?.on('data', (data: Buffer) => this.handleData(data));
    this.process.process.stderr?.on('data', (data: Buffer) => this.handleData(data));
    this.process.process.on('exit', (code, signal) => {
      const detail = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
      this.processExitDescription = `LLDB process exited (${detail})`;
      this.resumeOutputPending = false;
      this.failPending(new Error(this.processExitDescription));
    });

    this.ready = this.initialize();
  }

  private async initialize(): Promise<void> {
    // Prime the prompt by running a sentinel command we can parse reliably.
    this.process.write(`script print("${COMMAND_SENTINEL}")\n`);
    await this.waitForSentinel(DEFAULT_STARTUP_TIMEOUT_MS);
  }

  async waitUntilReady(): Promise<void> {
    await this.ready;
  }

  async attach(opts: { pid: number; simulatorId: string; waitFor?: boolean }): Promise<void> {
    const command = opts.waitFor
      ? `process attach --pid ${opts.pid} --waitfor`
      : `process attach --pid ${opts.pid}`;
    const output = await this.runCommand(command);
    assertNoLldbError('attach', output);
  }

  async detach(): Promise<void> {
    const output = await this.runCommand('process detach');
    assertNoLldbError('detach', output);
  }

  async runCommand(command: string, opts?: { timeoutMs?: number }): Promise<string> {
    return this.enqueue(async () => {
      if (this.disposed) {
        throw new Error('LLDB backend disposed');
      }
      await this.ready;
      await this.drainResumeOutput(opts?.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
      this.process.write(`${command}\n`);
      this.process.write(`script print("${COMMAND_SENTINEL}")\n`);
      const output = await this.waitForSentinel(opts?.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
      return sanitizeOutput(output, this.prompt).trimEnd();
    });
  }

  async resume(): Promise<void> {
    return this.enqueue(async () => {
      if (this.disposed) {
        throw new Error('LLDB backend disposed');
      }
      await this.ready;
      await this.drainResumeOutput(DEFAULT_COMMAND_TIMEOUT_MS);
      this.process.write('process continue\n');
      this.process.write(`script print("${COMMAND_SENTINEL}")\n`);
      this.resumeOutputPending = true;
    });
  }

  async addBreakpoint(
    spec: BreakpointSpec,
    opts?: { condition?: string },
  ): Promise<BreakpointInfo> {
    const command =
      spec.kind === 'file-line'
        ? `breakpoint set --file ${formatLldbString(spec.file)} --line ${spec.line}`
        : `breakpoint set --name ${formatLldbString(spec.name)}`;
    const output = await this.runCommand(command);
    assertNoLldbError('breakpoint', output);

    const match = output.match(/Breakpoint\s+(\d+):/);
    if (!match) {
      throw new Error(`Unable to parse breakpoint id from output: ${output}`);
    }

    const id = Number(match[1]);

    if (opts?.condition) {
      const condition = formatConditionForLldb(opts.condition);
      const modifyOutput = await this.runCommand(`breakpoint modify -c ${condition} ${id}`);
      assertNoLldbError('breakpoint modify', modifyOutput);
    }

    return {
      id,
      spec,
      rawOutput: output,
    };
  }

  async removeBreakpoint(id: number): Promise<string> {
    const output = await this.runCommand(`breakpoint delete ${id}`);
    assertNoLldbError('breakpoint delete', output);
    return output;
  }

  async getStack(opts?: { threadIndex?: number; maxFrames?: number }): Promise<string> {
    let command = 'thread backtrace';
    if (typeof opts?.maxFrames === 'number') {
      command += ` -c ${opts.maxFrames}`;
    }
    if (typeof opts?.threadIndex === 'number') {
      command += ` ${opts.threadIndex}`;
    }
    return this.runCommand(command);
  }

  async getVariables(opts?: { frameIndex?: number }): Promise<string> {
    if (typeof opts?.frameIndex === 'number') {
      await this.runCommand(`frame select ${opts.frameIndex}`);
    }
    return this.runCommand('frame variable');
  }

  async getExecutionState(opts?: { timeoutMs?: number }): Promise<DebugExecutionState> {
    if (this.disposed) {
      return { status: 'unknown', description: 'LLDB backend disposed' };
    }
    if (this.processExitDescription) {
      return { status: 'terminated', description: this.processExitDescription };
    }
    if (this.resumeOutputPending && !COMMAND_SENTINEL_REGEX.test(this.buffer)) {
      return { status: 'running', description: 'Process is running' };
    }

    try {
      const output = await this.runCommand('process status', {
        timeoutMs: opts?.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      });
      const normalized = output.toLowerCase();

      if (/no process|exited|terminated/.test(normalized)) {
        return { status: 'terminated', description: output.trim() };
      }
      if (/\bstopped\b/.test(normalized)) {
        return {
          status: 'stopped',
          reason: parseStopReason(output),
          description: output.trim(),
        };
      }
      if (/\brunning\b/.test(normalized)) {
        return { status: 'running', description: output.trim() };
      }
      if (/error:/.test(normalized)) {
        return { status: 'unknown', description: output.trim() };
      }

      return { status: 'unknown', description: output.trim() };
    } catch (error) {
      return {
        status: 'unknown',
        description: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.resumeOutputPending = false;
    this.failPending(new Error('LLDB backend disposed'));
    this.process.dispose();
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work) as Promise<T>;
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private handleData(data: Buffer): void {
    this.buffer += data.toString('utf8');
    this.checkPending();
  }

  private async drainResumeOutput(timeoutMs: number): Promise<void> {
    if (!this.resumeOutputPending) {
      return;
    }

    await this.waitForSentinel(timeoutMs);
    this.resumeOutputPending = false;
  }

  private waitForSentinel(timeoutMs: number): Promise<string> {
    if (this.pending) {
      return Promise.reject(new Error('LLDB command already pending'));
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending = null;
        reject(new Error(`LLDB command timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending = { resolve, reject, timeout };
      this.checkPending();
    });
  }

  private checkPending(): void {
    if (!this.pending) return;
    const sentinelMatch = this.buffer.match(COMMAND_SENTINEL_REGEX);
    const sentinelIndex = sentinelMatch?.index;
    const sentinelLength = sentinelMatch?.[0].length;
    if (sentinelIndex == null || sentinelLength == null) return;

    const output = this.buffer.slice(0, sentinelIndex);
    const remainderStart = sentinelIndex + sentinelLength;

    const promptIndex = this.buffer.indexOf(this.prompt, remainderStart);
    if (promptIndex !== -1) {
      this.buffer = this.buffer.slice(promptIndex + this.prompt.length);
    } else {
      this.buffer = this.buffer.slice(remainderStart);
    }

    const { resolve, timeout } = this.pending;
    this.pending = null;
    clearTimeout(timeout);
    resolve(output);
  }

  private failPending(error: Error): void {
    if (!this.pending) return;
    const { reject, timeout } = this.pending;
    this.pending = null;
    clearTimeout(timeout);
    reject(error);
  }
}

function assertNoLldbError(context: string, output: string): void {
  if (/error:/i.test(output)) {
    throw new Error(`LLDB ${context} failed: ${output.trim()}`);
  }
}

function sanitizeOutput(output: string, prompt: string): string {
  const lines = output.split(/\r?\n/);
  const filtered = lines.filter((line) => {
    if (!line) return false;
    if (line.startsWith(prompt)) return false;
    if (line.includes(`script print("${COMMAND_SENTINEL}")`)) return false;
    if (line.includes(COMMAND_SENTINEL)) return false;
    return true;
  });
  return filtered.join('\n');
}

function formatLldbString(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
  return `"${escaped}"`;
}

function formatConditionForLldb(condition: string): string {
  return formatLldbString(condition);
}

function parseStopReason(output: string): string | undefined {
  const match = output.match(/stop reason\s*=\s*(.+)/i);
  if (!match) return undefined;
  return match[1]?.trim() || undefined;
}

export async function createLldbCliBackend(
  spawner: InteractiveSpawner = getDefaultInteractiveSpawner(),
): Promise<DebuggerBackend> {
  const backend = new LldbCliBackend(spawner);
  try {
    await backend.waitUntilReady();
  } catch (error) {
    try {
      await backend.dispose();
    } catch {
      // Best-effort cleanup; keep original error.
    }
    throw error;
  }
  return backend;
}
