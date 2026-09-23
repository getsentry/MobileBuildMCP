import { XcodePlatform } from '../types/common.ts';
import type { CommandExecutor } from './execution/index.ts';
import { getDefaultCommandExecutor } from './execution/index.ts';
import { log } from './logging/index.ts';
import type { SimulatorPlatform } from './platform-detection.ts';
import { sessionStore, type SessionDefaults } from './session-store.ts';

type PlatformInferenceSource = 'simulator-platform-cache' | 'simulator-name' | 'simulator-runtime';

export interface InferPlatformParams {
  projectPath?: string;
  workspacePath?: string;
  scheme?: string;
  simulatorId?: string;
  simulatorName?: string;
  sessionDefaults?: Partial<SessionDefaults>;
}

export interface InferPlatformResult {
  platform: SimulatorPlatform;
  source: PlatformInferenceSource;
}

const SIMULATOR_PLATFORMS: readonly SimulatorPlatform[] = [
  XcodePlatform.iOSSimulator,
  XcodePlatform.watchOSSimulator,
  XcodePlatform.tvOSSimulator,
  XcodePlatform.visionOSSimulator,
] as const;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function inferPlatformFromSimulatorName(simulatorName: string): SimulatorPlatform | null {
  const name = simulatorName.toLowerCase();

  if (name.includes('watch')) return XcodePlatform.watchOSSimulator;
  if (name.includes('apple tv') || name.includes('tvos')) return XcodePlatform.tvOSSimulator;
  if (
    name.includes('apple vision') ||
    name.includes('vision pro') ||
    name.includes('visionos') ||
    name.includes('xros')
  ) {
    return XcodePlatform.visionOSSimulator;
  }
  if (name.includes('iphone') || name.includes('ipad') || name.includes('ipod')) {
    return XcodePlatform.iOSSimulator;
  }

  return null;
}

export function inferPlatformFromRuntime(runtime: string): SimulatorPlatform | null {
  const value = runtime.toLowerCase();

  if (value.includes('simruntime.watchos') || value.startsWith('watchos')) {
    return XcodePlatform.watchOSSimulator;
  }
  if (
    value.includes('simruntime.tvos') ||
    value.includes('simruntime.appletv') ||
    value.startsWith('tvos')
  ) {
    return XcodePlatform.tvOSSimulator;
  }
  if (
    value.includes('simruntime.xros') ||
    value.includes('simruntime.visionos') ||
    value.startsWith('xros') ||
    value.startsWith('visionos')
  ) {
    return XcodePlatform.visionOSSimulator;
  }
  if (value.includes('simruntime.ios') || value.startsWith('ios')) {
    return XcodePlatform.iOSSimulator;
  }

  return null;
}

function isSimulatorPlatform(value: unknown): value is SimulatorPlatform {
  return SIMULATOR_PLATFORMS.includes(value as SimulatorPlatform);
}

function inferSimulatorSelectorForTool(params: {
  simulatorId?: string;
  simulatorName?: string;
  sessionDefaults?: Partial<SessionDefaults>;
}): { simulatorId?: string; simulatorName?: string } {
  const defaults = params.sessionDefaults ?? sessionStore.getAll();

  if (params.simulatorId) {
    return { simulatorId: params.simulatorId };
  }
  if (params.simulatorName) {
    return { simulatorName: params.simulatorName };
  }
  if (defaults.simulatorId) {
    return { simulatorId: defaults.simulatorId };
  }
  if (defaults.simulatorName) {
    return { simulatorName: defaults.simulatorName };
  }

  return {};
}

function resolveCachedPlatform(params: InferPlatformParams): SimulatorPlatform | null {
  const defaults = params.sessionDefaults ?? sessionStore.getAll();
  if (!isSimulatorPlatform(defaults.simulatorPlatform)) {
    return null;
  }

  const hasExplicitId = Boolean(params.simulatorId);
  const hasExplicitName = Boolean(params.simulatorName);

  if (!hasExplicitId && !hasExplicitName) {
    return defaults.simulatorPlatform;
  }

  if (hasExplicitId && defaults.simulatorId && params.simulatorId === defaults.simulatorId) {
    return defaults.simulatorPlatform;
  }

  if (
    hasExplicitName &&
    defaults.simulatorName &&
    params.simulatorName === defaults.simulatorName
  ) {
    return defaults.simulatorPlatform;
  }

  return null;
}

