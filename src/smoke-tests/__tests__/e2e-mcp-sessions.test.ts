import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createMcpTestHarness, type McpTestHarness } from '../mcp-test-harness.ts';
import { extractText, expectContent } from '../test-helpers.ts';

let harness: McpTestHarness;

beforeAll(async () => {
  harness = await createMcpTestHarness({
    commandResponses: {
      xcodebuild: { success: true, output: 'Build Succeeded' },
      'simctl list devices': {
        success: true,
        output: JSON.stringify({
          devices: {
            'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
              {
                name: 'iPhone 17 Pro',
                udid: 'AAAAAAAA-1111-2222-3333-444444444444',
                state: 'Shutdown',
                isAvailable: true,
              },
            ],
          },
        }),
      },
    },
  });
}, 30_000);

afterAll(async () => {
  await harness.cleanup();
});

beforeEach(async () => {
  // Clear defaults before each test
  await harness.client.callTool({
    name: 'session_clear_defaults',
    arguments: { all: true },
  });
});

describe('MCP Session Management (e2e)', () => {
  it('session_set_defaults stores scheme', async () => {
    const result = await harness.client.callTool({
      name: 'session_set_defaults',
      arguments: { scheme: 'MyApp' },
    });

    expect(result).toBeDefined();
    const text = extractText(result);
    expect(text).toContain('scheme');
  });

  it('session_show_defaults returns the set defaults', async () => {
    // Set some defaults
    await harness.client.callTool({
      name: 'session_set_defaults',
      arguments: { scheme: 'TestApp', projectPath: '/path/to/project' },
    });

    // Show defaults
    const result = await harness.client.callTool({
      name: 'session_show_defaults',
      arguments: {},
    });

    const text = extractText(result);
    expect(text).toContain('TestApp');
    expect(text).toContain('/path/to/project');
  });

  it('session_clear_defaults clears all defaults', async () => {
    // Set defaults
    await harness.client.callTool({
      name: 'session_set_defaults',
      arguments: { scheme: 'ClearMeScheme', projectPath: '/clear-me-proj' },
    });

    // Clear all
    await harness.client.callTool({
      name: 'session_clear_defaults',
      arguments: { all: true },
    });

    // Show should be empty
    const result = await harness.client.callTool({
      name: 'session_show_defaults',
      arguments: {},
    });

    const text = extractText(result);
    // Should not contain the previously set values
    expect(text).not.toContain('ClearMeScheme');
    expect(text).not.toContain('/clear-me-proj');
  });

  it('session_clear_defaults clears specific keys', async () => {
    // Set multiple defaults
    await harness.client.callTool({
      name: 'session_set_defaults',
      arguments: { scheme: 'KeepThis', projectPath: '/clear/this' },
    });

    // Clear only projectPath
    await harness.client.callTool({
      name: 'session_clear_defaults',
      arguments: { keys: ['projectPath'] },
    });

    // Show defaults
    const result = await harness.client.callTool({
      name: 'session_show_defaults',
      arguments: {},
    });

    const text = extractText(result);
    expect(text).toContain('KeepThis');
    expect(text).not.toContain('/clear/this');
  });

  it('session defaults flow into tool invocations', async () => {
    // Set session defaults
    await harness.client.callTool({
      name: 'session_set_defaults',
      arguments: {
        scheme: 'SessionScheme',
        projectPath: '/session/project.xcodeproj',
        simulatorId: 'AAAAAAAA-1111-2222-3333-444444444444',
      },
    });

    // Invoke build_sim without explicit scheme/project (should use session defaults)
    harness.resetCapturedCommands();
    const result = await harness.client.callTool({
      name: 'build_sim',
      arguments: {},
    });

    expectContent(result);

    // The captured commands should include the session default scheme
    const commandStrs = harness.capturedCommands.map((c) => c.command.join(' '));
    const buildCommand = commandStrs.find((c) => c.includes('xcodebuild') && c.includes('-scheme'));
    expect(buildCommand).toBeDefined();
    expect(buildCommand).toContain('SessionScheme');
  });

  it('explicit simulator build arguments override session defaults', async () => {
    await harness.client.callTool({
      name: 'session_set_defaults',
      arguments: {
        scheme: 'DefaultScheme',
        projectPath: '/default/project.xcodeproj',
        simulatorId: 'BBBBBBBB-1111-2222-3333-444444444444',
        configuration: 'Debug',
      },
    });

    harness.resetCapturedCommands();
    const result = await harness.client.callTool({
      name: 'build_sim',
      arguments: {
        scheme: 'ExplicitScheme',
        projectPath: '/explicit/project.xcodeproj',
        simulatorName: 'iPhone 17 Pro',
        configuration: 'Release',
      },
    });

    expectContent(result);
    const commandStrs = harness.capturedCommands.map((command) => command.command.join(' '));
    const buildCommand = commandStrs.find(
      (command) => command.includes('xcodebuild') && command.includes('-scheme'),
    );
    expect(buildCommand).toBeDefined();
    expect(buildCommand).toContain('ExplicitScheme');
    expect(buildCommand).toContain('/explicit/project.xcodeproj');
    expect(buildCommand).toContain('iPhone 17 Pro');
    expect(buildCommand).toContain('Release');
    expect(buildCommand).not.toContain('DefaultScheme');
    expect(buildCommand).not.toContain('/default/project.xcodeproj');
  });

  it('explicit simulator test arguments and selectors override session defaults', async () => {
    await harness.client.callTool({
      name: 'session_set_defaults',
      arguments: {
        scheme: 'DefaultScheme',
        projectPath: '/default/project.xcodeproj',
        simulatorId: 'BBBBBBBB-1111-2222-3333-444444444444',
        configuration: 'Debug',
      },
    });

    harness.resetCapturedCommands();
    const result = await harness.client.callTool({
      name: 'test_sim',
      arguments: {
        scheme: 'WorktreeScheme',
        projectPath: '/worktree/project.xcodeproj',
        simulatorName: 'iPhone 17 Pro',
        configuration: 'Release',
        onlyTesting: ['MyTests/LoginTests/testSuccess'],
        skipTesting: ['MyTests/LoginTests/testFailure'],
      },
    });

    expectContent(result);
    const commandStrs = harness.capturedCommands.map((command) => command.command.join(' '));
    const buildForTestingCommand = commandStrs.find((command) =>
      command.includes('build-for-testing'),
    );
    const testWithoutBuildingCommand = commandStrs.find(
      (command) => command.includes('xcodebuild') && command.includes(' test'),
    );
    expect(buildForTestingCommand).toBeDefined();
    expect(buildForTestingCommand).toContain('WorktreeScheme');
    expect(buildForTestingCommand).toContain('/worktree/project.xcodeproj');
    expect(buildForTestingCommand).toContain('Release');
    expect(buildForTestingCommand).toContain('AAAAAAAA-1111-2222-3333-444444444444');
    expect(testWithoutBuildingCommand).toBeDefined();
    expect(testWithoutBuildingCommand).toContain('-only-testing:MyTests/LoginTests/testSuccess');
    expect(testWithoutBuildingCommand).toContain('-skip-testing:MyTests/LoginTests/testFailure');
    expect(commandStrs.join('\n')).not.toContain('DefaultScheme');
    expect(commandStrs.join('\n')).not.toContain('/default/project.xcodeproj');
    expect(commandStrs.join('\n')).not.toContain('BBBBBBBB-1111-2222-3333-444444444444');
  });

  it('updating session defaults changes subsequent tool behavior', async () => {
    // Set initial defaults
    await harness.client.callTool({
      name: 'session_set_defaults',
      arguments: {
        scheme: 'FirstScheme',
        projectPath: '/first/project.xcodeproj',
        simulatorId: 'AAAAAAAA-1111-2222-3333-444444444444',
      },
    });

    // Update scheme via session_set_defaults
    await harness.client.callTool({
      name: 'session_set_defaults',
      arguments: {
        scheme: 'UpdatedScheme',
      },
    });

    // Invoke build_sim - should use the updated scheme
    harness.resetCapturedCommands();
    const result = await harness.client.callTool({
      name: 'build_sim',
      arguments: {},
    });

    expect(result).toBeDefined();
    const commandStrs = harness.capturedCommands.map((c) => c.command.join(' '));
    const buildCommand = commandStrs.find((c) => c.includes('xcodebuild') && c.includes('-scheme'));
    expect(buildCommand).toBeDefined();
    expect(buildCommand).toContain('UpdatedScheme');
  });

  it('supports namespaced defaults by switching active profile', async () => {
    await harness.client.callTool({
      name: 'session_set_defaults',
      arguments: {
        profile: 'ios',
        createIfNotExists: true,
        scheme: 'IOSScheme',
        projectPath: '/ios/project.xcodeproj',
      },
    });

    await harness.client.callTool({
      name: 'session_set_defaults',
      arguments: {
        profile: 'watch',
        createIfNotExists: true,
        scheme: 'WatchScheme',
        projectPath: '/watch/project.xcodeproj',
      },
    });

    const watchResult = (await harness.client.callTool({
      name: 'session_use_defaults_profile',
      arguments: { profile: 'watch' },
    })) as {
      structuredContent?: { data?: { currentProfile?: string } };
    };
    expect(watchResult.structuredContent?.data?.currentProfile).toBe('watch');

    const watchDefaults = (await harness.client.callTool({
      name: 'session_show_defaults',
      arguments: {},
    })) as {
      structuredContent?: {
        data?: {
          currentProfile?: string;
          profiles?: Record<string, { scheme?: string | null; projectPath?: string | null }>;
        };
      };
    };
    expect(watchDefaults.structuredContent?.data?.currentProfile).toBe('watch');
    expect(watchDefaults.structuredContent?.data?.profiles?.watch?.scheme).toBe('WatchScheme');
    expect(watchDefaults.structuredContent?.data?.profiles?.ios?.scheme).toBe('IOSScheme');

    const iosResult = (await harness.client.callTool({
      name: 'session_use_defaults_profile',
      arguments: { profile: 'ios' },
    })) as {
      structuredContent?: { data?: { currentProfile?: string } };
    };
    expect(iosResult.structuredContent?.data?.currentProfile).toBe('ios');

    const iosDefaults = (await harness.client.callTool({
      name: 'session_show_defaults',
      arguments: {},
    })) as {
      structuredContent?: {
        data?: {
          currentProfile?: string;
          profiles?: Record<string, { scheme?: string | null; projectPath?: string | null }>;
        };
      };
    };
    expect(iosDefaults.structuredContent?.data?.currentProfile).toBe('ios');
    expect(iosDefaults.structuredContent?.data?.profiles?.ios?.projectPath).toBe(
      '/ios/project.xcodeproj',
    );
  });
});
