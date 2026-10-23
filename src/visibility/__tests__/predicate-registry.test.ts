import { describe, it, expect } from 'vitest';
import {
  PREDICATES,
  evalPredicates,
  getPredicateNames,
  isValidPredicate,
} from '../predicate-registry.ts';
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

describe('predicate-registry', () => {
  describe('PREDICATES', () => {
    describe('debugEnabled', () => {
      it('should return true when debug is enabled', () => {
        const ctx = createContext({
          config: createDefaultConfig({ debug: true }),
        });
        expect(PREDICATES.debugEnabled(ctx)).toBe(true);
      });

      it('should return false when debug is disabled', () => {
        const ctx = createContext({
          config: createDefaultConfig({ debug: false }),
        });
        expect(PREDICATES.debugEnabled(ctx)).toBe(false);
      });
    });

    describe('experimentalWorkflowDiscoveryEnabled', () => {
      it('should return true when experimental workflow discovery is enabled', () => {
        const ctx = createContext({
          config: createDefaultConfig({ experimentalWorkflowDiscovery: true }),
        });
        expect(PREDICATES.experimentalWorkflowDiscoveryEnabled(ctx)).toBe(true);
      });

      it('should return false when experimental workflow discovery is disabled', () => {
        const ctx = createContext({
          config: createDefaultConfig({ debug: false }),
        });
        expect(PREDICATES.experimentalWorkflowDiscoveryEnabled(ctx)).toBe(false);
      });
    });

    describe('runningUnderXcodeAgent', () => {
      it('should return true when running under Xcode', () => {
        const ctx = createContext({ runningUnderXcode: true });
        expect(PREDICATES.runningUnderXcodeAgent(ctx)).toBe(true);
      });

      it('should return false when not running under Xcode', () => {
        const ctx = createContext({ runningUnderXcode: false });
        expect(PREDICATES.runningUnderXcodeAgent(ctx)).toBe(false);
      });
    });

    describe('mcpRuntimeOnly', () => {
      it('should return true for MCP runtime', () => {
        const ctx = createContext({ runtime: 'mcp' });
        expect(PREDICATES.mcpRuntimeOnly(ctx)).toBe(true);
      });

      it('should return false for CLI runtime', () => {
        const ctx = createContext({ runtime: 'cli' });
        expect(PREDICATES.mcpRuntimeOnly(ctx)).toBe(false);
      });
    });

    describe('hideWhenXcodeAgentMode', () => {
      it('should return true when not running under Xcode', () => {
        const ctx = createContext({ runningUnderXcode: false });
        expect(PREDICATES.hideWhenXcodeAgentMode(ctx)).toBe(true);
      });

      it('should return false when running under Xcode', () => {
        const ctx = createContext({ runningUnderXcode: true });
        expect(PREDICATES.hideWhenXcodeAgentMode(ctx)).toBe(false);
      });
    });

    describe('xcodeAutoSyncDisabled', () => {
      it('should return true when running under Xcode AND auto-sync is disabled', () => {
        const ctx = createContext({
          runningUnderXcode: true,
          config: createDefaultConfig({ disableXcodeAutoSync: true }),
        });
        expect(PREDICATES.xcodeAutoSyncDisabled(ctx)).toBe(true);
      });

      it('should return false when running under Xcode but auto-sync is enabled', () => {
        const ctx = createContext({
          runningUnderXcode: true,
          config: createDefaultConfig({ disableXcodeAutoSync: false }),
        });
        expect(PREDICATES.xcodeAutoSyncDisabled(ctx)).toBe(false);
      });

      it('should return false when not running under Xcode even if auto-sync is disabled', () => {
        const ctx = createContext({
          runningUnderXcode: false,
          config: createDefaultConfig({ disableXcodeAutoSync: true }),
        });
        expect(PREDICATES.xcodeAutoSyncDisabled(ctx)).toBe(false);
      });

      it('should return false when not running under Xcode and auto-sync is enabled', () => {
        const ctx = createContext({
          runningUnderXcode: false,
          config: createDefaultConfig({ disableXcodeAutoSync: false }),
        });
        expect(PREDICATES.xcodeAutoSyncDisabled(ctx)).toBe(false);
      });
    });

    describe('always', () => {
      it('should always return true', () => {
        const ctx = createContext();
        expect(PREDICATES.always(ctx)).toBe(true);
      });
    });

    describe('never', () => {
      it('should always return false', () => {
        const ctx = createContext();
        expect(PREDICATES.never(ctx)).toBe(false);
      });
    });
  });

  describe('evalPredicates', () => {
    it('should return true for empty predicate list', () => {
      const ctx = createContext();
      expect(evalPredicates([], ctx)).toBe(true);
    });

    it('should return true for undefined predicate list', () => {
      const ctx = createContext();
      expect(evalPredicates(undefined, ctx)).toBe(true);
    });

    it('should return true when all predicates pass', () => {
      const ctx = createContext({
        config: createDefaultConfig({ debug: true, experimentalWorkflowDiscovery: true }),
      });
      expect(evalPredicates(['debugEnabled', 'experimentalWorkflowDiscoveryEnabled'], ctx)).toBe(
        true,
      );
    });

    it('should return false when any predicate fails', () => {
      const ctx = createContext({
        config: createDefaultConfig({ debug: true }),
      });
      expect(evalPredicates(['debugEnabled', 'experimentalWorkflowDiscoveryEnabled'], ctx)).toBe(
        false,
      );
    });

    it('should throw for unknown predicate', () => {
      const ctx = createContext();
      expect(() => evalPredicates(['unknownPredicate'], ctx)).toThrow(
        "Unknown predicate 'unknownPredicate'",
      );
    });
  });

  describe('getPredicateNames', () => {
    it('should return all predicate names', () => {
      const names = getPredicateNames();
      expect(names).toContain('debugEnabled');
      expect(names).toContain('experimentalWorkflowDiscoveryEnabled');
      expect(names).toContain('runningUnderXcodeAgent');
      expect(names).toContain('mcpRuntimeOnly');
      expect(names).toContain('hideWhenXcodeAgentMode');
      expect(names).toContain('xcodeAutoSyncDisabled');
      expect(names).toContain('always');
      expect(names).toContain('never');
    });
  });

  describe('isValidPredicate', () => {
    it('should return true for valid predicates', () => {
      expect(isValidPredicate('debugEnabled')).toBe(true);
      expect(isValidPredicate('hideWhenXcodeAgentMode')).toBe(true);
    });

    it('should return false for invalid predicates', () => {
      expect(isValidPredicate('unknownPredicate')).toBe(false);
      expect(isValidPredicate('')).toBe(false);
    });
  });
});
