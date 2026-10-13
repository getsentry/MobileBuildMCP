import * as z from 'zod';
import { sessionDefaultsSchema } from './session-defaults-schema.ts';

export const runtimeConfigFileSchema = z
  .object({
    schemaVersion: z.literal(1).optional().default(1),
    enabledWorkflows: z.union([z.array(z.string()), z.string()]).optional(),
    customWorkflows: z.record(z.string(), z.union([z.array(z.string()), z.string()])).optional(),
    debug: z.boolean().optional(),
    sentryDisabled: z.boolean().optional(),
    experimentalWorkflowDiscovery: z.boolean().optional(),
    disableSessionDefaults: z.boolean().optional(),
    disableXcodeAutoSync: z.boolean().optional(),
    showTestTiming: z.boolean().optional(),
    filePathRenderStyle: z.enum(['tree', 'list']).optional(),
    uiDebuggerGuardMode: z.enum(['error', 'warn', 'off']).optional(),
    incrementalBuildsEnabled: z.boolean().optional(),
    testProductsMaxCount: z.number().int().positive().optional(),
    testProductsMaxAgeDays: z.number().finite().positive().optional(),
    dapRequestTimeoutMs: z.number().int().positive().optional(),
    dapLogEvents: z.boolean().optional(),
    launchJsonWaitMs: z.number().int().nonnegative().optional(),
    axePath: z.string().optional(),
    axeSourcePath: z.string().optional(),
    iosTemplatePath: z.string().optional(),
    iosTemplateVersion: z.string().optional(),
    macosTemplatePath: z.string().optional(),
    macosTemplateVersion: z.string().optional(),
    debuggerBackend: z.enum(['dap', 'lldb-cli', 'lldb']).optional(),
    sessionDefaults: sessionDefaultsSchema.optional(),
    sessionDefaultsProfiles: z.record(z.string(), sessionDefaultsSchema).optional(),
    activeSessionDefaultsProfile: z.string().optional(),
    setupPreferences: z
      .object({
        platforms: z.array(z.enum(['macOS', 'iOS', 'tvOS', 'watchOS', 'visionOS'])).optional(),
      })
      .optional(),
  })
  .passthrough();

export type RuntimeConfigFile = z.infer<typeof runtimeConfigFileSchema> & {
  [key: string]: unknown;
};
