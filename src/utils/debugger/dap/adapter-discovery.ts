import type { CommandExecutor } from '../../execution/index.ts';
import { log } from '../../logging/index.ts';
import { DependencyError } from '../../errors.ts';

const LOG_PREFIX = '[DAP Adapter]';

export async function resolveLldbDapCommand(opts: {
  executor: CommandExecutor;
}): Promise<string[]> {
  try {
    const result = await opts.executor(['xcrun', '--find', 'lldb-dap'], LOG_PREFIX);
    if (!result.success) {
      throw new DependencyError('xcrun returned a non-zero exit code for lldb-dap discovery.');
    }

    const resolved = result.output.trim();
    if (!resolved) {
      throw new DependencyError('xcrun did not return a path for lldb-dap.');
    }

    log('debug', `${LOG_PREFIX} resolved lldb-dap: ${resolved}`);
    return [resolved];
  } catch (error) {
    if (error instanceof DependencyError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new DependencyError(
      'DAP backend selected but lldb-dap not found. Ensure Xcode is installed and xcrun can locate lldb-dap, or set MOBILEBUILDMCP_DEBUGGER_BACKEND=lldb-cli.',
      message,
    );
  }
}
