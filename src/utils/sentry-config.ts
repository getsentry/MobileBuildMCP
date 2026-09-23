import { getDefaultFileSystemExecutor, type FileSystemExecutor } from './command.ts';
import { loadProjectConfig } from './project-config.ts';

export async function hydrateSentryDisabledEnvFromProjectConfig(opts?: {
  cwd?: string;
  fs?: FileSystemExecutor;
}): Promise<void> {
  const envDisabled =
    process.env.MOBILEBUILDMCP_SENTRY_DISABLED === 'true' || process.env.SENTRY_DISABLED === 'true';
  if (envDisabled) {
    return;
  }

  const fs = opts?.fs ?? getDefaultFileSystemExecutor();
  const cwd = opts?.cwd ?? process.cwd();
  const result = await loadProjectConfig({ fs, cwd });

  if (result.found && result.config.sentryDisabled === true) {
    process.env.MOBILEBUILDMCP_SENTRY_DISABLED = 'true';
  }
}
