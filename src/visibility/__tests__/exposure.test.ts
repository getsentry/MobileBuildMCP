import { describe, it, expect } from 'vitest';
import {
  isWorkflowAvailableForRuntime,
  isWorkflowEnabledForRuntime,
  isToolAvailableForRuntime,
  isToolExposedForRuntime,
  isToolInWorkflowExposed,
  filterExposedTools,
  filterEnabledWorkflows,
  getDefaultEnabledWorkflows,
  getAutoIncludeWorkflows,
  selectWorkflowsForMcp,
} from '../exposure.ts';
import type { ToolManifestEntry, WorkflowManifestEntry } from '../../core/manifest/schema.ts';
import type { PredicateContext } from '../predicate-types.ts';
import type { ResolvedRuntimeConfig } from '../../utils/config-store.ts';

function createDefaultConfig(
  overrides: Partial<ResolvedRuntimeConfig> = {},
): ResolvedRuntimeConfig {
  return {
    debug: false,
    sentryDisabled: false,
    enabledWorkflows: [],
    customWorkflows: {},
    experimentalWorkflowDiscovery: false,
    disableSessionDefaults: false,
    disableXcodeAutoSync: false,
    showTestTiming: false,
    uiDebuggerGuardMode: 'error',
    incrementalBuildsEnabled: false,
    testProductsMaxCount: 3,
    testProductsMaxAgeDays: 1,
    dapRequestTimeoutMs: 30000,
    dapLogEvents: false,
    launchJsonWaitMs: 8000,
    debuggerBackend: 'dap',
    ...overrides,
  };
}

function createContext(overrides: Partial<PredicateContext> = {}): PredicateContext {
  return {
    runtime: 'mcp',
    config: createDefaultConfig(),
    runningUnderXcode: false,
    ...overrides,
  };
}

function createTool(overrides: Partial<ToolManifestEntry> = {}): ToolManifestEntry {
  return {
    id: 'test_tool',
    module: 'mcp/tools/test/test_tool',
    names: { mcp: 'test_tool' },
    availability: { mcp: true, cli: true },
    predicates: [],
    nextSteps: [],
    ...overrides,
  };
}

function createWorkflow(overrides: Partial<WorkflowManifestEntry> = {}): WorkflowManifestEntry {
  return {
    id: 'test-workflow',
    title: 'Test Workflow',
    description: 'A test workflow',
    targetPlatforms: [],
    availability: { mcp: true, cli: true },
    predicates: [],
    tools: ['test_tool'],
    ...overrides,
  };
}

