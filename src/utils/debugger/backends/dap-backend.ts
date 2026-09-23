import type { DebuggerBackend } from './DebuggerBackend.ts';
import type { BreakpointInfo, BreakpointSpec, DebugExecutionState } from '../types.ts';
import type { CommandExecutor, InteractiveSpawner } from '../../execution/index.ts';
import { getDefaultCommandExecutor, getDefaultInteractiveSpawner } from '../../execution/index.ts';
import { log } from '../../logging/index.ts';
import { getConfig } from '../../config-store.ts';
import type {
  DapEvent,
  EvaluateResponseBody,
  ScopesResponseBody,
  SetBreakpointsResponseBody,
  StackTraceResponseBody,
  StoppedEventBody,
  ThreadsResponseBody,
  VariablesResponseBody,
} from '../dap/types.ts';
import { DapTransport } from '../dap/transport.ts';
import { resolveLldbDapCommand } from '../dap/adapter-discovery.ts';

const LOG_PREFIX = '[DAP Backend]';

type FileLineBreakpointRecord = { line: number; condition?: string; id?: number };
type FunctionBreakpointRecord = { name: string; condition?: string; id?: number };

type BreakpointRecord = {
  spec: BreakpointSpec;
  condition?: string;
};

class DapBackend implements DebuggerBackend {
  readonly kind = 'dap' as const;

  private readonly executor: CommandExecutor;
  private readonly spawner: InteractiveSpawner;
  private readonly requestTimeoutMs: number;
  private readonly logEvents: boolean;

  private transport: DapTransport | null = null;
  private unsubscribeEvents: (() => void) | null = null;
  private attached = false;
  private disposed = false;
  private queue: Promise<unknown> = Promise.resolve();

  private lastStoppedThreadId: number | null = null;
  private executionState: DebugExecutionState = { status: 'unknown' };
  private breakpointsById = new Map<number, BreakpointRecord>();
  private fileLineBreakpointsByFile = new Map<string, FileLineBreakpointRecord[]>();
  private functionBreakpoints: FunctionBreakpointRecord[] = [];
  private nextSyntheticId = -1;

  constructor(opts: {
    executor: CommandExecutor;
    spawner: InteractiveSpawner;
    requestTimeoutMs: number;
    logEvents: boolean;
  }) {
    this.executor = opts.executor;
    this.spawner = opts.spawner;
    this.requestTimeoutMs = opts.requestTimeoutMs;
    this.logEvents = opts.logEvents;
  }

  async attach(opts: { pid: number; simulatorId: string; waitFor?: boolean }): Promise<void> {
    void opts.simulatorId;
    return this.enqueue(async () => {
      if (this.disposed) {
        throw new Error('DAP backend disposed');
      }
      if (this.attached) {
        throw new Error('DAP backend already attached');
      }

      const adapterCommand = await resolveLldbDapCommand({ executor: this.executor });
      const transport = new DapTransport({
        spawner: this.spawner,
        adapterCommand,
        logPrefix: LOG_PREFIX,
      });
      this.transport = transport;
      this.unsubscribeEvents = transport.onEvent((event) => this.handleEvent(event));

      try {
        const init = await this.request<
          {
            clientID: string;
            clientName: string;
            adapterID: string;
            linesStartAt1: boolean;
            columnsStartAt1: boolean;
            pathFormat: string;
            supportsVariableType: boolean;
            supportsVariablePaging: boolean;
          },
          { supportsConfigurationDoneRequest?: boolean }
        >('initialize', {
          clientID: 'mobilebuildmcp',
          clientName: 'MobileBuildMCP',
          adapterID: 'lldb-dap',
          linesStartAt1: true,
          columnsStartAt1: true,
          pathFormat: 'path',
          supportsVariableType: true,
          supportsVariablePaging: false,
        });

        await this.request('attach', {
          pid: opts.pid,
          waitFor: opts.waitFor ?? false,
        });

        if (init.supportsConfigurationDoneRequest !== false) {
          await this.request('configurationDone', {});
        }

        this.attached = true;
        log('info', `${LOG_PREFIX} attached to pid ${opts.pid}`);
      } catch (error) {
        this.cleanupTransport();
        throw error;
      }
    });
  }

