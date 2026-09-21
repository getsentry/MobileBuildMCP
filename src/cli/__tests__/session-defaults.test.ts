import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import {
  mergeCliSessionDefaults,
  pickSchemaSessionDefaults,
  resolveCliSessionDefaults,
} from '../session-defaults.ts';

describe('CLI session defaults', () => {
  it('uses the active profile without overlaying global defaults', () => {
    const defaults = resolveCliSessionDefaults({
      runtimeConfig: {
        enabledWorkflows: [],
        customWorkflows: {},
        debug: false,
        sentryDisabled: false,
        experimentalWorkflowDiscovery: false,
        disableSessionDefaults: true,
        disableXcodeAutoSync: false,
        showTestTiming: false,
        uiDebuggerGuardMode: 'error',
        incrementalBuildsEnabled: false,
        testProductsMaxCount: 3,
        testProductsMaxAgeDays: 1,
        dapRequestTimeoutMs: 30_000,
        dapLogEvents: false,
        launchJsonWaitMs: 8_000,
        debuggerBackend: 'dap',
        sessionDefaults: {
          workspacePath: 'Global.xcworkspace',
        },
        sessionDefaultsProfiles: {
          ios: {
            scheme: 'ProfileScheme',
          },
        },
        activeSessionDefaultsProfile: 'ios',
      },
    });

    expect(defaults).toEqual({ scheme: 'ProfileScheme' });
  });

  it('filters defaults down to schema-supported keys', () => {
    const defaults = pickSchemaSessionDefaults(
      {
        workspacePath: z.string(),
        scheme: z.string().optional(),
      },
      {
        workspacePath: 'App.xcworkspace',
        scheme: 'App',
        simulatorId: 'SIM-1',
      },
    );

    expect(defaults).toEqual({
      workspacePath: 'App.xcworkspace',
      scheme: 'App',
    });
  });

  it('drops conflicting defaults when the user provides an exclusive flag', () => {
    const merged = mergeCliSessionDefaults({
      defaults: {
        workspacePath: 'App.xcworkspace',
      },
      explicitArgs: {
        projectPath: 'App.xcodeproj',
      },
    });

    expect(merged).toEqual({
      projectPath: 'App.xcodeproj',
    });
  });

  it('prefers simulatorId when both simulator defaults come only from config', () => {
    const merged = mergeCliSessionDefaults({
      defaults: {
        simulatorId: 'SIM-1',
        simulatorName: 'iPhone 16',
      },
      explicitArgs: {},
    });

    expect(merged).toEqual({
      simulatorId: 'SIM-1',
    });
  });

  it('does not let empty explicit values suppress configured defaults', () => {
    const merged = mergeCliSessionDefaults({
      defaults: {
        workspacePath: 'App.xcworkspace',
      },
      explicitArgs: {
        workspacePath: '',
      },
    });

    expect(merged).toEqual({
      workspacePath: 'App.xcworkspace',
    });
  });

  it('deep-merges env defaults with explicit env args', () => {
    const merged = mergeCliSessionDefaults({
      defaults: {
        env: {
          FOO: 'from-default',
          SHARED: 'default',
        },
      },
      explicitArgs: {
        env: {
          BAR: 'from-user',
          SHARED: 'user',
        },
      },
    });

    expect(merged).toEqual({
      env: {
        FOO: 'from-default',
        BAR: 'from-user',
        SHARED: 'user',
      },
    });
  });

  it('appends explicit extraArgs after configured extraArgs', () => {
    const merged = mergeCliSessionDefaults({
      defaults: {
        extraArgs: ['-skipPackagePluginValidation'],
      },
      explicitArgs: {
        extraArgs: ['-quiet'],
      },
    });

    expect(merged).toEqual({
      extraArgs: ['-skipPackagePluginValidation', '-quiet'],
    });
  });

  it('lets explicit destination extraArgs replace matching configured extraArgs', () => {
    const merged = mergeCliSessionDefaults({
      defaults: {
        extraArgs: ['-quiet', '-skipMacroValidation', '-destination', 'id=x'],
      },
      explicitArgs: {
        extraArgs: ['-quiet', '-destination', 'id=y'],
      },
    });

    expect(merged).toEqual({
      extraArgs: ['-skipMacroValidation', '-quiet', '-destination', 'id=y'],
    });
  });

  it('allows an explicit empty extraArgs array to clear configured extraArgs', () => {
    const merged = mergeCliSessionDefaults({
      defaults: {
        extraArgs: ['-skipPackagePluginValidation'],
      },
      explicitArgs: {
        extraArgs: [],
      },
    });

    expect(merged).toEqual({
      extraArgs: [],
    });
  });
});
