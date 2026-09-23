import { persistSessionDefaultsPatch } from './config-store.ts';
import { getDefaultCommandExecutor, type CommandExecutor } from './execution/index.ts';
import { inferPlatform } from './infer-platform.ts';
import { log } from './logger.ts';
import { resolveSimulatorIdToName, resolveSimulatorNameToId } from './simulator-resolver.ts';
import { sessionStore, type SessionDefaults } from './session-store.ts';

type RefreshReason = 'startup-hydration' | 'session-set-defaults';

export interface ScheduleSimulatorDefaultsRefreshOptions {
  executor?: CommandExecutor;
  expectedRevision: number;
  reason: RefreshReason;
  profile: string | null;
  persist?: boolean;
  simulatorId?: string;
  simulatorName?: string;
  recomputePlatform?: boolean;
}

function shouldSkipBackgroundRefresh(): boolean {
  return process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
}

export function scheduleSimulatorDefaultsRefresh(
  options: ScheduleSimulatorDefaultsRefreshOptions,
): boolean {
  const hasSelector = options.simulatorId != null || options.simulatorName != null;
  if (!hasSelector) {
    return false;
  }

  if (shouldSkipBackgroundRefresh()) {
    return false;
  }

  setTimeout(() => {
    void refreshSimulatorDefaults(options);
  }, 0);

  return true;
}

/**
 * Background refresh that keeps the simulator session defaults coherent.
 *
 * Contract (do not change without understanding the team-sharing model):
 * - `simulatorName` is the CANONICAL, machine-portable selector. Project
 *   config (`.mobilebuildmcp/config.yaml`) is commonly committed to SCM and
 *   shared across a team, and simulator UDIDs differ per machine even for
 *   identically-named simulators.
 * - `simulatorId` is a machine-local materialization of that name. When a
 *   name is set, name -> id resolution runs here and MAY update the stored id
 *   (e.g. a teammate's UDID from a checked-out config is replaced with this
 *   machine's UDID for the same-named simulator).
 * - id -> name resolution only runs when no name is stored (seeds the
 *   portable selector from a pinned id).
 * - If resolution fails (no available simulator matches), the stored defaults
 *   are left untouched — never clobbered.
 * - `simulatorPlatform` is a cache derived from the resolved device runtime;
 *   it must be recomputed whenever the selector changes and cleared by any
 *   code path that overwrites the selector without recomputing it.
 * - This refresh runs only in MCP server paths (startup hydration,
 *   session-set-defaults). One-shot CLI invocations deliberately do NOT
 *   re-materialize ids: the CLI is used by CI workflows/scripts and must be
 *   deterministic — a stale/foreign UDID fails fast with a clear error rather
 *   than silently resolving to a different device.
 */
async function refreshSimulatorDefaults(
  options: ScheduleSimulatorDefaultsRefreshOptions,
): Promise<void> {
  let simulatorId = options.simulatorId;
  let simulatorName = options.simulatorName;
  const patch: Partial<SessionDefaults> = {};
  const executor = options.executor ?? getDefaultCommandExecutor();

  try {
    if (simulatorName) {
      // simulatorName is the canonical, machine-portable selector: config.yaml is
      // often shared in SCM, and simulator UDIDs differ per machine even for
      // identically-named simulators. Re-resolving name -> id here materializes
      // the id for THIS machine so downstream tools can pin an exact device.
      const resolution = await resolveSimulatorNameToId(executor, simulatorName);
      if (resolution.success && resolution.simulatorId !== simulatorId) {
        simulatorId = resolution.simulatorId;
        patch.simulatorId = resolution.simulatorId;
      } else if (!resolution.success) {
        // No available simulator matches the name — leave the stored defaults
        // untouched rather than clobbering them.
        log(
          'info',
          `[Session] Simulator name did not resolve during ${options.reason} refresh: ${resolution.error}`,
        );
      }
    } else if (simulatorId) {
      const resolution = await resolveSimulatorIdToName(executor, simulatorId);
      if (resolution.success) {
        simulatorName = resolution.simulatorName;
        patch.simulatorName = resolution.simulatorName;
      }
    }

    const shouldRecomputePlatform = options.recomputePlatform ?? true;
    let platformRecomputed = false;
    if (shouldRecomputePlatform && (simulatorId || simulatorName)) {
      try {
        const inferred = await inferPlatform(
          {
            simulatorId,
            simulatorName,
            sessionDefaults: {
              ...sessionStore.getAllForProfile(options.profile),
              ...patch,
              simulatorId,
              simulatorName,
              simulatorPlatform: undefined,
            },
          },
          executor,
        );
        patch.simulatorPlatform = inferred.platform;
        platformRecomputed = true;
      } catch (error) {
        log(
          'info',
          `[Session] Could not infer simulator platform during ${options.reason} refresh: ${String(error)}`,
        );
      }
    }

    const deleteKeys: (keyof SessionDefaults)[] = [];
    if (patch.simulatorId != null && !platformRecomputed) {
      // Invariant: a changed selector must never keep the previous device's
      // cached platform. Drop the cache and let the next inference resolve
      // it from simctl.
      patch.simulatorPlatform = undefined;
      deleteKeys.push('simulatorPlatform');
    }

    if (Object.keys(patch).length === 0) {
      return;
    }

    const applied = sessionStore.setDefaultsIfRevisionForProfile(
      options.profile,
      patch,
      options.expectedRevision,
    );
    if (!applied) {
      log(
        'info',
        `[Session] Skipped background simulator defaults refresh (${options.reason}) because defaults changed during refresh.`,
      );
      return;
    }

    if (options.persist) {
      await persistSessionDefaultsPatch({ patch, deleteKeys, profile: options.profile });
    }
  } catch (error) {
    log(
      'warn',
      `[Session] Background simulator defaults refresh failed (${options.reason}): ${String(error)}`,
    );
  }
}
