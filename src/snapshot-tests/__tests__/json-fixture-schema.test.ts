import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { loadManifest } from '../../core/manifest/load-manifest.ts';
import { assertCodex031InputSchemaCompatible } from '../codex-031-input-schema.ts';
import { createStructuredFixtureSchemaValidator } from '../json-schema-validation.ts';
import { createMcpSnapshotHarness, type McpSnapshotHarness } from '../mcp-harness.ts';
import { expectMcpToolContractFixtures } from '../mcp-tool-contract-fixtures.ts';

const validator = createStructuredFixtureSchemaValidator();
const manifest = loadManifest();
let fullHarness: McpSnapshotHarness;
let adaptiveHarness: McpSnapshotHarness;
let fullTools: Tool[];
let adaptiveTools: Tool[];
const activeHarnesses: McpSnapshotHarness[] = [];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fixtureHasRequest(relativePath: string): boolean {
  const fixture = validator.fixtures.find((candidate) => candidate.relativePath === relativePath);
  if (!fixture) {
    throw new Error(`Missing JSON fixture: ${relativePath}`);
  }

  return isRecord(fixture.envelope.data) && Object.hasOwn(fixture.envelope.data, 'request');
}

beforeAll(async () => {
  const options = {
    enabledWorkflows: [...manifest.workflows.keys()],
    env: {
      MOBILEBUILDMCP_DEBUG: 'true',
      // Include predicate-gated tools in the complete public contract.
      MOBILEBUILDMCP_EXPERIMENTAL_WORKFLOW_DISCOVERY: 'true',
    },
  };
  try {
    fullHarness = await createMcpSnapshotHarness({
      ...options,
      disableSessionDefaults: true,
    });
    activeHarnesses.push(fullHarness);
    adaptiveHarness = await createMcpSnapshotHarness({
      ...options,
      disableSessionDefaults: false,
    });
    activeHarnesses.push(adaptiveHarness);
    fullTools = (await fullHarness.client.listTools()).tools;
    adaptiveTools = (await adaptiveHarness.client.listTools()).tools;
  } catch (error) {
    await Promise.all(activeHarnesses.map((harness) => harness.cleanup()));
    activeHarnesses.length = 0;
    throw error;
  }
}, 30_000);

afterAll(async () => {
  await Promise.all(activeHarnesses.map((harness) => harness.cleanup()));
  activeHarnesses.length = 0;
});

