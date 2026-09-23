import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { __resetConfigStoreForTests, initConfigStore } from '../../../../utils/config-store.ts';
import { createMockFileSystemExecutor } from '../../../../test-utils/mock-executors.ts';
import { sessionStore } from '../../../../utils/session-store.ts';
import {
  handler,
  schema,
  sessionUseDefaultsProfileLogic,
} from '../session_use_defaults_profile.ts';
import {
  allText,
  createMockToolHandlerContext,
  runLogic,
} from '../../../../test-utils/test-helpers.ts';

describe('session-use-defaults-profile tool', () => {
  beforeEach(() => {
    __resetConfigStoreForTests();
    sessionStore.clear();
  });

  const cwd = '/repo';
  const configPath = path.join(cwd, '.mobilebuildmcp', 'config.yaml');

  it('exports handler and schema', () => {
    expect(typeof handler).toBe('function');
    expect(schema).toBeDefined();
    expect(typeof schema).toBe('object');
  });

  it('activates an existing named profile', async () => {
    sessionStore.setActiveProfile('ios');
    sessionStore.setActiveProfile(null);

    const result = await runLogic(() => sessionUseDefaultsProfileLogic({ profile: 'ios' }));
    expect(result.isError).toBeFalsy();
    expect(sessionStore.getActiveProfile()).toBe('ios');
    expect(sessionStore.listProfiles()).toContain('ios');
  });

  it('switches back to global profile', async () => {
    sessionStore.setActiveProfile('watch');
    const result = await runLogic(() => sessionUseDefaultsProfileLogic({ global: true }));
    expect(result.isError).toBeFalsy();
    expect(sessionStore.getActiveProfile()).toBeNull();
  });

  it('returns error when both global and profile are provided', async () => {
    const result = await runLogic(() =>
      sessionUseDefaultsProfileLogic({ global: true, profile: 'ios' }),
    );
    expect(result.isError).toBe(true);
    expect(allText(result)).toContain('either global=true or profile');
  });

  it('returns error when profile does not exist', async () => {
    const result = await runLogic(() => sessionUseDefaultsProfileLogic({ profile: 'macos' }));
    expect(result.isError).toBe(true);
    expect(allText(result)).toContain('does not exist');
  });

  it('returns error when profile name is blank after trimming', async () => {
    const result = await runLogic(() => sessionUseDefaultsProfileLogic({ profile: '   ' }));
    expect(result.isError).toBe(true);
    expect(allText(result)).toContain('Profile name cannot be empty');
  });

  it('returns status for empty args', async () => {
    const result = await runLogic(() => sessionUseDefaultsProfileLogic({}));
    expect(result.isError).toBeFalsy();
    expect(allText(result)).toContain('Activated profile (default profile)');
  });

  it('persists active profile when persist=true', async () => {
    const writes: { path: string; content: string }[] = [];
    const fs = createMockFileSystemExecutor({
      existsSync: (targetPath: string) => targetPath === configPath,
      readFile: async () => ['schemaVersion: 1', ''].join('\n'),
      writeFile: async (targetPath: string, content: string) => {
        writes.push({ path: targetPath, content });
      },
    });
    await initConfigStore({ cwd, fs });

    sessionStore.setActiveProfile('ios');
    sessionStore.setActiveProfile(null);

    const { ctx, result, run } = createMockToolHandlerContext();
    await run(() => sessionUseDefaultsProfileLogic({ profile: 'ios', persist: true }));
    expect(result.isError()).toBe(false);
    expect(result.text()).toContain('Persisted active profile selection');
    expect(ctx.structuredOutput?.result).toMatchObject({ persisted: true });
    expect(writes).toHaveLength(1);
    const parsed = parseYaml(writes[0].content) as { activeSessionDefaultsProfile?: string };
    expect(parsed.activeSessionDefaultsProfile).toBe('ios');
  });

  it('removes active profile from config when persisting global selection', async () => {
    const writes: { path: string; content: string }[] = [];
    const yaml = ['schemaVersion: 1', 'activeSessionDefaultsProfile: "ios"', ''].join('\n');
    const fs = createMockFileSystemExecutor({
      existsSync: (targetPath: string) => targetPath === configPath,
      readFile: async () => yaml,
      writeFile: async (targetPath: string, content: string) => {
        writes.push({ path: targetPath, content });
      },
    });
    await initConfigStore({ cwd, fs });

    const result = await runLogic(() =>
      sessionUseDefaultsProfileLogic({ global: true, persist: true }),
    );
    expect(result.isError).toBeFalsy();
    expect(writes).toHaveLength(1);
    const parsed = parseYaml(writes[0].content) as { activeSessionDefaultsProfile?: string };
    expect(parsed.activeSessionDefaultsProfile).toBeUndefined();
  });
});
