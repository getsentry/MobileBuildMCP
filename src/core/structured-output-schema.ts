import fs from 'node:fs';
import path from 'node:path';
import { z, type ZodType } from 'zod';
import { getStructuredOutputSchemasDir } from './resource-root.ts';

const SCHEMA_PATTERN = /^mobilebuildmcp\.output\.[a-z0-9-]+$/;
const SCHEMA_VERSION_PATTERN = /^[0-9]+$/;
const COMMON_DEFS_ID =
  'https://raw.githubusercontent.com/getsentry/MobileBuildMCP/main/schemas/structured-output/_defs/common.schema.json';
const COMMON_DEFS_REF_PREFIX = `${COMMON_DEFS_ID}#/$defs/`;

export interface StructuredOutputSchemaRef {
  schema: string;
  version: string;
}

export type JsonObject = Record<string, unknown>;
export type McpOutputSchema = ZodType;

const STRUCTURED_ERROR_SCHEMA_REF: StructuredOutputSchemaRef = {
  schema: 'mobilebuildmcp.output.error',
  version: '1',
};

const bundledSchemaCache = new Map<string, JsonObject>();

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function assertSchemaRef(ref: StructuredOutputSchemaRef): void {
  if (!SCHEMA_PATTERN.test(ref.schema)) {
    throw new Error(`Invalid structured output schema name: ${ref.schema}`);
  }
  if (!SCHEMA_VERSION_PATTERN.test(ref.version)) {
    throw new Error(`Invalid structured output schema version: ${ref.version}`);
  }
}

function readJsonObject(filePath: string, label: string): JsonObject {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read ${label} at ${filePath}: ${message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse ${label} at ${filePath}: ${message}`);
  }

  if (!isRecord(parsed)) {
    throw new Error(`${label} at ${filePath} must be a JSON object.`);
  }
  return parsed;
}

function schemaPathFor(ref: StructuredOutputSchemaRef): string {
  const schemasDir = getStructuredOutputSchemasDir();
  const schemaPath = path.join(schemasDir, ref.schema, `${ref.version}.schema.json`);
  const resolvedPath = path.resolve(schemaPath);
  const resolvedSchemasDir = path.resolve(schemasDir);

  // Prevent path traversal attacks by ensuring the resolved path is within the schemas directory
  if (
    !resolvedPath.startsWith(resolvedSchemasDir + path.sep) &&
    resolvedPath !== resolvedSchemasDir
  ) {
    throw new Error(
      `Invalid schema path: attempted path traversal detected for ${ref.schema}@${ref.version}`,
    );
  }

  return schemaPath;
}

function collectAndRewriteCommonRefs(value: unknown, pendingDefs: Set<string>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => collectAndRewriteCommonRefs(item, pendingDefs));
  }

  if (!isRecord(value)) {
    return value;
  }

  const rewritten: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === '$ref' && typeof child === 'string') {
      if (child.startsWith(COMMON_DEFS_REF_PREFIX)) {
        const defName = child.slice(COMMON_DEFS_REF_PREFIX.length);
        if (!defName) {
          throw new Error(`Invalid common $ref: ${child}`);
        }
        pendingDefs.add(defName);
        rewritten[key] = `#/$defs/${defName}`;
        continue;
      }
      if (/^https?:\/\//.test(child)) {
        throw new Error(`Unsupported external $ref in structured output schema: ${child}`);
      }
    }

    rewritten[key] = collectAndRewriteCommonRefs(child, pendingDefs);
  }
  return rewritten;
}

function getCommonDefinitions(commonSchema: JsonObject): JsonObject {
  const defs = commonSchema.$defs;
  if (!isRecord(defs)) {
    throw new Error(`${COMMON_DEFS_ID} must declare a $defs object.`);
  }
  return defs;
}

function mergeDefinition(targetDefs: JsonObject, name: string, definition: unknown): void {
  const existing = targetDefs[name];
  if (existing === undefined) {
    targetDefs[name] = definition;
    return;
  }

  if (stableStringify(existing) !== stableStringify(definition)) {
    throw new Error(
      `Conflicting local $defs entry while bundling structured output schema: ${name}`,
    );
  }
}