describe('exposure', () => {
  describe('isWorkflowAvailableForRuntime', () => {
    it('should return true when workflow is available for runtime', () => {
      const workflow = createWorkflow({ availability: { mcp: true, cli: false } });
      expect(isWorkflowAvailableForRuntime(workflow, 'mcp')).toBe(true);
    });

    it('should return false when workflow is not available for runtime', () => {
      const workflow = createWorkflow({ availability: { mcp: true, cli: false } });
      expect(isWorkflowAvailableForRuntime(workflow, 'cli')).toBe(false);
    });

    it('should ignore manifest availability in daemon runtime', () => {
      const workflow = createWorkflow({ availability: { mcp: false, cli: false } });
      expect(isWorkflowAvailableForRuntime(workflow, 'daemon')).toBe(true);
    });
  });

  describe('isWorkflowEnabledForRuntime', () => {
    it('should return true when available and predicates pass', () => {
      const workflow = createWorkflow();
      const ctx = createContext({ runtime: 'mcp' });
      expect(isWorkflowEnabledForRuntime(workflow, ctx)).toBe(true);
    });

    it('should return false when not available', () => {
      const workflow = createWorkflow({ availability: { mcp: false, cli: true } });
      const ctx = createContext({ runtime: 'mcp' });
      expect(isWorkflowEnabledForRuntime(workflow, ctx)).toBe(false);
    });

    it('should return false when predicate fails', () => {
      const workflow = createWorkflow({ predicates: ['debugEnabled'] });
      const ctx = createContext({
        runtime: 'mcp',
        config: createDefaultConfig({ debug: false }),
      });
      expect(isWorkflowEnabledForRuntime(workflow, ctx)).toBe(false);
    });
  });

  describe('isToolAvailableForRuntime', () => {
    it('should return true when tool is available for runtime', () => {
      const tool = createTool({ availability: { mcp: true, cli: false } });
      expect(isToolAvailableForRuntime(tool, 'mcp')).toBe(true);
    });

    it('should return false when tool is not available for runtime', () => {
      const tool = createTool({ availability: { mcp: false, cli: true } });
      expect(isToolAvailableForRuntime(tool, 'mcp')).toBe(false);
    });

    it('should ignore manifest availability in daemon runtime', () => {
      const tool = createTool({ availability: { mcp: false, cli: false } });
      expect(isToolAvailableForRuntime(tool, 'daemon')).toBe(true);
    });
  });

  describe('isToolExposedForRuntime', () => {
    it('should return true when available and predicates pass', () => {
      const tool = createTool();
      const ctx = createContext({ runtime: 'mcp' });
      expect(isToolExposedForRuntime(tool, ctx)).toBe(true);
    });

    it('should return false when not available', () => {
      const tool = createTool({ availability: { mcp: false, cli: true } });
      const ctx = createContext({ runtime: 'mcp' });
      expect(isToolExposedForRuntime(tool, ctx)).toBe(false);
    });

    it('should return false when hideWhenXcodeAgentMode predicate fails (running under Xcode)', () => {
      const tool = createTool({ predicates: ['hideWhenXcodeAgentMode'] });
      const ctx = createContext({
        runtime: 'mcp',
        runningUnderXcode: true,
      });
      expect(isToolExposedForRuntime(tool, ctx)).toBe(false);
    });

    it('should return true when hideWhenXcodeAgentMode predicate passes (not under Xcode)', () => {
      const tool = createTool({ predicates: ['hideWhenXcodeAgentMode'] });
      const ctx = createContext({
        runtime: 'mcp',
        runningUnderXcode: false,
      });
      expect(isToolExposedForRuntime(tool, ctx)).toBe(true);
    });
  });

  describe('isToolInWorkflowExposed', () => {
    it('should return true when both workflow and tool are enabled', () => {
      const workflow = createWorkflow();
      const tool = createTool();
      const ctx = createContext({ runtime: 'mcp' });
      expect(isToolInWorkflowExposed(tool, workflow, ctx)).toBe(true);
    });

    it('should return false when workflow is not enabled', () => {
      const workflow = createWorkflow({
        availability: { mcp: false, cli: true },
      });
      const tool = createTool();
      const ctx = createContext({ runtime: 'mcp' });
      expect(isToolInWorkflowExposed(tool, workflow, ctx)).toBe(false);
    });

    it('should return false when tool is not exposed', () => {
      const workflow = createWorkflow();
      const tool = createTool({ availability: { mcp: false, cli: true } });
      const ctx = createContext({ runtime: 'mcp' });
      expect(isToolInWorkflowExposed(tool, workflow, ctx)).toBe(false);
    });
  });

  describe('filterExposedTools', () => {
    it('should filter out tools that are not exposed', () => {
      const tools = [
        createTool({ id: 'tool1' }),
        createTool({ id: 'tool2', availability: { mcp: false, cli: true } }),
        createTool({ id: 'tool3' }),
      ];
      const ctx = createContext({ runtime: 'mcp' });

      const filtered = filterExposedTools(tools, ctx);
      expect(filtered).toHaveLength(2);
      expect(filtered.map((t) => t.id)).toEqual(['tool1', 'tool3']);
    });
  });

  describe('filterEnabledWorkflows', () => {
    it('should filter out workflows that are not enabled', () => {
      const workflows = [
        createWorkflow({ id: 'wf1' }),
        createWorkflow({ id: 'wf2', availability: { mcp: false, cli: true } }),
        createWorkflow({ id: 'wf3' }),
      ];
      const ctx = createContext({ runtime: 'mcp' });

      const filtered = filterEnabledWorkflows(workflows, ctx);
      expect(filtered).toHaveLength(2);
      expect(filtered.map((w) => w.id)).toEqual(['wf1', 'wf3']);
    });
  });

  describe('getDefaultEnabledWorkflows', () => {
    it('should return only default-enabled workflows', () => {
      const workflows = [
        createWorkflow({
          id: 'wf1',
          selection: { mcp: { defaultEnabled: true, autoInclude: false } },
        }),
        createWorkflow({
          id: 'wf2',
          selection: { mcp: { defaultEnabled: false, autoInclude: false } },
        }),
        createWorkflow({
          id: 'wf3',
          selection: { mcp: { defaultEnabled: true, autoInclude: false } },
        }),
      ];

      const defaultEnabled = getDefaultEnabledWorkflows(workflows);
      expect(defaultEnabled).toHaveLength(2);
      expect(defaultEnabled.map((w) => w.id)).toEqual(['wf1', 'wf3']);
    });
  });

  describe('getAutoIncludeWorkflows', () => {
    it('should return auto-include workflows whose predicates pass', () => {
      const workflows = [
        createWorkflow({
          id: 'wf1',
          selection: { mcp: { defaultEnabled: false, autoInclude: true } },
          predicates: [],
        }),
        createWorkflow({
          id: 'wf2',
          selection: { mcp: { defaultEnabled: false, autoInclude: true } },
          predicates: ['debugEnabled'],
        }),
        createWorkflow({
          id: 'wf3',
          selection: { mcp: { defaultEnabled: false, autoInclude: false } },
        }),
      ];

      const ctx = createContext({
        config: createDefaultConfig({ debug: false }),
      });

      const autoInclude = getAutoIncludeWorkflows(workflows, ctx);
      expect(autoInclude).toHaveLength(1);
      expect(autoInclude[0].id).toBe('wf1');
    });

    it('should include auto-include workflows when their predicates pass', () => {
      const workflows = [
        createWorkflow({
          id: 'doctor',
          selection: { mcp: { defaultEnabled: false, autoInclude: true } },
          predicates: ['debugEnabled'],
        }),
      ];

      const ctx = createContext({
        config: createDefaultConfig({ debug: true }),
      });

      const autoInclude = getAutoIncludeWorkflows(workflows, ctx);
      expect(autoInclude).toHaveLength(1);
      expect(autoInclude[0].id).toBe('doctor');
    });
  });

  describe('selectWorkflowsForMcp', () => {
    const allWorkflows = [
      createWorkflow({
        id: 'session-management',
        selection: { mcp: { defaultEnabled: true, autoInclude: true } },
      }),
      createWorkflow({
        id: 'simulator',
        selection: { mcp: { defaultEnabled: true, autoInclude: false } },
      }),
      createWorkflow({
        id: 'device',
        selection: { mcp: { defaultEnabled: false, autoInclude: false } },
      }),
      createWorkflow({
        id: 'doctor',
        selection: { mcp: { defaultEnabled: false, autoInclude: true } },
        predicates: ['debugEnabled'],
      }),
    ];

    it('should include auto-include workflows', () => {
      const ctx = createContext();
      const selected = selectWorkflowsForMcp(allWorkflows, undefined, ctx);
      expect(selected.map((w) => w.id)).toContain('session-management');
    });

    it('should include default-enabled workflows when no workflows requested', () => {
      const ctx = createContext();
      const selected = selectWorkflowsForMcp(allWorkflows, undefined, ctx);
      expect(selected.map((w) => w.id)).toContain('simulator');
    });

    it('should include requested workflows', () => {
      const ctx = createContext();
      const selected = selectWorkflowsForMcp(allWorkflows, ['device'], ctx);
      expect(selected.map((w) => w.id)).toContain('device');
      expect(selected.map((w) => w.id)).toContain('session-management'); // autoInclude
    });

    it('should not include default-enabled when workflows are requested', () => {
      const ctx = createContext();
      const selected = selectWorkflowsForMcp(allWorkflows, ['device'], ctx);
      // simulator is default-enabled but not requested
      expect(selected.map((w) => w.id)).not.toContain('simulator');
    });

    it('should include auto-include workflows when predicates pass', () => {
      const ctx = createContext({
        config: createDefaultConfig({ debug: true }),
      });
      const selected = selectWorkflowsForMcp(allWorkflows, ['device'], ctx);
      expect(selected.map((w) => w.id)).toContain('doctor');
    });

    it('should not include auto-include workflows when predicates fail', () => {
      const ctx = createContext({
        config: createDefaultConfig({ debug: false }),
      });
      const selected = selectWorkflowsForMcp(allWorkflows, ['device'], ctx);
      expect(selected.map((w) => w.id)).not.toContain('doctor');
    });
  });
});
