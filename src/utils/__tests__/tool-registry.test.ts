import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ToolSchemaShape } from '../../core/plugin-types.ts';
import type { ResolvedManifest } from '../../core/manifest/schema.ts';
import type { PredicateContext } from '../../visibility/predicate-types.ts';

const testState = vi.hoisted(() => {
  const registeredTools = new Map<string, { remove: ReturnType<typeof vi.fn> }>();
  return {
    manifest: undefined as ResolvedManifest | undefined,
    importToolModule: vi.fn(),
    registeredTools,
    server: {
      registerTool: vi.fn((name: string) => {
        const registeredTool = { remove: vi.fn() };
        registeredTools.set(name, registeredTool);
        return registeredTool;
      }),
    },
  };
});

vi.mock('../../server/server-state.ts', () => ({
  server: testState.server,
}));

vi.mock('../../core/manifest/load-manifest.ts', () => ({
  loadManifest: () => {
    if (!testState.manifest) {
      throw new Error('No manifest configured for test');
    }
    return testState.manifest;
  },
}));

vi.mock('../../core/manifest/import-tool-module.ts', () => ({
  importToolModule: testState.importToolModule,
}));

import {
  __resetToolRegistryForTests,
  applyWorkflowSelectionFromManifest,
  createCustomWorkflowsFromConfig,
} from '../tool-registry.ts';

function createManifestFixture(): ResolvedManifest {
  return {
    tools: new Map([
      [
        'build_run_sim',
        {
          id: 'build_run_sim',
          module: 'mcp/tools/simulator/build_run_sim',
          names: { mcp: 'build_run_sim' },
          availability: { mcp: true, cli: true },
          predicates: [],
          nextSteps: [],
        },
      ],
      [
        'screenshot',
        {
          id: 'screenshot',
          module: 'mcp/tools/ui-automation/screenshot',
          names: { mcp: 'screenshot' },
          availability: { mcp: true, cli: true },
          predicates: [],
          nextSteps: [],
        },
      ],
    ]),
    workflows: new Map([
      [
        'simulator',
        {
          id: 'simulator',
          title: 'Simulator',
          description: 'Built-in simulator workflow',
          targetPlatforms: ['iOS'],
          availability: { mcp: true, cli: true },
          selection: { mcp: { defaultEnabled: true, autoInclude: false } },
          predicates: [],
          tools: ['build_run_sim'],
        },
      ],
    ]),
    resources: new Map(),
  };
}

function createToolModule() {
  return {
    schema: {} as ToolSchemaShape,
    handler: vi.fn().mockResolvedValue({ content: [] }),
  };
}

function createPredicateContext(): PredicateContext {
  return {
    runtime: 'mcp',
    config: {
      enabledWorkflows: [],
      customWorkflows: {},
      debug: false,
      sentryDisabled: false,
      experimentalWorkflowDiscovery: false,
      disableSessionDefaults: false,
      disableXcodeAutoSync: false,
      showTestTiming: false,
      uiDebuggerGuardMode: 'error',
      incrementalBuildsEnabled: false,
      testProductsMaxCount: 3,
      testProductsMaxAgeDays: 1,
      dapRequestTimeoutMs: 30_000,
      dapLogEvents: false,
      launchJsonWaitMs: 8000,
      debuggerBackend: 'dap',
    },
    runningUnderXcode: false,
  };
}

describe('createCustomWorkflowsFromConfig', () => {
  it('creates custom workflows and resolves tool IDs', () => {
    const manifest = createManifestFixture();

    const result = createCustomWorkflowsFromConfig(manifest, {
      'My-Workflow': ['build_run_sim', 'SCREENSHOT'],
    });

    expect(result.workflows).toEqual([
      expect.objectContaining({
        id: 'my-workflow',
        targetPlatforms: [],
        tools: ['build_run_sim', 'screenshot'],
      }),
    ]);
    expect(result.warnings).toEqual([]);
  });

  it('warns when built-in workflow names conflict or tools are unknown', () => {
    const manifest = createManifestFixture();

    const result = createCustomWorkflowsFromConfig(manifest, {
      simulator: ['build_run_sim'],
      quick: ['unknown_tool'],
    });

    expect(result.workflows).toEqual([]);
    expect(result.warnings).toHaveLength(3);
  });
});

describe('applyWorkflowSelectionFromManifest', () => {
  beforeEach(() => {
    __resetToolRegistryForTests();
    testState.manifest = createManifestFixture();
    testState.importToolModule.mockReset();
    testState.server.registerTool.mockClear();
    testState.registeredTools.clear();
  });

  it('removes a stale registered tool when its module no longer imports', async () => {
    testState.importToolModule.mockResolvedValueOnce(createToolModule());

    const initialRegistration = await applyWorkflowSelectionFromManifest(
      undefined,
      createPredicateContext(),
    );

    const registeredTool = testState.registeredTools.get('build_run_sim');
    expect(initialRegistration.registeredToolCount).toBe(1);
    expect(registeredTool).toBeDefined();

    testState.importToolModule.mockRejectedValueOnce(new Error('import failed'));

    const nextRegistration = await applyWorkflowSelectionFromManifest(
      undefined,
      createPredicateContext(),
    );

    expect(nextRegistration.registeredToolCount).toBe(0);
    expect(registeredTool?.remove).toHaveBeenCalledTimes(1);
  });
});