  async detach(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.transport) return;
      try {
        await this.request('disconnect', { terminateDebuggee: false });
      } finally {
        this.cleanupTransport();
      }
    });
  }

  async runCommand(command: string, opts?: { timeoutMs?: number }): Promise<string> {
    this.ensureAttached();

    const normalizedCommand = command.trim().toLowerCase();
    if (normalizedCommand === 'process interrupt') {
      return this.enqueue(async () => {
        await this.pauseExecution(opts?.timeoutMs);
        return 'Process interrupted.';
      });
    }

    try {
      const body = await this.request<
        { expression: string; context: string },
        EvaluateResponseBody
      >('evaluate', { expression: command, context: 'repl' }, opts);
      return formatEvaluateResult(body);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/evaluate|repl|not supported/i.test(message)) {
        throw new Error(
          'DAP backend does not support LLDB command evaluation. Set MOBILEBUILDMCP_DEBUGGER_BACKEND=lldb-cli to use the CLI backend.',
        );
      }
      throw error;
    }
  }

  async resume(opts?: { threadId?: number }): Promise<void> {
    return this.enqueue(async () => {
      this.ensureAttached();

      let threadId = opts?.threadId;
      if (!threadId) {
        const thread = await this.resolveThread();
        threadId = thread.id;
      }

      await this.request('continue', { threadId });
      this.executionState = { status: 'running' };
      this.lastStoppedThreadId = null;
    });
  }

  async addBreakpoint(
    spec: BreakpointSpec,
    opts?: { condition?: string },
  ): Promise<BreakpointInfo> {
    return this.enqueue(async () => {
      this.ensureAttached();

      if (spec.kind === 'file-line') {
        const current = this.fileLineBreakpointsByFile.get(spec.file) ?? [];
        const nextBreakpoints = [...current, { line: spec.line, condition: opts?.condition }];
        const updated = await this.setFileBreakpoints(spec.file, nextBreakpoints);
        const added = updated[nextBreakpoints.length - 1];
        if (!added?.id) {
          throw new Error('DAP breakpoint id missing for file breakpoint.');
        }
        return {
          id: added.id,
          spec,
          rawOutput: `Set breakpoint ${added.id} at ${spec.file}:${spec.line}`,
        };
      }

      const nextBreakpoints = [
        ...this.functionBreakpoints,
        { name: spec.name, condition: opts?.condition },
      ];
      const updated = await this.setFunctionBreakpoints(nextBreakpoints);
      const added = updated[nextBreakpoints.length - 1];
      if (!added?.id) {
        throw new Error('DAP breakpoint id missing for function breakpoint.');
      }
      return {
        id: added.id,
        spec,
        rawOutput: `Set breakpoint ${added.id} on ${spec.name}`,
      };
    });
  }

  async removeBreakpoint(id: number): Promise<string> {
    return this.enqueue(async () => {
      this.ensureAttached();

      const record = this.breakpointsById.get(id);
      if (!record) {
        throw new Error(`Breakpoint not found: ${id}`);
      }

      if (record.spec.kind === 'file-line') {
        const current = this.fileLineBreakpointsByFile.get(record.spec.file) ?? [];
        const nextBreakpoints = current.filter((breakpoint) => breakpoint.id !== id);
        await this.setFileBreakpoints(record.spec.file, nextBreakpoints);
      } else {
        const nextBreakpoints = this.functionBreakpoints.filter(
          (breakpoint) => breakpoint.id !== id,
        );
        await this.setFunctionBreakpoints(nextBreakpoints);
      }

      return `Removed breakpoint ${id}.`;
    });
  }

  async getStack(opts?: { threadIndex?: number; maxFrames?: number }): Promise<string> {
    this.ensureAttached();

    try {
      const thread = await this.resolveThread(opts?.threadIndex);
      const stack = await this.request<
        { threadId: number; startFrame?: number; levels?: number },
        StackTraceResponseBody
      >('stackTrace', {
        threadId: thread.id,
        startFrame: 0,
        levels: opts?.maxFrames,
      });

      if (!stack.stackFrames.length) {
        return `Thread ${thread.id}: no stack frames.`;
      }

      const threadLabel = thread.name
        ? `Thread ${thread.id} (${thread.name})`
        : `Thread ${thread.id}`;
      const formatted = stack.stackFrames.map((frame, index) => {
        const location = frame.source?.path ?? frame.source?.name ?? 'unknown';
        const line = frame.line ?? 0;
        return `frame #${index}: ${frame.name} at ${location}:${line}`;
      });

      return [threadLabel, ...formatted].join('\n');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/running|not stopped|no thread|no frames/i.test(message)) {
        throw new Error('Process is running; pause or hit a breakpoint to fetch stack.');
      }
      throw error;
    }
  }

  async getVariables(opts?: { frameIndex?: number }): Promise<string> {
    this.ensureAttached();

    try {
      const thread = await this.resolveThread();
      const frameIndex = opts?.frameIndex ?? 0;
      const stack = await this.request<
        { threadId: number; startFrame?: number; levels?: number },
        StackTraceResponseBody
      >('stackTrace', {
        threadId: thread.id,
        startFrame: 0,
        levels: frameIndex + 1,
      });

      if (stack.stackFrames.length <= frameIndex) {
        throw new Error(`Frame index ${frameIndex} is out of range.`);
      }

      const frame = stack.stackFrames[frameIndex];
      const scopes = await this.request<{ frameId: number }, ScopesResponseBody>('scopes', {
        frameId: frame.id,
      });

      if (!scopes.scopes.length) {
        return 'No scopes available.';
      }

      const sections: string[] = [];
      for (const scope of scopes.scopes) {
        if (!scope.variablesReference) {
          sections.push(`${scope.name}:\n  (no variables)`);
          continue;
        }

        const vars = await this.request<{ variablesReference: number }, VariablesResponseBody>(
          'variables',
          {
            variablesReference: scope.variablesReference,
          },
        );

        if (!vars.variables.length) {
          sections.push(`${scope.name}:\n  (no variables)`);
          continue;
        }

        const lines = vars.variables.map((variable) => `  ${formatVariable(variable)}`);
        sections.push(`${scope.name}:\n${lines.join('\n')}`);
      }

      return sections.join('\n\n');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/running|not stopped|no thread/i.test(message)) {
        throw new Error('Process is running; pause or hit a breakpoint to fetch variables.');
      }
      throw error;
    }
  }

  async getExecutionState(opts?: { timeoutMs?: number }): Promise<DebugExecutionState> {
    return this.enqueue(async () => {
      this.ensureAttached();

      if (this.executionState.status !== 'unknown') {
        return this.executionState;
      }

      try {
        const body = await this.request<undefined, ThreadsResponseBody>('threads', undefined, opts);
        const threads = body.threads ?? [];
        if (!threads.length) {
          return { status: 'unknown' };
        }

        const threadId = threads[0].id;
        try {
          await this.request<
            { threadId: number; startFrame?: number; levels?: number },
            StackTraceResponseBody
          >(
            'stackTrace',
            { threadId, startFrame: 0, levels: 1 },
            { timeoutMs: opts?.timeoutMs ?? this.requestTimeoutMs },
          );
          const state: DebugExecutionState = { status: 'stopped', threadId };
          this.executionState = state;
          return state;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/running|not stopped/i.test(message)) {
            const state: DebugExecutionState = { status: 'running', description: message };
            this.executionState = state;
            return state;
          }
          return { status: 'unknown', description: message };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/running|not stopped/i.test(message)) {
          return { status: 'running', description: message };
        }
        return { status: 'unknown', description: message };
      }
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.cleanupTransport();
    } catch (error) {
      log('debug', `${LOG_PREFIX} dispose failed: ${String(error)}`);
    }
  }

  private ensureAttached(): void {
    if (!this.transport || !this.attached) {
      throw new Error('No active DAP session. Attach first.');
    }
  }

  private async request<A, B>(
    command: string,
    args?: A,
    opts?: { timeoutMs?: number },
  ): Promise<B> {
    const transport = this.transport;
    if (!transport) {
      throw new Error('DAP transport not initialized.');
    }

    return transport.sendRequest<A, B>(command, args, {
      timeoutMs: opts?.timeoutMs ?? this.requestTimeoutMs,
    });
  }

  private async pauseExecution(timeoutMs?: number): Promise<void> {
    const thread = await this.resolveThread();
    const waitForStop = this.waitForEvent('stopped', timeoutMs);

    await this.request<{ threadId: number }, Record<string, never>>(
      'pause',
      { threadId: thread.id },
      { timeoutMs },
    );

    await waitForStop;
    this.executionState = { status: 'stopped', threadId: thread.id };
  }

  private waitForEvent(eventName: string, timeoutMs?: number): Promise<DapEvent> {
    const transport = this.transport;
    if (!transport) {
      throw new Error('DAP transport not initialized.');
    }

    return new Promise<DapEvent>((resolve, reject) => {
      const effectiveTimeoutMs = timeoutMs ?? this.requestTimeoutMs;
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`Timed out waiting for DAP event: ${eventName}`));
      }, effectiveTimeoutMs);

      const unsubscribe = transport.onEvent((event) => {
        if (event.event !== eventName) {
          return;
        }

        clearTimeout(timer);
        unsubscribe();
        resolve(event);
      });
    });
  }

  private async resolveThread(threadIndex?: number): Promise<{ id: number; name?: string }> {
    const body = await this.request<undefined, ThreadsResponseBody>('threads');
    const threads = body.threads ?? [];
    if (!threads.length) {
      throw new Error('No threads available.');
    }

    if (typeof threadIndex === 'number') {
      if (threadIndex < 0 || threadIndex >= threads.length) {
        throw new Error(`Thread index ${threadIndex} is out of range.`);
      }
      return threads[threadIndex];
    }

    if (this.lastStoppedThreadId) {
      const stopped = threads.find((thread) => thread.id === this.lastStoppedThreadId);
      if (stopped) {
        return stopped;
      }
    }

    return threads[0];
  }

  private handleEvent(event: DapEvent): void {
    if (this.logEvents) {
      log('debug', `${LOG_PREFIX} event: ${JSON.stringify(event)}`);
    }

    if (event.event === 'stopped') {
      const body = event.body as StoppedEventBody | undefined;
      this.executionState = {
        status: 'stopped',
        reason: body?.reason,
        description: body?.description,
        threadId: body?.threadId,
      };
      if (body?.threadId) {
        this.lastStoppedThreadId = body.threadId;
      }
      return;
    }

    if (event.event === 'continued') {
      this.executionState = { status: 'running' };
      this.lastStoppedThreadId = null;
      return;
    }

    if (event.event === 'exited' || event.event === 'terminated') {
      this.executionState = { status: 'terminated' };
      this.lastStoppedThreadId = null;
    }
  }

  private cleanupTransport(): void {
    this.attached = false;
    this.lastStoppedThreadId = null;
    this.executionState = { status: 'unknown' };
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = null;

    if (this.transport) {
      this.transport.dispose();
      this.transport = null;
    }
  }

  private async setFileBreakpoints(
    file: string,
    breakpoints: FileLineBreakpointRecord[],
  ): Promise<FileLineBreakpointRecord[]> {
    const response = await this.request<
      { source: { path: string }; breakpoints: Array<{ line: number; condition?: string }> },
      SetBreakpointsResponseBody
    >('setBreakpoints', {
      source: { path: file },
      breakpoints: breakpoints.map((bp) => ({ line: bp.line, condition: bp.condition })),
    });

    const updated = breakpoints.map((bp, index) => ({
      ...bp,
      id: resolveBreakpointId(response.breakpoints?.[index]?.id, () => this.nextSyntheticId--),
    }));

    this.replaceFileBreakpoints(file, updated);
    return updated;
  }

  private replaceFileBreakpoints(file: string, breakpoints: FileLineBreakpointRecord[]): void {
    const existing = this.fileLineBreakpointsByFile.get(file) ?? [];
    for (const breakpoint of existing) {
      if (breakpoint.id != null) {
        this.breakpointsById.delete(breakpoint.id);
      }
    }

    this.fileLineBreakpointsByFile.set(file, breakpoints);
    for (const breakpoint of breakpoints) {
      if (breakpoint.id != null) {
        this.breakpointsById.set(breakpoint.id, {
          spec: { kind: 'file-line', file, line: breakpoint.line },
          condition: breakpoint.condition,
        });
      }
    }
  }

  private async setFunctionBreakpoints(
    breakpoints: FunctionBreakpointRecord[],
  ): Promise<FunctionBreakpointRecord[]> {
    const response = await this.request<
      { breakpoints: Array<{ name: string; condition?: string }> },
      SetBreakpointsResponseBody
    >('setFunctionBreakpoints', {
      breakpoints: breakpoints.map((bp) => ({ name: bp.name, condition: bp.condition })),
    });

    const updated = breakpoints.map((bp, index) => ({
      ...bp,
      id: resolveBreakpointId(response.breakpoints?.[index]?.id, () => this.nextSyntheticId--),
    }));

    this.replaceFunctionBreakpoints(updated);
    return updated;
  }

  private replaceFunctionBreakpoints(breakpoints: FunctionBreakpointRecord[]): void {
    for (const breakpoint of this.functionBreakpoints) {
      if (breakpoint.id != null) {
        this.breakpointsById.delete(breakpoint.id);
      }
    }

    this.functionBreakpoints = breakpoints;
    for (const breakpoint of breakpoints) {
      if (breakpoint.id != null) {
        this.breakpointsById.set(breakpoint.id, {
          spec: { kind: 'function', name: breakpoint.name },
          condition: breakpoint.condition,
        });
      }
    }
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work) as Promise<T>;
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

function resolveBreakpointId(id: number | undefined, fallback: () => number): number {
  if (typeof id === 'number' && Number.isFinite(id)) {
    return id;
  }
  return fallback();
}

function formatEvaluateResult(body: EvaluateResponseBody): string {
  const parts = [body.output, body.result].filter((value) => value && value.trim().length > 0);
  return parts.join('\n');
}

function formatVariable(variable: { name: string; value: string; type?: string }): string {
  const typeSuffix = variable.type ? ` (${variable.type})` : '';
  return `${variable.name}${typeSuffix} = ${variable.value}`;
}

export async function createDapBackend(opts?: {
  executor?: CommandExecutor;
  spawner?: InteractiveSpawner;
  requestTimeoutMs?: number;
}): Promise<DebuggerBackend> {
  const config = getConfig();
  const executor = opts?.executor ?? getDefaultCommandExecutor();
  const spawner = opts?.spawner ?? getDefaultInteractiveSpawner();
  const requestTimeoutMs = opts?.requestTimeoutMs ?? config.dapRequestTimeoutMs;
  return new DapBackend({
    executor,
    spawner,
    requestTimeoutMs,
    logEvents: config.dapLogEvents,
  });
}
