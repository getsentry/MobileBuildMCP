import fs from 'node:fs';
import path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';
import { globSync } from 'glob';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

const FIXTURE_ROOT = path.resolve(process.cwd(), 'src/snapshot-tests/__fixtures__');
const JSON_FIXTURE_BUCKETS = ['cli/json', 'mcp/json'] as const;
const SCHEMA_ROOT = path.resolve(process.cwd(), 'schemas/structured-output');
const SCHEMA_PATTERN = /^mobilebuildmcp\.output\.[a-z0-9-]+$/;
const SCHEMA_VERSION_PATTERN = /^[0-9]+$/;

export interface JsonFixtureEnvelopeBootstrap {
  schema: string;
  schemaVersion: string;
  didError: boolean;
  error: string | null;
  data: unknown;
}

export interface DiscoveredJsonFixture {
  absolutePath: string;
  relativePath: string;
  envelope: JsonFixtureEnvelopeBootstrap;
  schemaPath: string;
}

interface DiscoveredSchemaDocument {
  absolutePath: string;
  relativePath: string;
  schemaId: string;
}

export interface StructuredFixtureSchemaValidator {
  fixtures: readonly DiscoveredJsonFixture[];
  compileAllSchemas(): void;
  validateFixture(fixture: DiscoveredJsonFixture): void;
  validateRegisteredOutputSchemas(tools: readonly Tool[]): void;
}

function toRelative(absolutePath: string): string {
  return path.relative(process.cwd(), absolutePath).split(path.sep).join('/');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJsonDocument(absolutePath: string, label: string): unknown {
  let raw: string;
  try {
    raw = fs.readFileSync(absolutePath, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read ${label}: ${message}`);
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse ${label}: ${message}`);
  }
}

function assertBootstrapEnvelope(
  value: unknown,
  relativePath: string,
): JsonFixtureEnvelopeBootstrap {
  if (!isRecord(value)) {
    throw new Error(`${relativePath}: fixture root must be a JSON object.`);
  }

  const { schema, schemaVersion, didError, error, data } = value;

  if (typeof schema !== 'string') {
    throw new Error(`${relativePath}: fixture must declare a string schema.`);
  }
  if (typeof schemaVersion !== 'string') {
    throw new Error(`${relativePath}: fixture must declare a string schemaVersion.`);
  }
  if (typeof didError !== 'boolean') {
    throw new Error(`${relativePath}: fixture must declare a boolean didError.`);
  }
  if (!(typeof error === 'string' || error === null)) {
    throw new Error(`${relativePath}: fixture error must be a string or null.`);
  }
  if (!Object.prototype.hasOwnProperty.call(value, 'data')) {
    throw new Error(`${relativePath}: fixture must declare a data field.`);
  }

  return { schema, schemaVersion, didError, error, data };
}

function assertValidSchemaRoute(fixture: JsonFixtureEnvelopeBootstrap, relativePath: string): void {
  if (!SCHEMA_PATTERN.test(fixture.schema)) {
    throw new Error(
      `${relativePath}: schema "${fixture.schema}" does not match ${SCHEMA_PATTERN.source}.`,
    );
  }
  if (!SCHEMA_VERSION_PATTERN.test(fixture.schemaVersion)) {
    throw new Error(
      `${relativePath}: schemaVersion "${fixture.schemaVersion}" does not match ${SCHEMA_VERSION_PATTERN.source}.`,
    );
  }
}

function discoverSchemaDocuments(): DiscoveredSchemaDocument[] {
  const relativePaths = globSync('**/*.schema.json', {
    cwd: SCHEMA_ROOT,
    nodir: true,
  }).sort();

  return relativePaths.map((relativePath) => {
    const absolutePath = path.join(SCHEMA_ROOT, relativePath);
    const document = readJsonDocument(absolutePath, `schema ${toRelative(absolutePath)}`);
    if (!isRecord(document) || typeof document.$id !== 'string' || document.$id.length === 0) {
      throw new Error(`${toRelative(absolutePath)}: schema must declare a non-empty $id.`);
    }

    return {
      absolutePath,
      relativePath: relativePath.split(path.sep).join('/'),
      schemaId: document.$id,
    };
  });
}

function discoverJsonFixturePaths(): Array<{ absolutePath: string; relativePath: string }> {
  return JSON_FIXTURE_BUCKETS.flatMap((bucket) => {
    const bucketRoot = path.join(FIXTURE_ROOT, bucket);
    if (!fs.existsSync(bucketRoot)) {
      return [];
    }

    return globSync('**/*.json', {
      cwd: bucketRoot,
      nodir: true,
    })
      .sort()
      .map((bucketRelativePath) => ({
        absolutePath: path.join(bucketRoot, bucketRelativePath),
        relativePath: path.join(bucket, bucketRelativePath).split(path.sep).join('/'),
      }));
  }).sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function discoverJsonFixtures(knownSchemaPaths: Set<string>): DiscoveredJsonFixture[] {
  return discoverJsonFixturePaths().map(({ absolutePath, relativePath }) => {
    const parsed = readJsonDocument(absolutePath, `fixture ${relativePath}`);
    const envelope = assertBootstrapEnvelope(parsed, relativePath);
    assertValidSchemaRoute(envelope, relativePath);

    const schemaPath = path.join(
      SCHEMA_ROOT,
      envelope.schema,
      `${envelope.schemaVersion}.schema.json`,
    );

    if (!knownSchemaPaths.has(schemaPath)) {
      throw new Error(
        `${relativePath}: declared schema ${envelope.schema}@${envelope.schemaVersion} maps to missing schema file ${toRelative(schemaPath)}.`,
      );
    }

    return {
      absolutePath,
      relativePath,
      envelope,
      schemaPath,
    };
  });
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) {
    return '- (no AJV errors reported)';
  }

  return errors
    .map((error) => {
      const instancePath = error.instancePath.length > 0 ? error.instancePath : '/';
      const params = Object.keys(error.params).length > 0 ? ` ${JSON.stringify(error.params)}` : '';
      return `- ${instancePath}: ${error.message ?? 'validation error'}${params}`;
    })
    .join('\n');
}

function resolveLocalReference(root: unknown, reference: string, label: string): unknown {
  if (!reference.startsWith('#/')) {
    throw new Error(`${label}: output schema contains non-local $ref ${reference}.`);
  }

  let current: unknown = root;
  for (const rawSegment of reference.slice(2).split('/')) {
    const segment = rawSegment.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        throw new Error(`${label}: unresolved local $ref ${reference}.`);
      }
      current = current[index];
      continue;
    }
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) {
      throw new Error(`${label}: unresolved local $ref ${reference}.`);
    }
    current = current[segment];
  }
  return current;
}

