/**
 * Predicate registry for tool/workflow visibility filtering.
 * YAML manifests reference predicate names; this registry provides the implementations.
 */

import type { PredicateFn, PredicateContext } from './predicate-types.ts';

/**
 * Registry of named predicate functions.
 * All predicates return true to show the tool/workflow, false to hide.
 */
export const PREDICATES: Record<string, PredicateFn> = {
  /**
   * Show only when debug mode is enabled in config.
   */
  debugEnabled: (ctx: PredicateContext): boolean => ctx.config.debug,

  /**
   * Show only when experimental workflow discovery is enabled.
   */
  experimentalWorkflowDiscoveryEnabled: (ctx: PredicateContext): boolean =>
    ctx.config.experimentalWorkflowDiscovery,

  /**
   * Show only when running under Xcode's coding agent.
   * Use for tools/workflows that require the Xcode environment.
   */
  runningUnderXcodeAgent: (ctx: PredicateContext): boolean => ctx.runningUnderXcode === true,

  /**
   * Show only for MCP runtime.
   * Use for MCP-only gateway tools that should not appear in CLI workflows.
   */
  mcpRuntimeOnly: (ctx: PredicateContext): boolean => ctx.runtime === 'mcp',

  /**
   * Hide when running inside Xcode's coding agent.
   * Use for MobileBuildMCP tools that conflict with Xcode's native equivalents.
   */
  hideWhenXcodeAgentMode: (ctx: PredicateContext): boolean => !ctx.runningUnderXcode,

  /**
   * Show only when Xcode auto-sync is disabled AND running under Xcode.
   * Use for the manual sync tool that should appear when automatic sync is turned off.
   */
  xcodeAutoSyncDisabled: (ctx: PredicateContext): boolean =>
    ctx.runningUnderXcode === true && ctx.config.disableXcodeAutoSync === true,

  /**
   * Always visible - useful for explicit documentation in YAML.
   */
  always: (): boolean => true,

  /**
   * Never visible - useful for temporarily disabling tools.
   */
  never: (): boolean => false,
};

/**
 * Evaluate a list of predicate names against a context.
 * All predicates must pass (AND logic) for the result to be true.
 *
 * @param names - Array of predicate names to evaluate
 * @param ctx - Predicate context
 * @returns true if all predicates pass, false if any fails
 * @throws Error if an unknown predicate name is referenced
 */
export function evalPredicates(names: string[] | undefined, ctx: PredicateContext): boolean {
  if (!names || names.length === 0) {
    return true;
  }

  for (const name of names) {
    const fn = PREDICATES[name];
    if (!fn) {
      throw new Error(
        `Unknown predicate '${name}'. Available predicates: ${Object.keys(PREDICATES).join(', ')}`,
      );
    }
    if (!fn(ctx)) {
      return false;
    }
  }
  return true;
}

/**
 * Get all available predicate names.
 */
export function getPredicateNames(): string[] {
  return Object.keys(PREDICATES);
}

/**
 * Check if a predicate name is valid.
 */
export function isValidPredicate(name: string): boolean {
  return name in PREDICATES;
}
