/**
 * Zod schemas for manifest YAML validation.
 * These schemas define the canonical data model for tools and workflows.
 */

import { z } from 'zod';

/**
 * Availability flags for different runtimes.
 */
export const availabilitySchema = z
  .object({
    mcp: z.boolean().default(true),
    cli: z.boolean().default(true),
  })
  .strict();

export type Availability = z.infer<typeof availabilitySchema>;

/**
 * Routing hints for daemon-backed CLI execution.
 */
export const routingSchema = z
  .object({
    stateful: z.boolean().default(false),
  })
  .strict();

export type Routing = z.infer<typeof routingSchema>;

/**
 * MCP tool annotations (hints for clients).
 * All properties are optional hints, not guarantees.
 */
export const annotationsSchema = z.object({
  title: z.string().optional(),
  readOnlyHint: z.boolean().optional(),
  destructiveHint: z.boolean().optional(),
  idempotentHint: z.boolean().optional(),
  openWorldHint: z.boolean().optional(),
});

export type Annotations = z.infer<typeof annotationsSchema>;

/**
 * Tool names for MCP and CLI.
 */
export const toolNamesSchema = z.object({
  /** MCP name is required and must be globally unique */
  mcp: z.string(),
  /** CLI name is optional; if omitted, derived from MCP name */
  cli: z.string().optional(),
});

export type ToolNames = z.infer<typeof toolNamesSchema>;

export const outputSchemaMetadataSchema = z
  .object({
    schema: z.string().regex(/^mobilebuildmcp\.output\.[a-z0-9-]+$/),
    version: z.string().regex(/^[0-9]+$/),
  })
  .strict();

export type OutputSchemaMetadata = z.infer<typeof outputSchemaMetadataSchema>;

/**
 * Static next-step template declared on a tool manifest.
 */
export const manifestNextStepTemplateSchema = z
  .object({
    label: z.string(),
    toolId: z.string().optional(),
    params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
    priority: z.number().optional(),
    when: z.enum(['always', 'success', 'failure']).default('always'),
    condition: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/)
      .optional(),
  })
  .strict();

export type ManifestNextStepTemplate = z.infer<typeof manifestNextStepTemplateSchema>;

/**
 * Tool manifest entry schema.
 * Describes a single tool's metadata and configuration.
 */
export const toolManifestEntrySchema = z.object({
  /** Unique tool identifier */
  id: z.string(),

  /**
   * Module path (extensionless, package-relative).
   * Resolved to build/<module>.js at runtime.
   */
  module: z.string(),

  /** Tool names for MCP and CLI */
  names: toolNamesSchema,

  /** Tool description */
  description: z.string().optional(),

  /** Per-runtime availability flags */
  availability: availabilitySchema.default({ mcp: true, cli: true }),

  /** Predicate names for visibility filtering (all must pass) */
  predicates: z.array(z.string()).default([]),

  /** Routing hints for daemon */
  routing: routingSchema.optional(),

  /** MCP annotations (hints for clients) */
  annotations: annotationsSchema.optional(),

  /** Structured output schema advertised to MCP clients */
  outputSchema: outputSchemaMetadataSchema.optional(),

  /** Static next-step templates for this tool */
  nextSteps: z.array(manifestNextStepTemplateSchema).default([]),
});

export type ToolManifestEntry = z.infer<typeof toolManifestEntrySchema>;

/**
 * MCP-specific workflow selection rules.
 */
export const workflowSelectionMcpSchema = z.object({
  /** Used when config.enabledWorkflows is empty */
  defaultEnabled: z.boolean().default(false),
  /** Include when predicates pass, regardless of user selection */
  autoInclude: z.boolean().default(false),
});

export type WorkflowSelectionMcp = z.infer<typeof workflowSelectionMcpSchema>;

/**
 * Workflow selection rules.
 */
export const workflowSelectionSchema = z.object({
  mcp: workflowSelectionMcpSchema.optional(),
});

export type WorkflowSelection = z.infer<typeof workflowSelectionSchema>;

/**
 * Apple platforms used by setup to recommend workflows.
 */
export const workflowTargetPlatformSchema = z.enum(['iOS', 'macOS', 'tvOS', 'watchOS', 'visionOS']);

export type WorkflowTargetPlatform = z.infer<typeof workflowTargetPlatformSchema>;

/**
 * Workflow manifest entry schema.
 * Describes a workflow's metadata and tool composition.
 */
export const workflowManifestEntrySchema = z.object({
  /** Unique workflow identifier (matches directory name) */
  id: z.string(),

  /** Display title for the workflow */
  title: z.string(),

  /** Workflow description */
  description: z.string(),

  /** Setup platforms this workflow is recommended for */
  targetPlatforms: z.array(workflowTargetPlatformSchema),

  /** Per-runtime availability flags */
  availability: availabilitySchema.default({ mcp: true, cli: true }),

  /** MCP selection rules */
  selection: workflowSelectionSchema.optional(),

  /** Predicate names for visibility filtering (all must pass) */
  predicates: z.array(z.string()).default([]),

  /** Tool IDs belonging to this workflow */
  tools: z.array(z.string()),
});

export type WorkflowManifestEntry = z.infer<typeof workflowManifestEntrySchema>;

/**
 * Resource availability flags (MCP only).
 */
export const resourceAvailabilitySchema = z
  .object({
    mcp: z.boolean().default(true),
  })
  .strict();

export type ResourceAvailability = z.infer<typeof resourceAvailabilitySchema>;

/**
 * Resource manifest entry schema.
 * Describes a single MCP resource's metadata and configuration.
 */
export const resourceManifestEntrySchema = z.object({
  /** Unique resource identifier */
  id: z.string(),

  /**
   * Module path (extensionless, package-relative).
   * Resolved to build/<module>.js at runtime.
   */
  module: z.string(),

  /** MCP resource name */
  name: z.string(),

  /** Resource URI (e.g., mobilebuildmcp://simulators) */
  uri: z.string(),

  /** Resource description */
  description: z.string(),

  /** MIME type for the resource content */
  mimeType: z.string(),

  /** Per-runtime availability flags */
  availability: resourceAvailabilitySchema.default({ mcp: true }),

  /** Predicate names for visibility filtering (all must pass) */
  predicates: z.array(z.string()).default([]),
});

export type ResourceManifestEntry = z.infer<typeof resourceManifestEntrySchema>;

/**
 * Resolved manifest containing all tools, workflows, and resources.
 */
export interface ResolvedManifest {
  tools: Map<string, ToolManifestEntry>;
  workflows: Map<string, WorkflowManifestEntry>;
  resources: Map<string, ResourceManifestEntry>;
}

/**
 * Derive CLI name from MCP name using kebab-case conversion.
 * - Underscores become hyphens
 * - camelCase becomes kebab-case
 */
export function deriveCliName(mcpName: string): string {
  return mcpName
    .replace(/_/g, '-')
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .toLowerCase();
}

/**
 * Get the effective CLI name for a tool.
 */
export function getEffectiveCliName(tool: ToolManifestEntry): string {
  return tool.names.cli ?? deriveCliName(tool.names.mcp);
}