function assertLocalReferencesResolve(value: unknown, root: unknown, label: string): void {
  if (Array.isArray(value)) {
    value.forEach((child) => assertLocalReferencesResolve(child, root, label));
    return;
  }
  if (!isRecord(value)) return;

  if (typeof value.$ref === 'string') {
    resolveLocalReference(root, value.$ref, label);
  }
  Object.values(value).forEach((child) => assertLocalReferencesResolve(child, root, label));
}

function collectEnvelopeRoutes(value: unknown, routes: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach((child) => collectEnvelopeRoutes(child, routes));
    return;
  }
  if (!isRecord(value)) return;

  const properties = value.properties;
  if (isRecord(properties)) {
    const schema = properties.schema;
    const schemaVersion = properties.schemaVersion;
    if (
      isRecord(schema) &&
      typeof schema.const === 'string' &&
      isRecord(schemaVersion) &&
      typeof schemaVersion.const === 'string'
    ) {
      routes.add(`${schema.const}@${schemaVersion.const}`);
    }
  }
  Object.values(value).forEach((child) => collectEnvelopeRoutes(child, routes));
}

function validateRegisteredOutputSchema(
  tool: Tool,
  fixtures: readonly DiscoveredJsonFixture[],
): number {
  if (!tool.outputSchema) {
    throw new Error(`${tool.name}: live MCP registration omitted its output schema.`);
  }
  const label = `${tool.name} output schema`;
  assertLocalReferencesResolve(tool.outputSchema, tool.outputSchema, label);

  const ajv = new Ajv2020({ allErrors: true, strict: true, validateSchema: true });
  const validate = ajv.compile(tool.outputSchema);
  const routes = new Set<string>();
  collectEnvelopeRoutes(tool.outputSchema, routes);
  if (!routes.has('mobilebuildmcp.output.error@1')) {
    throw new Error(`${label}: standard error envelope branch is missing.`);
  }

  const domainRoutes = [...routes].filter((route) => route !== 'mobilebuildmcp.output.error@1');
  if (domainRoutes.length === 0) {
    throw new Error(`${label}: successful structured-output branch is missing.`);
  }

  let validatedFixtureCount = 0;
  for (const route of domainRoutes) {
    const matchingFixtures = fixtures.filter(
      (fixture) =>
        fixture.relativePath.startsWith('mcp/json/') &&
        fixture.envelope.didError === false &&
        `${fixture.envelope.schema}@${fixture.envelope.schemaVersion}` === route,
    );
    if (matchingFixtures.length === 0) {
      throw new Error(`${label}: no successful MCP JSON fixture matches ${route}.`);
    }
    for (const fixture of matchingFixtures) {
      const parsed = readJsonDocument(fixture.absolutePath, `fixture ${fixture.relativePath}`);
      if (!validate(parsed)) {
        throw new Error(
          `${label}: fixture ${fixture.relativePath} failed live output-schema validation.\n${formatAjvErrors(validate.errors)}`,
        );
      }
      validatedFixtureCount += 1;
    }
  }

  const standardError = {
    schema: 'mobilebuildmcp.output.error',
    schemaVersion: '1',
    didError: true,
    error: 'Contract validation error',
    data: { category: 'validation', code: 'CONTRACT_VALIDATION' },
  };
  if (!validate(standardError)) {
    throw new Error(
      `${label}: standard error envelope failed live output-schema validation.\n${formatAjvErrors(validate.errors)}`,
    );
  }
  return validatedFixtureCount;
}

