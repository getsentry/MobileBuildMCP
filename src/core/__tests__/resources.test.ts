import { describe, it, expect, beforeEach, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { PredicateContext } from '../../visibility/predicate-types.ts';
import type { ResolvedRuntimeConfig } from '../../utils/config-store.ts';
import type { ResourceManifestEntry, ResolvedManifest } from '../manifest/schema.ts';

vi.mock('../manifest/load-manifest.ts', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    loadManifest: vi.fn(),
  };
});

vi.mock('../manifest/import-resource-module.ts', () => ({
  importResourceModule: vi.fn(),
}));

import { registerResources, getAvailableResources, loadResources } from '../resources.ts';
import { loadManifest } from '../manifest/load-manifest.ts';
import { importResourceModule } from '../manifest/import-resource-module.ts';

function createTestContext(overrides: Partial<PredicateContext> = {}): PredicateContext {
  return {
    runtime: 'mcp',
    config: {} as ResolvedRuntimeConfig,
    runningUnderXcode: false,
    ...overrides,
  };
}

const mockHandler = vi.fn(async () => ({ contents: [{ text: 'mock' }] }));

function createMockManifest(resources: ResourceManifestEntry[]): ResolvedManifest {
  return {
    tools: new Map(),
    workflows: new Map(),
    resources: new Map(resources.map((r) => [r.id, r])),
  };
}

const simulatorsResource: ResourceManifestEntry = {
  id: 'simulators',
  module: 'mcp/resources/simulators',
  name: 'simulators',
  uri: 'mobilebuildmcp://simulators',
  description: 'Available iOS simulators with their UUIDs and states',
  mimeType: 'text/plain',
  availability: { mcp: true },
  predicates: [],
};

const xcodeIdeStateResource: ResourceManifestEntry = {
  id: 'xcode-ide-state',
  module: 'mcp/resources/xcode-ide-state',
  name: 'xcode-ide-state',
  uri: 'mobilebuildmcp://xcode-ide-state',
  description: "Current Xcode IDE selection (scheme and simulator) from Xcode's UI state",
  mimeType: 'application/json',
  availability: { mcp: true },
  predicates: ['runningUnderXcodeAgent'],
};

describe('resources', () => {
  let mockServer: McpServer;
  let registeredResources: Array<{
    name: string;
    uri: string;
    metadata: { mimeType: string; title: string };
    handler: any;
  }>;

  beforeEach(() => {
    vi.clearAllMocks();
    registeredResources = [];
    mockServer = {
      resource: (
        name: string,
        uri: string,
        metadata: { mimeType: string; title: string },
        handler: any,
      ) => {
        registeredResources.push({ name, uri, metadata, handler });
      },
    } as unknown as McpServer;

    vi.mocked(loadManifest).mockReturnValue(
      createMockManifest([simulatorsResource, xcodeIdeStateResource]),
    );
    vi.mocked(importResourceModule).mockResolvedValue({ handler: mockHandler });
  });

  describe('Exports', () => {
    it('should export registerResources function', () => {
      expect(typeof registerResources).toBe('function');
    });

    it('should export getAvailableResources function', () => {
      expect(typeof getAvailableResources).toBe('function');
    });

    it('should export loadResources function', () => {
      expect(typeof loadResources).toBe('function');
    });
  });

  describe('loadResources', () => {
    it('should load resources from manifests', async () => {
      const ctx = createTestContext();
      const resources = await loadResources(ctx);

      expect(resources.size).toBeGreaterThan(0);
      expect(resources.has('mobilebuildmcp://simulators')).toBe(true);
    });

    it('should validate resource structure', async () => {
      const ctx = createTestContext();
      const resources = await loadResources(ctx);

      for (const [uri, resource] of resources) {
        expect(resource.uri).toBe(uri);
        expect(typeof resource.description).toBe('string');
        expect(typeof resource.mimeType).toBe('string');
        expect(typeof resource.handler).toBe('function');
      }
    });

    it('should filter out xcode-ide-state when not running under Xcode', async () => {
      const ctx = createTestContext({ runningUnderXcode: false });
      const resources = await loadResources(ctx);

      expect(resources.has('mobilebuildmcp://xcode-ide-state')).toBe(false);
    });

    it('should include xcode-ide-state when running under Xcode', async () => {
      const ctx = createTestContext({ runningUnderXcode: true });
      const resources = await loadResources(ctx);

      expect(resources.has('mobilebuildmcp://xcode-ide-state')).toBe(true);
    });
  });

  describe('registerResources', () => {
    it('should register all loaded resources with the server and return true', async () => {
      const ctx = createTestContext();
      const result = await registerResources(mockServer, ctx);

      expect(result).toBe(true);
      expect(registeredResources.length).toBeGreaterThan(0);

      const simResource = registeredResources.find((r) => r.uri === 'mobilebuildmcp://simulators');
      expect(typeof simResource?.handler).toBe('function');
      expect(simResource?.metadata.title).toBe(
        'Available iOS simulators with their UUIDs and states',
      );
      expect(simResource?.metadata.mimeType).toBe('text/plain');
      expect(simResource?.name).toBe('simulators');
    });

    it('should register resources with correct handlers', async () => {
      const ctx = createTestContext();
      const result = await registerResources(mockServer, ctx);

      expect(result).toBe(true);

      const simResource = registeredResources.find((r) => r.uri === 'mobilebuildmcp://simulators');
      expect(typeof simResource?.handler).toBe('function');
    });

    it('should not register xcode-ide-state outside of Xcode', async () => {
      const ctx = createTestContext({ runningUnderXcode: false });
      await registerResources(mockServer, ctx);

      const xcodeResource = registeredResources.find(
        (r) => r.uri === 'mobilebuildmcp://xcode-ide-state',
      );
      expect(xcodeResource).toBeUndefined();
    });
  });

  describe('getAvailableResources', () => {
    it('should return array of available resource URIs', async () => {
      const ctx = createTestContext();
      const resources = await getAvailableResources(ctx);

      expect(Array.isArray(resources)).toBe(true);
      expect(resources.length).toBeGreaterThan(0);
      expect(resources).toContain('mobilebuildmcp://simulators');
    });

    it('should return unique URIs', async () => {
      const ctx = createTestContext();
      const resources = await getAvailableResources(ctx);
      const uniqueResources = [...new Set(resources)];

      expect(resources.length).toBe(uniqueResources.length);
    });
  });
});