function bundleSchema(rootSchema: JsonObject, commonSchema: JsonObject): JsonObject {
  if (typeof rootSchema.$id !== 'string' || rootSchema.$id.length === 0) {
    throw new Error('Structured output schema must declare a non-empty $id.');
  }

  const pendingDefs = new Set<string>();
  const bundled = collectAndRewriteCommonRefs(cloneJson(rootSchema), pendingDefs);
  if (!isRecord(bundled)) {
    throw new Error('Structured output schema bundling produced a non-object root.');
  }

  const commonDefs = getCommonDefinitions(commonSchema);
  const rootDefs = bundled.$defs;
  const localDefsCandidate = rootDefs === undefined ? {} : cloneJson(rootDefs);
  if (!isRecord(localDefsCandidate)) {
    throw new Error('Structured output schema root $defs must be an object when present.');
  }
  const localDefs = localDefsCandidate;

  const processedDefs = new Set<string>();
  while (pendingDefs.size > 0) {
    const defName = pendingDefs.values().next().value;
    if (defName === undefined) {
      break;
    }
    pendingDefs.delete(defName);
    if (processedDefs.has(defName)) {
      continue;
    }

    const commonDef = commonDefs[defName];
    if (commonDef === undefined) {
      throw new Error(`Missing common structured output definition: ${defName}`);
    }

    const rewrittenDef = collectAndRewriteCommonRefs(cloneJson(commonDef), pendingDefs);
    mergeDefinition(localDefs, defName, rewrittenDef);
    processedDefs.add(defName);
  }

  if (Object.keys(localDefs).length > 0) {
    bundled.$defs = localDefs;
  }

  const serialized = JSON.stringify(bundled);
  if (serialized.includes(COMMON_DEFS_REF_PREFIX)) {
    throw new Error(
      'Structured output schema still contains external common $refs after bundling.',
    );
  }

  return bundled;
}

function inlineRegistrationSchemaResource(schema: JsonObject): {
  schema: JsonObject;
  defs: JsonObject;
} {
  const inlinedSchema = cloneJson(schema);
  const defsCandidate = inlinedSchema.$defs === undefined ? {} : cloneJson(inlinedSchema.$defs);
  if (!isRecord(defsCandidate)) {
    throw new Error('Structured output registration $defs must be an object when present.');
  }

  delete inlinedSchema.$schema;
  delete inlinedSchema.$id;
  delete inlinedSchema.$defs;

  return {
    schema: inlinedSchema,
    defs: defsCandidate,
  };
}

export function getMcpOutputSchema(ref: StructuredOutputSchemaRef): JsonObject {
  assertSchemaRef(ref);
  const cacheKey = `${ref.schema}@${ref.version}`;
  const cached = bundledSchemaCache.get(cacheKey);
  if (cached) {
    return cloneJson(cached);
  }

  const rootSchema = readJsonObject(schemaPathFor(ref), `${ref.schema}@${ref.version}`);

  const schemasDir = getStructuredOutputSchemasDir();
  const commonSchemaPath = path.join(schemasDir, '_defs', 'common.schema.json');
  const commonSchema = readJsonObject(commonSchemaPath, 'common structured output definitions');
  const bundled = bundleSchema(rootSchema, commonSchema);
  bundledSchemaCache.set(cacheKey, bundled);
  return cloneJson(bundled);
}

function getMcpOutputSchemaForRegistrationJson(ref: StructuredOutputSchemaRef): JsonObject {
  const toolSchema = getMcpOutputSchema(ref);
  if (ref.schema === STRUCTURED_ERROR_SCHEMA_REF.schema) {
    return toolSchema;
  }
  const errorSchema = getMcpOutputSchema(STRUCTURED_ERROR_SCHEMA_REF);
  const toolResource = inlineRegistrationSchemaResource(toolSchema);
  const errorResource = inlineRegistrationSchemaResource(errorSchema);
  const defs: JsonObject = {};

  for (const [name, definition] of Object.entries(toolResource.defs)) {
    mergeDefinition(defs, name, definition);
  }
  for (const [name, definition] of Object.entries(errorResource.defs)) {
    mergeDefinition(defs, name, definition);
  }

  const registrationSchema: JsonObject = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `https://raw.githubusercontent.com/getsentry/MobileBuildMCP/main/schemas/structured-output/${ref.schema}/${ref.version}.registration.schema.json`,
    type: 'object',
    oneOf: [toolResource.schema, errorResource.schema],
  };

  if (Object.keys(defs).length > 0) {
    registrationSchema.$defs = defs;
  }

  return registrationSchema;
}

export function getMcpOutputSchemaForRegistration(ref: StructuredOutputSchemaRef): McpOutputSchema {
  const zodSchema = z.object({}).passthrough();
  const schemaWithJsonHook = zodSchema as ZodType & {
    _zod?: { toJSONSchema?: () => JsonObject };
  };
  if (!schemaWithJsonHook._zod) {
    throw new Error('Zod schema internals are unavailable for MCP output schema registration.');
  }

  schemaWithJsonHook._zod.toJSONSchema = () => getMcpOutputSchemaForRegistrationJson(ref);
  return zodSchema;
}

export function __resetMcpOutputSchemaCacheForTests(): void {
  bundledSchemaCache.clear();
}