export function createStructuredFixtureSchemaValidator(): StructuredFixtureSchemaValidator {
  const schemaDocuments = discoverSchemaDocuments();
  const schemaIdsByPath = new Map(
    schemaDocuments.map((schema) => [schema.absolutePath, schema.schemaId]),
  );
  const knownSchemaPaths = new Set(schemaDocuments.map((schema) => schema.absolutePath));
  const fixtures = discoverJsonFixtures(knownSchemaPaths);

  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    validateSchema: true,
  });

  const validatorCache = new Map<string, ValidateFunction>();

  for (const schema of schemaDocuments) {
    const document = readJsonDocument(
      schema.absolutePath,
      `schema ${toRelative(schema.absolutePath)}`,
    );
    if (!isRecord(document)) {
      throw new Error(`${toRelative(schema.absolutePath)}: schema root must be a JSON object.`);
    }
    ajv.addSchema(document);
  }

  function validatorForSchemaPath(schemaPath: string): ValidateFunction {
    const cached = validatorCache.get(schemaPath);
    if (cached) {
      return cached;
    }

    const schemaId = schemaIdsByPath.get(schemaPath);
    if (!schemaId) {
      throw new Error(`No registered schema found for ${toRelative(schemaPath)}.`);
    }

    const validator = ajv.getSchema(schemaId);
    if (!validator) {
      throw new Error(`AJV failed to compile schema ${schemaId} from ${toRelative(schemaPath)}.`);
    }

    validatorCache.set(schemaPath, validator);
    return validator;
  }

  return {
    fixtures,
    compileAllSchemas(): void {
      for (const schema of schemaDocuments) {
        validatorForSchemaPath(schema.absolutePath);
      }
    },
    validateFixture(fixture: DiscoveredJsonFixture): void {
      const validate = validatorForSchemaPath(fixture.schemaPath);
      const parsed = readJsonDocument(fixture.absolutePath, `fixture ${fixture.relativePath}`);

      if (validate(parsed)) {
        return;
      }

      const schemaId = schemaIdsByPath.get(fixture.schemaPath) ?? '(unknown schema id)';
      throw new Error(
        [
          `Fixture validation failed: ${fixture.relativePath}`,
          `Declared schema: ${fixture.envelope.schema}@${fixture.envelope.schemaVersion}`,
          `Resolved schema: ${toRelative(fixture.schemaPath)}`,
          `Schema $id: ${schemaId}`,
          'AJV errors:',
          formatAjvErrors(validate.errors),
        ].join('\n'),
      );
    },
    validateRegisteredOutputSchemas(tools: readonly Tool[]): void {
      let validatedFixtureCount = 0;
      for (const tool of tools) {
        validatedFixtureCount += validateRegisteredOutputSchema(tool, fixtures);
      }
      if (validatedFixtureCount === 0) {
        throw new Error('No successful MCP JSON fixture matched a live registered output schema.');
      }
    },
  };
}
