import { describe, it, expect, beforeEach } from 'vitest';
import * as z from 'zod';
import {
  createSessionAwareTool,
  getHandlerContext,
  type ToolHandler,
} from '../typed-tool-factory.ts';
import { sessionStore } from '../session-store.ts';
import {
  createMockExecutor,
  createMockFileSystemExecutor,
} from '../../test-utils/mock-executors.ts';
import {
  __resetConfigStoreForTests,
  initConfigStore,
  type RuntimeConfigOverrides,
} from '../config-store.ts';
import { createRenderSession } from '../../rendering/render.ts';
import type { ToolHandlerContext } from '../../rendering/types.ts';
import type { AnyFragment } from '../../types/domain-fragments.ts';
import type { RuntimeStatusFragment } from '../../types/runtime-status.ts';
import { renderCliTextTranscript } from '../renderers/cli-text-renderer.ts';

const cwd = '/repo';

async function initConfigStoreForTest(overrides?: RuntimeConfigOverrides): Promise<void> {
  __resetConfigStoreForTests();
  await initConfigStore({ cwd, fs: createMockFileSystemExecutor(), overrides });
}

function statusFragment(
  level: 'info' | 'warning' | 'error' | 'success',
  message: string,
): RuntimeStatusFragment {
  return { kind: 'infrastructure', fragment: 'status', level, message };
}

function invokeAndCollect(
  handler: ToolHandler,
  args: Record<string, unknown>,
): Promise<{
  text: string;
  isError: boolean;
  structuredOutput: ToolHandlerContext['structuredOutput'];
}> {
  const session = createRenderSession('text');
  const items: AnyFragment[] = [];
  const ctx: ToolHandlerContext = {
    emit: (event) => {
      items.push(event);
      session.emit(event);
    },
    attach: (image) => session.attach(image),
  };
  return handler(args, ctx).then(() => {
    if (ctx.structuredOutput) {
      session.setStructuredOutput?.(ctx.structuredOutput);
    }
    return {
      text: renderCliTextTranscript({ items, structuredOutput: ctx.structuredOutput }),
      isError: session.isError(),
      structuredOutput: ctx.structuredOutput,
    };
  });
}