async function inferPlatformFromSimctl(
  simulatorId: string | undefined,
  simulatorName: string | undefined,
  executor: CommandExecutor,
): Promise<SimulatorPlatform | null> {
  if (!simulatorId && !simulatorName) return null;

  const result = await executor(
    ['xcrun', 'simctl', 'list', 'devices', 'available', '--json'],
    'Infer Simulator Platform',
    true,
  );

  if (!result.success) {
    log('warn', `[Platform Inference] simctl failed: ${result.error ?? 'Unknown error'}`);
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.output);
  } catch {
    log('warn', `[Platform Inference] Failed to parse simctl JSON output`);
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || !('devices' in parsed)) {
    log('warn', `[Platform Inference] simctl JSON missing devices`);
    return null;
  }

  const devices = (parsed as { devices: Record<string, unknown[]> }).devices;
  for (const runtime of Object.keys(devices)) {
    const list = devices[runtime];
    if (!Array.isArray(list)) continue;

    for (const device of list) {
      if (!device || typeof device !== 'object') continue;
      const current = device as {
        udid?: unknown;
        name?: unknown;
        isAvailable?: unknown;
      };

      if (simulatorId) {
        const matchesId = typeof current.udid === 'string' && current.udid === simulatorId;
        if (!matchesId) continue;
      } else {
        const matchesName = typeof current.name === 'string' && current.name === simulatorName;
        if (!matchesName) continue;
      }
      if (typeof current.isAvailable === 'boolean' && !current.isAvailable) continue;

      return inferPlatformFromRuntime(runtime);
    }
  }

  return null;
}

/**
 * Determine the simulator platform for a simulator selector.
 *
 * Precedence (all sources are authoritative — derived from the device itself):
 * 1. `sessionDefaults.simulatorPlatform` cache, only when the selector matches
 *    the session defaults it was computed for (written by setup and the
 *    background defaults refresh; invalidated whenever the selector changes).
 * 2. The device's runtime from `simctl list devices available`.
 * 3. The simulator name heuristic (e.g. "iPhone ..." -> iOS Simulator).
 *
 * There is deliberately NO fallback beyond these: guessing from project build
 * settings (SUPPORTED_PLATFORMS) or defaulting to iOS produced wrong,
 * non-deterministic destinations for multi-platform projects. If none of the
 * sources resolve, this throws so callers surface a clear error instead of
 * building for the wrong platform.
 */
export async function inferPlatform(
  params: InferPlatformParams,
  executor: CommandExecutor = getDefaultCommandExecutor(),
): Promise<InferPlatformResult> {
  const cachedPlatform = resolveCachedPlatform(params);
  if (cachedPlatform) {
    return { platform: cachedPlatform, source: 'simulator-platform-cache' };
  }

  const { simulatorId, simulatorName } = inferSimulatorSelectorForTool({
    simulatorId: params.simulatorId,
    simulatorName: params.simulatorName,
    sessionDefaults: params.sessionDefaults,
  });

  let simulatorIdForLookup = simulatorId;
  let simulatorNameForLookup = simulatorName;
  if (!simulatorIdForLookup && simulatorName && UUID_REGEX.test(simulatorName)) {
    simulatorIdForLookup = simulatorName;
    simulatorNameForLookup = undefined;
  }

  const inferredFromRuntime = await inferPlatformFromSimctl(
    simulatorIdForLookup,
    simulatorNameForLookup,
    executor,
  );
  if (inferredFromRuntime) {
    return { platform: inferredFromRuntime, source: 'simulator-runtime' };
  }

  if (simulatorNameForLookup) {
    const inferredFromName = inferPlatformFromSimulatorName(simulatorNameForLookup);
    if (inferredFromName) {
      return { platform: inferredFromName, source: 'simulator-name' };
    }
  }

  const selector =
    simulatorIdForLookup != null
      ? `simulator id "${simulatorIdForLookup}"`
      : simulatorNameForLookup != null
        ? `simulator name "${simulatorNameForLookup}"`
        : 'the configured simulator';

  throw new Error(
    `Unable to determine the simulator platform for ${selector}. The simulator was not found ` +
      `among available devices — its runtime may not be installed. Run 'mobilebuildmcp setup' to ` +
      `select an available simulator, or use the simulator list tool to see installed simulators.`,
  );
}
