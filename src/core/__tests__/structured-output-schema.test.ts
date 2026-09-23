import { describe, expect, it, beforeEach } from 'vitest';
import { z } from 'zod';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { loadManifest } from '../manifest/load-manifest.ts';
import {
  __resetMcpOutputSchemaCacheForTests,
  getMcpOutputSchema,
  getMcpOutputSchemaForRegistration,
  type JsonObject,
} from '../structured-output-schema.ts';

const COMMON_DEFS_REF =
  'https://raw.githubusercontent.com/getsentry/MobileBuildMCP/main/schemas/structured-output/_defs/common.schema.json';

function expectNoExternalCommonRefs(schema: JsonObject): void {
  expect(JSON.stringify(schema)).not.toContain(COMMON_DEFS_REF);
}

function expectStandaloneCompile(schema: JsonObject): void {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    validateSchema: true,
  });
  expect(() => ajv.compile(schema)).not.toThrow();
}

function stripRegistrationResourceEnvelope(schema: JsonObject): JsonObject {
  const stripped = JSON.parse(JSON.stringify(schema)) as JsonObject;
  delete stripped.$schema;
  delete stripped.$id;
  delete stripped.$defs;
  return stripped;
}

describe('structured output schema bundling', () => {
  beforeEach(() => {
    __resetMcpOutputSchemaCacheForTests();
  });

  it('bundles a schema with a single external common ref', () => {
    const schema = getMcpOutputSchema({
      schema: 'mobilebuildmcp.output.simulator-list',
      version: '1',
    });

    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.$id).toBe(
      'https://raw.githubusercontent.com/getsentry/MobileBuildMCP/main/schemas/structured-output/mobilebuildmcp.output.simulator-list/1.schema.json',
    );
    expect((schema.$defs as JsonObject).errorConsistency).toBeDefined();
    expect(JSON.stringify(schema)).toContain('#/$defs/errorConsistency');
    expectNoExternalCommonRefs(schema);
    expectStandaloneCompile(schema);
  });

  it('bundles transitive common refs', () => {
    const schema = getMcpOutputSchema({
      schema: 'mobilebuildmcp.output.build-result',
      version: '1',
    });
    const defs = schema.$defs as JsonObject;

    expect(defs.errorConsistency).toBeDefined();
    expect(defs.buildInvocationRequest).toBeDefined();
    expect(defs.basicDiagnostics).toBeDefined();
    expect(defs.diagnosticEntry).toBeDefined();
    expect(JSON.stringify(schema)).toContain('#/$defs/diagnosticEntry');
    expectNoExternalCommonRefs(schema);
    expectStandaloneCompile(schema);
  });

  it('preserves root-local defs while adding common defs', () => {
    const schema = getMcpOutputSchema({
      schema: 'mobilebuildmcp.output.capture-result',
      version: '1',
    });
    const defs = schema.$defs as JsonObject;

    expect(defs.frame).toBeDefined();
    expect(defs.accessibilityNode).toBeDefined();
    expect(defs.errorConsistency).toBeDefined();
    expect(defs.statusSummary).toBeDefined();
    expect(defs.basicDiagnostics).toBeDefined();
    expectNoExternalCommonRefs(schema);
    expectStandaloneCompile(schema);
  });

  it('bundles the shared structured error schema', () => {
    const schema = getMcpOutputSchema({
      schema: 'mobilebuildmcp.output.error',
      version: '1',
    });

    expect(schema.$id).toBe(
      'https://raw.githubusercontent.com/getsentry/MobileBuildMCP/main/schemas/structured-output/mobilebuildmcp.output.error/1.schema.json',
    );
    expect((schema.$defs as JsonObject).errorConsistency).toBeDefined();
    expectNoExternalCommonRefs(schema);
    expectStandaloneCompile(schema);
  });

  it('returns fresh schema objects from the cache', () => {
    const first = getMcpOutputSchema({
      schema: 'mobilebuildmcp.output.simulator-list',
      version: '1',
    });
    first.mutated = true;

    const second = getMcpOutputSchema({
      schema: 'mobilebuildmcp.output.simulator-list',
      version: '1',
    });
    expect(second.mutated).toBeUndefined();
  });

  it('advertises tool-specific and shared error schemas through the registration wrapper', () => {
    const ref = {
      schema: 'mobilebuildmcp.output.simulator-list',
      version: '1',
    };
    const outputSchema = getMcpOutputSchemaForRegistration(ref);
    const jsonSchema = z.toJSONSchema(outputSchema) as JsonObject;

    expect(jsonSchema).toEqual({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'https://raw.githubusercontent.com/getsentry/MobileBuildMCP/main/schemas/structured-output/mobilebuildmcp.output.simulator-list/1.registration.schema.json',
      type: 'object',
      oneOf: [
        stripRegistrationResourceEnvelope(getMcpOutputSchema(ref)),
        stripRegistrationResourceEnvelope(
          getMcpOutputSchema({ schema: 'mobilebuildmcp.output.error', version: '1' }),
        ),
      ],
      $defs: {
        ...((getMcpOutputSchema(ref).$defs as JsonObject) ?? {}),
        ...((getMcpOutputSchema({ schema: 'mobilebuildmcp.output.error', version: '1' })
          .$defs as JsonObject) ?? {}),
      },
    });
    expect((jsonSchema.oneOf as JsonObject[])[0].$defs).toBeUndefined();
    expect((jsonSchema.oneOf as JsonObject[])[0].$id).toBeUndefined();
    expect((jsonSchema.$defs as JsonObject).errorConsistency).toBeDefined();
    expectNoExternalCommonRefs(jsonSchema);
    expectStandaloneCompile(jsonSchema);
  });

  it('rejects nextSteps against the immutable v1 contract', () => {
    const schema = getMcpOutputSchema({
      schema: 'mobilebuildmcp.output.build-result',
      version: '1',
    });
    const ajv = new Ajv2020({ allErrors: true, strict: true, validateSchema: true });
    const validate = ajv.compile(schema);

    expect(
      validate({
        schema: 'mobilebuildmcp.output.build-result',
        schemaVersion: '1',
        didError: false,
        error: null,
        data: {
          summary: {
            status: 'SUCCEEDED',
            durationMs: 1234,
            target: 'simulator',
          },
          artifacts: {
            buildLogPath: '~/Library/Developer/MobileBuildMCP/logs/build.log',
          },
          diagnostics: {
            warnings: [],
            errors: [],
          },
        },
        nextSteps: ['Get app path: get_sim_app_path({ scheme: "CalculatorApp" })'],
      }),
    ).toBe(false);
  });

  it('accepts non-error structured envelopes with nextSteps in the bumped contract', () => {
    const schema = getMcpOutputSchema({
      schema: 'mobilebuildmcp.output.build-result',
      version: '2',
    });
    const ajv = new Ajv2020({ allErrors: true, strict: true, validateSchema: true });
    const validate = ajv.compile(schema);

    expect(
      validate({
        schema: 'mobilebuildmcp.output.build-result',
        schemaVersion: '2',
        didError: false,
        error: null,
        data: {
          summary: {
            status: 'SUCCEEDED',
            durationMs: 1234,
            target: 'simulator',
          },
          artifacts: {
            buildLogPath: '~/Library/Developer/MobileBuildMCP/logs/build.log',
          },
          diagnostics: {
            warnings: [],
            errors: [],
          },
        },
        nextSteps: ['Get app path: get_sim_app_path({ scheme: "CalculatorApp" })'],
      }),
    ).toBe(true);
  });

  it('accepts prepared test artifacts only in build and test result v3', () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true, validateSchema: true });
    const buildV2 = ajv.compile(
      getMcpOutputSchema({ schema: 'mobilebuildmcp.output.build-result', version: '2' }),
    );
    const buildV3 = ajv.compile(
      getMcpOutputSchema({ schema: 'mobilebuildmcp.output.build-result', version: '3' }),
    );
    const testV3 = ajv.compile(
      getMcpOutputSchema({ schema: 'mobilebuildmcp.output.test-result', version: '3' }),
    );
    const buildEnvelope = {
      schema: 'mobilebuildmcp.output.build-result',
      schemaVersion: '3',
      didError: false,
      error: null,
      data: {
        request: { buildForTesting: true, scheme: 'CalculatorApp' },
        summary: { status: 'SUCCEEDED', target: 'simulator' },
        artifacts: {
          testProductsPath: 'artifacts/CalculatorApp.xctestproducts',
          xctestrunPaths: ['artifacts/CalculatorApp.xctestproducts/CalculatorApp.xctestrun'],
        },
        diagnostics: { warnings: [], errors: [] },
      },
    };

    expect(buildV2({ ...buildEnvelope, schemaVersion: '2' })).toBe(false);
    expect(buildV3(buildEnvelope)).toBe(true);
    expect(
      testV3({
        schema: 'mobilebuildmcp.output.test-result',
        schemaVersion: '3',
        didError: false,
        error: null,
        data: {
          request: { testProductsPath: 'artifacts/CalculatorApp.xctestproducts' },
          summary: { status: 'SUCCEEDED', target: 'simulator' },
          artifacts: {
            testProductsPath: 'artifacts/CalculatorApp.xctestproducts',
            xcresultPath: 'artifacts/test.xcresult',
          },
          diagnostics: { warnings: [], errors: [], testFailures: [] },
        },
      }),
    ).toBe(true);
  });

  it('accepts video recording capture payloads in the bumped capture contract', () => {
    const schema = getMcpOutputSchema({
      schema: 'mobilebuildmcp.output.capture-result',
      version: '2',
    });
    const ajv = new Ajv2020({ allErrors: true, strict: true, validateSchema: true });
    const validate = ajv.compile(schema);

    expect(
      validate({
        schema: 'mobilebuildmcp.output.capture-result',
        schemaVersion: '2',
        didError: false,
        error: null,
        data: {
          summary: { status: 'SUCCEEDED' },
          artifacts: { simulatorId: 'A-SIMULATOR-ID' },
          capture: {
            type: 'video-recording',
            state: 'started',
            fps: 30,
            sessionId: 'recording-session',
          },
        },
      }),
    ).toBe(true);
  });

  it('accepts normal and minimal request-bearing envelopes in the bumped contracts', () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true, validateSchema: true });
    const cases = [
      {
        schema: getMcpOutputSchema({ schema: 'mobilebuildmcp.output.build-result', version: '2' }),
        normal: {
          schema: 'mobilebuildmcp.output.build-result',
          schemaVersion: '2',
          didError: false,
          error: null,
          data: {
            request: { scheme: 'CalculatorApp', workspacePath: 'CalculatorApp.xcworkspace' },
            summary: { status: 'SUCCEEDED', durationMs: 1234, target: 'simulator' },
            artifacts: { buildLogPath: '~/Library/Developer/MobileBuildMCP/logs/build.log' },
            diagnostics: { warnings: [], errors: [] },
          },
          nextSteps: ['Get app path: mobilebuildmcp simulator get-app-path --scheme CalculatorApp'],
        },
        minimal: {
          schema: 'mobilebuildmcp.output.build-result',
          schemaVersion: '2',
          didError: false,
          error: null,
          data: {
            summary: { status: 'SUCCEEDED', durationMs: 1234, target: 'simulator' },
            artifacts: { buildLogPath: '~/Library/Developer/MobileBuildMCP/logs/build.log' },
            diagnostics: { warnings: [], errors: [] },
          },
          nextSteps: ['Get app path: mobilebuildmcp simulator get-app-path --scheme CalculatorApp'],
        },
      },
      {
        schema: getMcpOutputSchema({
          schema: 'mobilebuildmcp.output.build-run-result',
          version: '2',
        }),
        normal: {
          schema: 'mobilebuildmcp.output.build-run-result',
          schemaVersion: '2',
          didError: false,
          error: null,
          data: {
            request: { scheme: 'CalculatorApp', workspacePath: 'CalculatorApp.xcworkspace' },
            summary: { status: 'SUCCEEDED', durationMs: 1234, target: 'simulator' },
            artifacts: { appPath: '/tmp/CalculatorApp.app', processId: 1234 },
            diagnostics: { warnings: [], errors: [] },
          },
        },
        minimal: {
          schema: 'mobilebuildmcp.output.build-run-result',
          schemaVersion: '2',
          didError: false,
          error: null,
          data: {
            summary: { status: 'SUCCEEDED', durationMs: 1234, target: 'simulator' },
            artifacts: { appPath: '/tmp/CalculatorApp.app', processId: 1234 },
            diagnostics: { warnings: [], errors: [] },
          },
        },
      },
      {
        schema: getMcpOutputSchema({ schema: 'mobilebuildmcp.output.test-result', version: '2' }),
        normal: {
          schema: 'mobilebuildmcp.output.test-result',
          schemaVersion: '2',
          didError: false,
          error: null,
          data: {
            request: { scheme: 'CalculatorApp', workspacePath: 'CalculatorApp.xcworkspace' },
            summary: {
              status: 'SUCCEEDED',
              durationMs: 1234,
              target: 'simulator',
              counts: { passed: 1, failed: 0, skipped: 0 },
            },
            artifacts: { xcresultPath: '/tmp/result.xcresult' },
            diagnostics: { warnings: [], errors: [], testFailures: [] },
          },
        },
        minimal: {
          schema: 'mobilebuildmcp.output.test-result',
          schemaVersion: '2',
          didError: false,
          error: null,
          data: {
            summary: {
              status: 'SUCCEEDED',
              durationMs: 1234,
              target: 'simulator',
              counts: { passed: 1, failed: 0, skipped: 0 },
            },
            artifacts: { xcresultPath: '/tmp/result.xcresult' },
            diagnostics: { warnings: [], errors: [], testFailures: [] },
          },
        },
      },
      {
        schema: getMcpOutputSchema({ schema: 'mobilebuildmcp.output.app-path', version: '2' }),
        normal: {
          schema: 'mobilebuildmcp.output.app-path',
          schemaVersion: '2',
          didError: false,
          error: null,
          data: {
            request: { scheme: 'CalculatorApp', platform: 'iOS Simulator' },
            artifacts: { appPath: '/tmp/CalculatorApp.app' },
            diagnostics: { warnings: [], errors: [] },
          },
        },
        minimal: {
          schema: 'mobilebuildmcp.output.app-path',
          schemaVersion: '2',
          didError: false,
          error: null,
          data: {
            artifacts: { appPath: '/tmp/CalculatorApp.app' },
            diagnostics: { warnings: [], errors: [] },
          },
        },
      },
    ];

    const failures: string[] = [];
    for (const testCase of cases) {
      const validate = ajv.compile(testCase.schema);
      for (const [style, envelope] of [
        ['normal', testCase.normal],
        ['minimal', testCase.minimal],
      ] as const) {
        if (!validate(envelope)) {
          const envelopeSchema = (envelope as { schema: string }).schema;
          failures.push(`${envelopeSchema} ${style}: ${JSON.stringify(validate.errors)}`);
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it('accepts structured error envelopes in registered output schemas', () => {
    const outputSchema = getMcpOutputSchemaForRegistration({
      schema: 'mobilebuildmcp.output.simulator-list',
      version: '1',
    });
    const jsonSchema = z.toJSONSchema(outputSchema) as JsonObject;
    const ajv = new Ajv2020({ allErrors: true, strict: true, validateSchema: true });
    const validate = ajv.compile(jsonSchema);

    expect(
      validate({
        schema: 'mobilebuildmcp.output.error',
        schemaVersion: '1',
        didError: true,
        error: 'Parameter validation failed',
        data: {
          category: 'validation',
          code: 'PARAMETER_VALIDATION_FAILED',
        },
      }),
    ).toBe(true);
  });

  it('accepts ui automation v2 runtime snapshots and semantic action errors', () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true, validateSchema: true });
    const captureValidate = ajv.compile(
      getMcpOutputSchema({ schema: 'mobilebuildmcp.output.capture-result', version: '2' }),
    );
    const actionValidate = ajv.compile(
      getMcpOutputSchema({ schema: 'mobilebuildmcp.output.ui-action-result', version: '2' }),
    );
    const actionV3Validate = ajv.compile(
      getMcpOutputSchema({ schema: 'mobilebuildmcp.output.ui-action-result', version: '3' }),
    );

    expect(
      captureValidate({
        schema: 'mobilebuildmcp.output.capture-result',
        schemaVersion: '2',
        didError: false,
        error: null,
        data: {
          summary: { status: 'SUCCEEDED' },
          artifacts: { simulatorId: 'SIM-1' },
          capture: {
            type: 'runtime-snapshot',
            protocol: 'rs/1',
            simulatorId: 'SIM-1',
            screenHash: 'screen-hash',
            seq: 1,
            capturedAtMs: 1_000,
            expiresAtMs: 61_000,
            elements: [
              {
                ref: 'e1',
                role: 'button',
                label: 'Continue',
                frame: { x: 10, y: 20, width: 100, height: 40 },
                state: { enabled: true, selected: true, visible: true },
                actions: ['tap'],
              },
            ],
            actions: [{ action: 'tap', elementRef: 'e1', label: 'Continue' }],
          },
        },
      }),
    ).toBe(true);

    expect(
      captureValidate({
        schema: 'mobilebuildmcp.output.capture-result',
        schemaVersion: '2',
        didError: false,
        error: null,
        data: {
          summary: { status: 'SUCCEEDED' },
          artifacts: { simulatorId: 'SIM-1' },
          capture: {
            type: 'runtime-snapshot-unchanged',
            protocol: 'rs/1',
            simulatorId: 'SIM-1',
            screenHash: 'screen-hash',
            seq: 2,
          },
        },
      }),
    ).toBe(true);

    expect(
      captureValidate({
        schema: 'mobilebuildmcp.output.capture-result',
        schemaVersion: '2',
        didError: false,
        error: null,
        data: {
          summary: { status: 'SUCCEEDED' },
          artifacts: { simulatorId: 'SIM-1' },
          capture: {
            type: 'runtime-snapshot-unchanged',
            rs: '1',
            screenHash: 'screen-hash',
            seq: 2,
            unchanged: true,
            udid: 'SIM-1',
          },
        },
      }),
    ).toBe(true);

    const fullUiActionEnvelope = {
      schema: 'mobilebuildmcp.output.ui-action-result',
      schemaVersion: '3',
      didError: false,
      error: null,
      data: {
        summary: { status: 'SUCCEEDED' },
        action: { type: 'tap', elementRef: 'e1' },
        artifacts: { simulatorId: 'SIM-1' },
        capture: {
          type: 'runtime-snapshot',
          protocol: 'rs/1',
          simulatorId: 'SIM-1',
          screenHash: 'screen-hash',
          seq: 1,
          capturedAtMs: 1_000,
          expiresAtMs: 61_000,
          elements: [
            {
              ref: 'e1',
              role: 'button',
              label: 'Continue',
              frame: { x: 10, y: 20, width: 100, height: 40 },
              state: { enabled: true, selected: true, visible: true },
              actions: ['tap'],
            },
          ],
          actions: [{ action: 'tap', elementRef: 'e1', label: 'Continue' }],
        },
      },
    };

    expect(actionValidate({ ...fullUiActionEnvelope, schemaVersion: '2' })).toBe(false);
    expect(actionV3Validate(fullUiActionEnvelope)).toBe(true);

    expect(
      actionValidate({
        schema: 'mobilebuildmcp.output.ui-action-result',
        schemaVersion: '2',
        didError: false,
        error: null,
        data: {
          summary: { status: 'SUCCEEDED' },
          action: { type: 'tap', elementRef: 'e1' },
          artifacts: { simulatorId: 'SIM-1' },
          capture: {
            type: 'runtime-snapshot',
            rs: '1',
            screenHash: 'screen-hash',
            seq: 1,
            count: 1,
            targets: ['e1|tap|button|Continue||'],
            scroll: [],
            udid: 'SIM-1',
          },
        },
      }),
    ).toBe(true);

    expect(
      actionValidate({
        schema: 'mobilebuildmcp.output.ui-action-result',
        schemaVersion: '2',
        didError: true,
        error: 'Element ref was not found in the current snapshot.',
        data: {
          summary: { status: 'FAILED' },
          action: { type: 'tap', elementRef: 'e404' },
          artifacts: { simulatorId: 'SIM-1' },
          uiError: {
            code: 'ELEMENT_REF_NOT_FOUND',
            message: 'Element ref was not found in the current snapshot.',
            recoveryHint: 'Run snapshot_ui again and retry with a current elementRef.',
            elementRef: 'e404',
            snapshotAgeMs: 1_000,
          },
        },
      }),
    ).toBe(true);

    expect(
      actionValidate({
        schema: 'mobilebuildmcp.output.ui-action-result',
        schemaVersion: '2',
        didError: false,
        error: null,
        data: {
          summary: { status: 'SUCCEEDED' },
          action: { type: 'batch', stepCount: 2 },
          artifacts: { simulatorId: 'SIM-1' },
        },
      }),
    ).toBe(true);
  });

  it('accepts xcode bridge call-result artifacts', () => {
    const schema = getMcpOutputSchema({
      schema: 'mobilebuildmcp.output.xcode-bridge-call-result',
      version: '3',
    });
    const ajv = new Ajv2020({ allErrors: true, strict: true, validateSchema: true });
    const validate = ajv.compile(schema);

    expect(
      validate({
        schema: 'mobilebuildmcp.output.xcode-bridge-call-result',
        schemaVersion: '3',
        didError: false,
        error: null,
        data: {
          remoteTool: 'DocumentationSearch',
          succeeded: true,
          content: [],
          artifacts: {
            rawResponseJsonPath: '/tmp/xcode-ide-response.json',
          },
        },
      }),
    ).toBe(true);
  });

  it('every manifest-declared output schema uses a bumped contract that accepts optional top-level nextSteps', () => {
    const manifest = loadManifest();
    const failures: string[] = [];

    for (const tool of manifest.tools.values()) {
      if (!tool.outputSchema) {
        continue;
      }

      try {
        const schema = getMcpOutputSchema(tool.outputSchema);
        const properties = schema.properties as JsonObject | undefined;
        const required = schema.required as unknown[] | undefined;
        const nextSteps = properties?.nextSteps as JsonObject | undefined;

        if (!nextSteps) {
          failures.push(`${tool.id}: missing optional top-level nextSteps`);
        }
        if (required?.includes('nextSteps')) {
          failures.push(`${tool.id}: nextSteps must stay optional`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${tool.id}: ${message}`);
      }
    }

    expect(failures).toEqual([]);
  });

  it('resolves every manifest-declared output schema', () => {
    const manifest = loadManifest();
    const failures: string[] = [];

    for (const tool of manifest.tools.values()) {
      if (!tool.outputSchema) {
        failures.push(`${tool.id}: missing outputSchema`);
        continue;
      }

      try {
        const schema = getMcpOutputSchema(tool.outputSchema);
        expectNoExternalCommonRefs(schema);
        expectStandaloneCompile(schema);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${tool.id}: ${message}`);
      }
    }

    expect(failures).toEqual([]);
  });
});