describe('createSessionAwareTool', () => {
  beforeEach(async () => {
    sessionStore.clearAll();
    await initConfigStoreForTest({ disableSessionDefaults: false });
  });

  const internalSchema = z
    .object({
      scheme: z.string(),
      projectPath: z.string().optional(),
      workspacePath: z.string().optional(),
      simulatorId: z.string().optional(),
      simulatorName: z.string().optional(),
    })
    .refine((v) => !!v.projectPath !== !!v.workspacePath, {
      message: 'projectPath and workspacePath are mutually exclusive',
      path: ['projectPath'],
    })
    .refine((v) => !!v.simulatorId !== !!v.simulatorName, {
      message: 'simulatorId and simulatorName are mutually exclusive',
      path: ['simulatorId'],
    });

  type Params = z.infer<typeof internalSchema>;

  async function logic(_params: Params): Promise<void> {
    const ctx = getHandlerContext();
    ctx.emit(statusFragment('success', 'OK'));
  }

  const handler = createSessionAwareTool<Params>({
    internalSchema,
    logicFunction: logic,
    getExecutor: () => createMockExecutor({ success: true }),
    requirements: [
      { allOf: ['scheme'], message: 'scheme is required' },
      { oneOf: ['projectPath', 'workspacePath'], message: 'Provide a project or workspace' },
      { oneOf: ['simulatorId', 'simulatorName'], message: 'Provide simulatorId or simulatorName' },
    ],
  });

  it('should merge session defaults and satisfy requirements', async () => {
    sessionStore.setDefaults({
      scheme: 'App',
      projectPath: '/path/proj.xcodeproj',
      simulatorId: 'SIM-1',
    });

    const result = await invokeAndCollect(handler, {});
    expect(result.isError).toBe(false);
    expect(result.text).toContain('OK');
  });

  it('should prefer explicit args over session defaults (same key wins)', async () => {
    const echoHandler = createSessionAwareTool<Params>({
      internalSchema,
      logicFunction: async (params) => {
        const ctx = getHandlerContext();
        ctx.emit(statusFragment('success', params.scheme));
      },
      getExecutor: () => createMockExecutor({ success: true }),
      requirements: [
        { allOf: ['scheme'], message: 'scheme is required' },
        { oneOf: ['projectPath', 'workspacePath'], message: 'Provide a project or workspace' },
        {
          oneOf: ['simulatorId', 'simulatorName'],
          message: 'Provide simulatorId or simulatorName',
        },
      ],
    });

    sessionStore.setDefaults({
      scheme: 'Default',
      projectPath: '/a.xcodeproj',
      simulatorId: 'SIM-A',
    });
    const result = await invokeAndCollect(echoHandler, { scheme: 'FromArgs' });
    expect(result.isError).toBe(false);
    expect(result.text).toContain('FromArgs');
  });

  it('should return friendly error when allOf requirement missing', async () => {
    const result = await invokeAndCollect(handler, {
      projectPath: '/p.xcodeproj',
      simulatorId: 'SIM-1',
    });
    expect(result.isError).toBe(true);
    expect(result.structuredOutput?.schema).toBe('mobilebuildmcp.output.error');
    expect(result.structuredOutput?.result.error).toContain('Missing required session defaults');
    expect(result.text).toContain('Missing required session defaults');
    expect(result.text).toContain('scheme is required');
  });

  it('should return friendly error when oneOf requirement missing', async () => {
    const result = await invokeAndCollect(handler, { scheme: 'App', simulatorId: 'SIM-1' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Missing required session defaults');
    expect(result.text).toContain('Provide a project or workspace');
  });

  it('uses opt-out messaging when session defaults schema is disabled', async () => {
    await initConfigStoreForTest({ disableSessionDefaults: true });

    const result = await invokeAndCollect(handler, {
      projectPath: '/p.xcodeproj',
      simulatorId: 'SIM-1',
    });
    expect(result.isError).toBe(true);
    const text = result.text;
    expect(text).toContain('Missing required parameters');
    expect(text).toContain('scheme is required');
    expect(text).not.toContain('session defaults');
  });

  it('should surface Zod validation errors when invalid', async () => {
    const badHandler = createSessionAwareTool<unknown>({
      internalSchema,
      logicFunction: logic as (params: unknown, executor: unknown) => Promise<void>,
      getExecutor: () => createMockExecutor({ success: true }),
    });
    const result = await invokeAndCollect(badHandler, { scheme: 123 });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Parameter validation failed');
  });

  it('exclusivePairs should NOT prune session defaults when user provides null (treat as not provided)', async () => {
    const handlerWithExclusive = createSessionAwareTool<Params>({
      internalSchema,
      logicFunction: logic,
      getExecutor: () => createMockExecutor({ success: true }),
      requirements: [
        { allOf: ['scheme'], message: 'scheme is required' },
        { oneOf: ['projectPath', 'workspacePath'], message: 'Provide a project or workspace' },
      ],
      exclusivePairs: [['projectPath', 'workspacePath']],
    });

    sessionStore.setDefaults({
      scheme: 'App',
      projectPath: '/path/proj.xcodeproj',
      simulatorId: 'SIM-1',
    });

    const res = await invokeAndCollect(handlerWithExclusive, {
      workspacePath: null as unknown as string,
    });
    expect(res.isError).toBe(false);
    expect(res.text).toContain('OK');
  });

  it('exclusivePairs should NOT prune when user provides undefined (treated as not provided)', async () => {
    const handlerWithExclusive = createSessionAwareTool<Params>({
      internalSchema,
      logicFunction: logic,
      getExecutor: () => createMockExecutor({ success: true }),
      requirements: [
        { allOf: ['scheme'], message: 'scheme is required' },
        { oneOf: ['projectPath', 'workspacePath'], message: 'Provide a project or workspace' },
      ],
      exclusivePairs: [['projectPath', 'workspacePath']],
    });

    sessionStore.setDefaults({
      scheme: 'App',
      projectPath: '/path/proj.xcodeproj',
      simulatorId: 'SIM-1',
    });

    const res = await invokeAndCollect(handlerWithExclusive, {
      workspacePath: undefined as unknown as string,
    });
    expect(res.isError).toBe(false);
    expect(res.text).toContain('OK');
  });

  it('rejects when multiple explicit args in an exclusive pair are provided (factory-level)', async () => {
    const internalSchemaNoXor = z.object({
      scheme: z.string(),
      projectPath: z.string().optional(),
      workspacePath: z.string().optional(),
    });

    const handlerNoXor = createSessionAwareTool<z.infer<typeof internalSchemaNoXor>>({
      internalSchema: internalSchemaNoXor,
      logicFunction: (async () => {
        const ctx = getHandlerContext();
        ctx.emit(statusFragment('success', 'OK'));
      }) as (params: z.infer<typeof internalSchemaNoXor>, executor: unknown) => Promise<void>,
      getExecutor: () => createMockExecutor({ success: true }),
      requirements: [{ allOf: ['scheme'], message: 'scheme is required' }],
      exclusivePairs: [['projectPath', 'workspacePath']],
    });

    const res = await invokeAndCollect(handlerNoXor, {
      scheme: 'App',
      projectPath: '/path/a.xcodeproj',
      workspacePath: '/path/b.xcworkspace',
    });

    expect(res.isError).toBe(true);
    const msg = res.text;
    expect(msg).toContain('Parameter validation failed');
    expect(msg).toContain('Mutually exclusive parameters provided');
    expect(msg).toContain('projectPath');
    expect(msg).toContain('workspacePath');
  });

  it('allows exclusive pairs to include tool-local keys that are not session defaults', async () => {
    const attachSchema = z
      .object({
        simulatorId: z.string(),
        bundleId: z.string().optional(),
        pid: z.number().optional(),
      })
      .refine((v) => !(v.bundleId && v.pid), {
        message: 'bundleId and pid are mutually exclusive',
      });

    const attachHandler = createSessionAwareTool<z.infer<typeof attachSchema>>({
      internalSchema: attachSchema,
      logicFunction: async (params) => {
        const ctx = getHandlerContext();
        ctx.emit(statusFragment('success', JSON.stringify(params)));
      },
      getExecutor: () => createMockExecutor({ success: true }),
      requirements: [{ allOf: ['simulatorId'] }],
      exclusivePairs: [['bundleId', 'pid']],
    });

    sessionStore.setDefaults({
      simulatorId: 'SIM-123',
      bundleId: 'com.default.app',
    });

    const result = await invokeAndCollect(attachHandler, { pid: 1234 });
    expect(result.isError).toBe(false);

    const parsed = JSON.parse(result.text.replace(/\n/g, '').replace(/^.*?(\{.*\}).*$/, '$1'));
    expect(parsed).toMatchObject({ simulatorId: 'SIM-123', pid: 1234 });
    expect(parsed.bundleId).toBeUndefined();
  });

  it('prefers first key when both values of exclusive pair come from session defaults', async () => {
    const echoHandler = createSessionAwareTool<Params>({
      internalSchema: z.object({
        scheme: z.string(),
        projectPath: z.string().optional(),
        simulatorId: z.string().optional(),
        simulatorName: z.string().optional(),
      }),
      logicFunction: async (params) => {
        const ctx = getHandlerContext();
        ctx.emit(
          statusFragment(
            'success',
            JSON.stringify({
              simulatorId: params.simulatorId,
              simulatorName: params.simulatorName,
            }),
          ),
        );
      },
      getExecutor: () => createMockExecutor({ success: true }),
      requirements: [{ allOf: ['scheme'] }],
      exclusivePairs: [['simulatorId', 'simulatorName']],
    });

    sessionStore.setDefaults({
      scheme: 'App',
      projectPath: '/a.xcodeproj',
      simulatorId: 'SIM-123',
      simulatorName: 'iPhone 17',
    });

    const result = await invokeAndCollect(echoHandler, {});
    expect(result.isError).toBe(false);

    const parsed = JSON.parse(result.text.replace(/\n/g, '').replace(/^.*?(\{.*\}).*$/, '$1'));
    expect(parsed.simulatorId).toBe('SIM-123');
    expect(parsed.simulatorName).toBeUndefined();
  });

  it('deep-merges env so user-provided env vars are additive with session defaults', async () => {
    const envSchema = z.object({
      scheme: z.string(),
      projectPath: z.string().optional(),
      env: z.record(z.string(), z.string()).optional(),
    });

    const envHandler = createSessionAwareTool<z.infer<typeof envSchema>>({
      internalSchema: envSchema,
      logicFunction: async (params) => {
        const ctx = getHandlerContext();
        ctx.emit(statusFragment('success', JSON.stringify(params.env)));
      },
      getExecutor: () => createMockExecutor({ success: true }),
      requirements: [{ allOf: ['scheme'] }],
    });

    sessionStore.setDefaults({
      scheme: 'App',
      projectPath: '/a.xcodeproj',
      env: { API_KEY: 'abc123', VERBOSE: '1' },
    });

    const result = await invokeAndCollect(envHandler, { env: { DEBUG: 'true', VERBOSE: '0' } });
    expect(result.isError).toBe(false);

    const parsed = JSON.parse(result.text.replace(/\n/g, '').replace(/^.*?(\{.*\}).*$/, '$1'));
    expect(parsed).toEqual({ API_KEY: 'abc123', DEBUG: 'true', VERBOSE: '0' });
  });

  it('only merges session defaults that exist in the schema before strict validation', async () => {
    const strictSchema = z.strictObject({
      bundleId: z.string(),
    });

    const strictHandler = createSessionAwareTool<z.infer<typeof strictSchema>>({
      internalSchema: strictSchema,
      logicFunction: async (params) => {
        const ctx = getHandlerContext();
        ctx.emit(statusFragment('success', JSON.stringify(params)));
      },
      getExecutor: () => createMockExecutor({ success: true }),
      requirements: [{ allOf: ['bundleId'] }],
    });

    sessionStore.setDefaults({
      scheme: 'App',
      projectPath: '/a.xcodeproj',
      simulatorId: 'SIM-123',
      bundleId: 'com.example.app',
    });

    const result = await invokeAndCollect(strictHandler, {});
    expect(result.isError).toBe(false);

    const parsed = JSON.parse(result.text.replace(/\n/g, '').replace(/^.*?(\{.*\}).*$/, '$1'));
    expect(parsed).toEqual({ bundleId: 'com.example.app' });
  });

  it('uses filtered session defaults to satisfy required fields on strict schemas', async () => {
    const strictSchema = z.strictObject({
      scheme: z.string(),
      projectPath: z.string(),
    });

    const strictHandler = createSessionAwareTool<z.infer<typeof strictSchema>>({
      internalSchema: strictSchema,
      logicFunction: async (params) => {
        const ctx = getHandlerContext();
        ctx.emit(statusFragment('success', JSON.stringify(params)));
      },
      getExecutor: () => createMockExecutor({ success: true }),
      requirements: [{ allOf: ['scheme', 'projectPath'] }],
    });

    sessionStore.setDefaults({
      scheme: 'App',
      projectPath: '/a.xcodeproj',
      simulatorId: 'SIM-123',
    });

    const result = await invokeAndCollect(strictHandler, {});
    expect(result.isError).toBe(false);

    const parsed = JSON.parse(result.text.replace(/\n/g, '').replace(/^.*?(\{.*\}).*$/, '$1'));
    expect(parsed).toEqual({ scheme: 'App', projectPath: '/a.xcodeproj' });
  });

  it('rejects explicit unknown args on strict schemas after filtering session defaults', async () => {
    const strictSchema = z.strictObject({
      bundleId: z.string(),
    });

    const strictHandler = createSessionAwareTool<z.infer<typeof strictSchema>>({
      internalSchema: strictSchema,
      logicFunction: async (params) => {
        const ctx = getHandlerContext();
        ctx.emit(statusFragment('success', JSON.stringify(params)));
      },
      getExecutor: () => createMockExecutor({ success: true }),
      requirements: [{ allOf: ['bundleId'] }],
    });

    sessionStore.setDefaults({
      bundleId: 'com.example.app',
      simulatorId: 'SIM-123',
    });

    const result = await invokeAndCollect(strictHandler, { simulatorName: 'iPhone 17' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Parameter validation failed');
    expect(result.text).toContain('simulatorName');
  });

  it('applies refinements after filtering unrelated session defaults', async () => {
    const refinedSchema = z
      .strictObject({
        scheme: z.string(),
        projectPath: z.string().optional(),
        workspacePath: z.string().optional(),
      })
      .refine((params) => !!params.projectPath !== !!params.workspacePath, {
        message: 'provide exactly one projectPath or workspacePath',
        path: ['projectPath'],
      });

    const refinedHandler = createSessionAwareTool<z.infer<typeof refinedSchema>>({
      internalSchema: refinedSchema,
      logicFunction: async (params) => {
        const ctx = getHandlerContext();
        ctx.emit(statusFragment('success', JSON.stringify(params)));
      },
      getExecutor: () => createMockExecutor({ success: true }),
      requirements: [{ allOf: ['scheme'] }],
    });

    sessionStore.setDefaults({
      scheme: 'App',
      projectPath: '/a.xcodeproj',
      workspacePath: '/a.xcworkspace',
      simulatorId: 'SIM-123',
    });

    const result = await invokeAndCollect(refinedHandler, {});
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Parameter validation failed');
    expect(result.text).toContain('provide exactly one projectPath or workspacePath');
    expect(result.text).not.toContain('simulatorId');
  });

  it('rejects array passed as env instead of deep-merging it', async () => {
    const envSchema = z.object({
      scheme: z.string(),
      projectPath: z.string().optional(),
      env: z.record(z.string(), z.string()).optional(),
    });

    const envHandler = createSessionAwareTool<z.infer<typeof envSchema>>({
      internalSchema: envSchema,
      logicFunction: async (params) => {
        const ctx = getHandlerContext();
        ctx.emit(statusFragment('success', JSON.stringify(params.env)));
      },
      getExecutor: () => createMockExecutor({ success: true }),
      requirements: [{ allOf: ['scheme'] }],
    });

    sessionStore.setDefaults({
      scheme: 'App',
      projectPath: '/a.xcodeproj',
      env: { API_KEY: 'abc123' },
    });

    const result = await invokeAndCollect(envHandler, { env: ['not', 'a', 'record'] as unknown });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Parameter validation failed');
  });

  it('appends explicit extraArgs after session default extraArgs', async () => {
    const extraArgsSchema = z.object({
      scheme: z.string(),
      projectPath: z.string().optional(),
      extraArgs: z.array(z.string()).optional(),
    });

    const extraArgsHandler = createSessionAwareTool<z.infer<typeof extraArgsSchema>>({
      internalSchema: extraArgsSchema,
      logicFunction: async (params) => {
        const ctx = getHandlerContext();
        ctx.emit(statusFragment('success', JSON.stringify(params.extraArgs)));
      },
      getExecutor: () => createMockExecutor({ success: true }),
      requirements: [{ allOf: ['scheme'] }],
    });

    sessionStore.setDefaults({
      scheme: 'App',
      projectPath: '/a.xcodeproj',
      extraArgs: ['-skipPackagePluginValidation'],
    });

    const result = await invokeAndCollect(extraArgsHandler, { extraArgs: ['-quiet'] });
    expect(result.isError).toBe(false);

    const parsed = JSON.parse(result.text.replace(/\n/g, '').replace(/^.*?(\[.*\]).*$/, '$1'));
    expect(parsed).toEqual(['-skipPackagePluginValidation', '-quiet']);
  });

  it('lets explicit destination extraArgs replace matching session default extraArgs', async () => {
    const extraArgsSchema = z.object({
      scheme: z.string(),
      projectPath: z.string().optional(),
      extraArgs: z.array(z.string()).optional(),
    });

    const extraArgsHandler = createSessionAwareTool<z.infer<typeof extraArgsSchema>>({
      internalSchema: extraArgsSchema,
      logicFunction: async (params) => {
        const ctx = getHandlerContext();
        ctx.emit(statusFragment('success', JSON.stringify(params.extraArgs)));
      },
      getExecutor: () => createMockExecutor({ success: true }),
      requirements: [{ allOf: ['scheme'] }],
    });

    sessionStore.setDefaults({
      scheme: 'App',
      projectPath: '/a.xcodeproj',
      extraArgs: ['-destination', 'id=DEFAULT', '-skipPackagePluginValidation'],
    });

    const result = await invokeAndCollect(extraArgsHandler, {
      extraArgs: ['-destination', 'id=EXPLICIT'],
    });
    expect(result.isError).toBe(false);

    const parsed = JSON.parse(result.text.replace(/\n/g, '').replace(/^.*?(\[.*\]).*$/, '$1'));
    expect(parsed).toEqual(['-skipPackagePluginValidation', '-destination', 'id=EXPLICIT']);
  });

  it('allows explicit empty extraArgs to clear session default extraArgs', async () => {
    const extraArgsSchema = z.object({
      scheme: z.string(),
      projectPath: z.string().optional(),
      extraArgs: z.array(z.string()).optional(),
    });

    const extraArgsHandler = createSessionAwareTool<z.infer<typeof extraArgsSchema>>({
      internalSchema: extraArgsSchema,
      logicFunction: async (params) => {
        const ctx = getHandlerContext();
        ctx.emit(statusFragment('success', JSON.stringify(params.extraArgs)));
      },
      getExecutor: () => createMockExecutor({ success: true }),
      requirements: [{ allOf: ['scheme'] }],
    });

    sessionStore.setDefaults({
      scheme: 'App',
      projectPath: '/a.xcodeproj',
      extraArgs: ['-skipPackagePluginValidation'],
    });

    const result = await invokeAndCollect(extraArgsHandler, { extraArgs: [] });
    expect(result.isError).toBe(false);

    const parsed = JSON.parse(result.text.replace(/\n/g, '').replace(/^.*?(\[.*\]).*$/, '$1'));
    expect(parsed).toEqual([]);
  });

  it('does not inherit a session device for a generic build-for-testing request', async () => {
    const schema = z.object({
      scheme: z.string(),
      buildForTesting: z.boolean().optional(),
      deviceId: z.string().optional(),
    });
    const handler = createSessionAwareTool<z.infer<typeof schema>>({
      internalSchema: schema,
      logicFunction: async (params) => {
        getHandlerContext().emit(statusFragment('success', JSON.stringify(params)));
      },
      getExecutor: () => createMockExecutor({ success: true }),
      requirements: [{ allOf: ['scheme'] }],
    });

    sessionStore.setDefaults({ scheme: 'App', deviceId: 'DEVICE-1' });

    const result = await invokeAndCollect(handler, { buildForTesting: true });
    expect(result.isError).toBe(false);
    expect(result.text).toContain('{"scheme":"App","buildForTesting":true}');
  });
});