describe('structured JSON fixture schemas', () => {
  it('discovers JSON fixtures from transport/format buckets', () => {
    expect(validator.fixtures.length).toBeGreaterThan(0);
    expect(validator.fixtures.some((fixture) => fixture.relativePath.startsWith('cli/json/'))).toBe(
      true,
    );
    expect(validator.fixtures.some((fixture) => fixture.relativePath.startsWith('mcp/json/'))).toBe(
      true,
    );
    expect(
      validator.fixtures.every(
        (fixture) =>
          fixture.relativePath.startsWith('cli/json/') ||
          fixture.relativePath.startsWith('mcp/json/'),
      ),
    ).toBe(true);
  });

  it('compiles all schema documents', () => {
    expect(() => validator.compileAllSchemas()).not.toThrow();
  });

  it('converts every registered input schema in both public modes with Codex 0.31', () => {
    const incompatibilities: string[] = [];
    for (const [mode, tools] of [
      ['session defaults disabled', fullTools],
      ['session defaults enabled', adaptiveTools],
    ] as const) {
      for (const tool of tools) {
        try {
          assertCodex031InputSchemaCompatible(tool.inputSchema);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          incompatibilities.push(`${mode}: ${tool.name}: ${message}`);
        }
      }
    }

    expect(incompatibilities).toEqual([]);
  });

  it('matches one readable contract fixture per registered tool in both public modes', () => {
    expectMcpToolContractFixtures('session-defaults-disabled', fullTools);
    expectMcpToolContractFixtures('session-defaults-enabled', adaptiveTools);
  });

  it('validates every live registered output schema in both public modes', () => {
    validator.validateRegisteredOutputSchemas(fullTools);
    validator.validateRegisteredOutputSchemas(adaptiveTools);
  });

  it('normalizes JSON-shaped wire inputs at the live tool boundary', async () => {
    const sessionResult = await fullHarness.callTool('session_set_defaults', {
      env: [
        { key: 'FEATURE_FLAG', value: 'enabled' },
        { key: 'API_URL', value: 'https://example.invalid' },
      ],
    });
    expect(sessionResult.outcome).toBe('success');
    expect(sessionResult.structuredEnvelope).toMatchObject({
      schema: 'mobilebuildmcp.output.session-defaults',
      didError: false,
      data: {
        profiles: {
          '(default)': {
            env: {
              FEATURE_FLAG: 'enabled',
              API_URL: 'https://example.invalid',
            },
          },
        },
      },
    });

    const xcodeResult = await fullHarness.callTool('xcode_ide_call_tool', {
      remoteTool: 'ContractFixtureProbe',
      arguments: '{"tabIdentifier":"missing"}',
    });
    expect(xcodeResult.outcome).not.toBe('validation-error');
    expect(xcodeResult.structuredEnvelope?.schema).toBe(
      'mobilebuildmcp.output.xcode-bridge-call-result',
    );

    for (const invalidArguments of [
      'not-json',
      '["not", "an", "object"]',
      '"not an object"',
      'null',
    ]) {
      const invalidResult = await fullHarness.callTool('xcode_ide_call_tool', {
        remoteTool: 'ContractFixtureProbe',
        arguments: invalidArguments,
      });
      expect(invalidResult.structuredEnvelope).toMatchObject({
        schema: 'mobilebuildmcp.output.error',
        didError: true,
        data: { code: 'PARAMETER_VALIDATION_FAILED' },
      });
    }
  });

  it('normalizes environment entries through every live handler boundary', async () => {
    const env = [{ key: 'CONTRACT_PROBE', value: 'enabled' }];
    const missingProject = '/__mobilebuildmcp_contract_probe__/Missing.xcodeproj';
    const missingTests = '/__mobilebuildmcp_contract_probe__/Missing.xctestproducts';
    const probes = [
      {
        toolName: 'build_run_device',
        arguments: {
          projectPath: missingProject,
          scheme: 'ContractProbe',
          deviceId: 'CONTRACT-PROBE-DEVICE',
          env,
        },
        expectedSchema: 'mobilebuildmcp.output.build-run-result',
        expectedInfrastructureText: 'spawn xcodebuild ENOENT',
      },
      {
        toolName: 'launch_app_device',
        arguments: {
          deviceId: 'CONTRACT-PROBE-DEVICE',
          bundleId: 'com.example.contract-probe',
          env,
        },
        expectedSchema: 'mobilebuildmcp.output.launch-result',
        expectedInfrastructureText: 'spawn xcrun ENOENT',
      },
      {
        toolName: 'test_device',
        arguments: {
          testProductsPath: missingTests,
          deviceId: 'CONTRACT-PROBE-DEVICE',
          testRunnerEnv: env,
        },
        expectedSchema: 'mobilebuildmcp.output.test-result',
        expectedInfrastructureText: 'spawn xcodebuild ENOENT',
      },
      {
        toolName: 'test_macos',
        arguments: { testProductsPath: missingTests, testRunnerEnv: env },
        expectedSchema: 'mobilebuildmcp.output.test-result',
        expectedInfrastructureText: 'spawn xcodebuild ENOENT',
      },
      {
        toolName: 'launch_app_sim',
        arguments: {
          simulatorId: 'CONTRACT-PROBE-SIMULATOR',
          bundleId: 'com.example.contract-probe',
          env,
        },
        expectedSchema: 'mobilebuildmcp.output.launch-result',
        expectedInfrastructureText: 'spawn xcrun ENOENT',
      },
      {
        toolName: 'test_sim',
        arguments: {
          testProductsPath: missingTests,
          simulatorName: 'Contract Probe Missing Simulator',
          testRunnerEnv: env,
        },
        expectedSchema: 'mobilebuildmcp.output.test-result',
        expectedInfrastructureText: 'Unable to determine the simulator platform',
      },
    ] as const;

    for (const probe of probes) {
      const result = await fullHarness.callTool(probe.toolName, probe.arguments);
      expect(result.outcome, probe.toolName).not.toBe('success');
      expect(result.outcome, probe.toolName).not.toBe('validation-error');
      if ('expectedSchema' in probe && result.outcome === 'domain-error') {
        expect(result.structuredEnvelope?.schema, probe.toolName).toBe(probe.expectedSchema);
      }
      if (result.outcome === 'infrastructure-error') {
        expect(result.structuredEnvelope, probe.toolName).toBeNull();
        expect(result.rawText, probe.toolName).toContain(probe.expectedInfrastructureText);
      }
    }
  }, 120_000);

  it('rejects the historical schema-valued additionalProperties input', () => {
    expect(() =>
      assertCodex031InputSchemaCompatible({
        type: 'object',
        properties: {
          testRunnerEnv: {
            type: 'object',
            additionalProperties: { type: 'string' },
          },
        },
      }),
    ).toThrow(
      'inputSchema.properties.testRunnerEnv.additionalProperties: invalid type: map, expected a boolean',
    );
  });

  it('mirrors Codex 0.31 handling for unsupported types and nullable optional fields', () => {
    expect(() =>
      assertCodex031InputSchemaCompatible({
        type: 'object',
        properties: { nullableValue: { type: 'null' } },
      }),
    ).toThrow("inputSchema.properties.nullableValue.type: unsupported type 'null'");

    expect(() =>
      assertCodex031InputSchemaCompatible({
        type: 'object',
        description: null,
        properties: {},
        required: null,
        additionalProperties: null,
      }),
    ).not.toThrow();
  });

  it('mirrors Codex 0.31 top-level ToolInputSchema deserialization', () => {
    for (const inputSchema of [
      {},
      { properties: {} },
      { type: ['object', 'null'], properties: {} },
      { type: 'object', properties: {}, required: 'value' },
    ]) {
      expect(() => assertCodex031InputSchemaCompatible(inputSchema)).toThrow();
    }

    expect(() =>
      assertCodex031InputSchemaCompatible({
        type: 'object',
        properties: {},
        additionalProperties: { type: 'string' },
      }),
    ).not.toThrow();
  });

  it('covers normal and minimal request-bearing fixture variants', () => {
    expect(fixtureHasRequest('cli/json/simulator/build--success.json')).toBe(true);
    expect(fixtureHasRequest('mcp/json/simulator/build--success.json')).toBe(false);
  });

  it.each(validator.fixtures.map((fixture) => [fixture.relativePath, fixture] as const))(
    'validates %s',
    (_relativePath, fixture) => {
      validator.validateFixture(fixture);
    },
  );
});
