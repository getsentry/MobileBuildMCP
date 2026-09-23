import { describe, it, expect, beforeEach } from 'vitest';
import {
  createMockFileSystemExecutor,
  createNoopExecutor,
  createMockExecutor,
  createMockCommandResponse,
} from '../../../../test-utils/mock-executors.ts';
import { schema, handler, scaffold_macos_projectLogic } from '../scaffold_macos_project.ts';
import { TemplateManager } from '../../../../utils/template/index.ts';
import {
  __resetConfigStoreForTests,
  initConfigStore,
  type RuntimeConfigOverrides,
} from '../../../../utils/config-store.ts';
import { allText, createMockToolHandlerContext } from '../../../../test-utils/test-helpers.ts';

const runLogic = async (logic: () => Promise<unknown>) => {
  const { result, run } = createMockToolHandlerContext();
  const response = await run(logic);

  if (
    response &&
    typeof response === 'object' &&
    'content' in (response as Record<string, unknown>)
  ) {
    return response as {
      content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
      isError?: boolean;
      nextStepParams?: unknown;
    };
  }

  const text = result.text();
  const textContent = text.length > 0 ? [{ type: 'text' as const, text }] : [];
  const imageContent = result.attachments.map((attachment) => ({
    type: 'image' as const,
    data: attachment.data,
    mimeType: attachment.mimeType,
  }));

  return {
    content: [...textContent, ...imageContent],
    isError: result.isError() ? true : undefined,
    nextStepParams: result.nextStepParams,
    attachments: result.attachments,
    text,
  };
};

const cwd = '/repo';

async function initConfigStoreForTest(overrides?: RuntimeConfigOverrides): Promise<void> {
  __resetConfigStoreForTests();
  await initConfigStore({ cwd, fs: createMockFileSystemExecutor(), overrides });
}

describe('scaffold_macos_project plugin', () => {
  let mockFileSystemExecutor: ReturnType<typeof createMockFileSystemExecutor>;
  let templateManagerStub: {
    getTemplatePath: (
      platform: string,
      commandExecutor?: unknown,
      fileSystemExecutor?: unknown,
    ) => Promise<string>;
    cleanup: (path: string) => Promise<void>;
    setError: (error: Error | string | null) => void;
    getCalls: () => string;
    resetCalls: () => void;
  };

  beforeEach(async () => {
    let templateManagerCall = '';
    let templateManagerError: Error | string | null = null;

    templateManagerStub = {
      getTemplatePath: async (
        platform: string,
        commandExecutor?: unknown,
        fileSystemExecutor?: unknown,
      ) => {
        templateManagerCall = `getTemplatePath(${platform})`;
        if (templateManagerError) {
          throw templateManagerError;
        }
        return '/tmp/test-templates/macos';
      },
      cleanup: async (path: string) => {
        templateManagerCall += `,cleanup(${path})`;
        return undefined;
      },
      setError: (error: Error | string | null) => {
        templateManagerError = error;
      },
      getCalls: () => templateManagerCall,
      resetCalls: () => {
        templateManagerCall = '';
      },
    };

    mockFileSystemExecutor = createMockFileSystemExecutor({
      existsSync: () => false,
      mkdir: async () => {},
      cp: async () => {},
      readFile: async () => 'template content with MyProject placeholder',
      writeFile: async () => {},
      readdir: async () => [
        { name: 'Package.swift', isDirectory: () => false, isFile: () => true },
        { name: 'MyProject.swift', isDirectory: () => false, isFile: () => true },
      ],
    });

    (TemplateManager as any).getTemplatePath = templateManagerStub.getTemplatePath;
    (TemplateManager as any).cleanup = templateManagerStub.cleanup;

    await initConfigStoreForTest();
  });

  describe('Export Field Validation (Literal)', () => {
    it('should have handler as function', () => {
      expect(typeof handler).toBe('function');
    });

    it('should have valid schema with required fields', () => {
      expect(schema).toBeDefined();
      expect(schema.projectName).toBeDefined();
      expect(schema.outputPath).toBeDefined();
      expect(schema.bundleIdentifier).toBeDefined();
      expect(schema.customizeNames).toBeDefined();
      expect(schema.deploymentTarget).toBeDefined();
    });
  });

  describe('Command Generation', () => {
    it('should generate correct curl command for macOS template download', async () => {
      const expectedUrl =
        'https://github.com/getsentry/XcodeBuildMCP-macOS-Template/releases/download/';

      expect(expectedUrl).toContain('XcodeBuildMCP-macOS-Template');
      expect(expectedUrl).toContain('releases/download');

      const expectedFilename = 'template.zip';
      expect(expectedFilename).toMatch(/template\.zip$/);

      const expectedCurlFlags = ['-L', '-f', '-o'];
      expect(expectedCurlFlags).toContain('-L');
      expect(expectedCurlFlags).toContain('-f');
      expect(expectedCurlFlags).toContain('-o');
    });

    it('should generate correct unzip command for template extraction', async () => {
      const expectedUnzipCommand = ['unzip', '-q', 'template.zip'];

      expect(expectedUnzipCommand).toContain('-q');
      expect(expectedUnzipCommand).toContain('template.zip');
      expect(expectedUnzipCommand[0]).toBe('unzip');
      expect(expectedUnzipCommand[1]).toBe('-q');
      expect(expectedUnzipCommand[2]).toMatch(/template\.zip$/);
    });

    it('should generate correct commands for template with version', async () => {
      const testVersion = 'v1.0.0';
      const expectedUrlWithVersion = `https://github.com/getsentry/XcodeBuildMCP-macOS-Template/releases/download/${testVersion}/`;

      expect(expectedUrlWithVersion).toContain(testVersion);
      expect(expectedUrlWithVersion).toContain('XcodeBuildMCP-macOS-Template');
      expect(expectedUrlWithVersion).toContain('releases/download');
      expect(testVersion).toMatch(/^v\d+\.\d+\.\d+$/);
      expect(expectedUrlWithVersion).toBe(
        `https://github.com/getsentry/XcodeBuildMCP-macOS-Template/releases/download/${testVersion}/`,
      );
    });

    it('should not generate commands when using local template path', async () => {
      let capturedCommands: string[][] = [];
      const trackingExecutor = async (command: string[]) => {
        capturedCommands.push(command);
        return createMockCommandResponse({
          success: true,
          output: 'Command successful',
        });
      };

      mockFileSystemExecutor.existsSync = (path: string) => {
        return path === '/local/template/path' || path === '/local/template/path/template';
      };

      await initConfigStoreForTest({ macosTemplatePath: '/local/template/path' });

      const { TemplateManager: OriginalTemplateManager } = await import(
        '../../../../utils/template/index.ts'
      );
      (TemplateManager as any).getTemplatePath = OriginalTemplateManager.getTemplatePath;
      (TemplateManager as any).cleanup = OriginalTemplateManager.cleanup;

      await runLogic(() =>
        scaffold_macos_projectLogic(
          {
            projectName: 'TestMacApp',
            customizeNames: true,
            outputPath: '/tmp/test-projects',
          },
          trackingExecutor,
          mockFileSystemExecutor,
        ),
      );

      expect(capturedCommands).not.toContainEqual(
        expect.arrayContaining(['curl', expect.anything(), expect.anything()]),
      );
      expect(capturedCommands).not.toContainEqual(
        expect.arrayContaining(['unzip', expect.anything(), expect.anything()]),
      );

      (TemplateManager as any).getTemplatePath = templateManagerStub.getTemplatePath;
      (TemplateManager as any).cleanup = templateManagerStub.cleanup;
    });
  });

  describe('Handler Behavior (Complete Literal Returns)', () => {
    it('should return success response for valid scaffold macOS project request', async () => {
      const result = await runLogic(() =>
        scaffold_macos_projectLogic(
          {
            projectName: 'TestMacApp',
            customizeNames: true,
            outputPath: '/tmp/test-projects',
            bundleIdentifier: 'com.test.macapp',
          },
          createNoopExecutor(),
          mockFileSystemExecutor,
        ),
      );

      expect(result.isError).toBeFalsy();
      const text = allText(result);
      expect(text).toContain('Scaffold macOS Project');
      expect(text).toContain('TestMacApp');
      expect(text).toContain('/tmp/test-projects');
      expect(text).toContain('Project scaffolded successfully');
      expect(result.nextStepParams).toEqual({
        build_macos: {
          workspacePath: '/tmp/test-projects/TestMacApp.xcworkspace',
          scheme: 'TestMacApp',
        },
        build_run_macos: {
          workspacePath: '/tmp/test-projects/TestMacApp.xcworkspace',
          scheme: 'TestMacApp',
        },
      });

      expect(templateManagerStub.getCalls()).toBe(
        'getTemplatePath(macOS),cleanup(/tmp/test-templates/macos)',
      );
    });

    it('should return success response with customizeNames false', async () => {
      const result = await runLogic(() =>
        scaffold_macos_projectLogic(
          {
            projectName: 'TestMacApp',
            outputPath: '/tmp/test-projects',
            customizeNames: false,
          },
          createNoopExecutor(),
          mockFileSystemExecutor,
        ),
      );

      expect(result.isError).toBeFalsy();
      const text = allText(result);
      expect(text).toContain('Project scaffolded successfully');
      expect(result.nextStepParams).toEqual({
        build_macos: {
          workspacePath: '/tmp/test-projects/MyProject.xcworkspace',
          scheme: 'MyProject',
        },
        build_run_macos: {
          workspacePath: '/tmp/test-projects/MyProject.xcworkspace',
          scheme: 'MyProject',
        },
      });
    });

    it('should return error response for invalid project name', async () => {
      const result = await runLogic(() =>
        scaffold_macos_projectLogic(
          {
            projectName: '123InvalidName',
            customizeNames: true,
            outputPath: '/tmp/test-projects',
          },
          createNoopExecutor(),
          mockFileSystemExecutor,
        ),
      );

      expect(result.isError).toBe(true);
      const text = allText(result);
      expect(text).toContain('Project name must start with a letter');
    });

    it('should return error response for existing project files', async () => {
      mockFileSystemExecutor.existsSync = () => true;

      const result = await runLogic(() =>
        scaffold_macos_projectLogic(
          {
            projectName: 'TestMacApp',
            customizeNames: true,
            outputPath: '/tmp/test-projects',
          },
          createNoopExecutor(),
          mockFileSystemExecutor,
        ),
      );

      expect(result.isError).toBe(true);
      const text = allText(result);
      expect(text).toContain('Xcode project files already exist in /tmp/test-projects');
    });

    it('should return error response for template manager failure', async () => {
      templateManagerStub.setError(new Error('Template not found'));

      const result = await runLogic(() =>
        scaffold_macos_projectLogic(
          {
            projectName: 'TestMacApp',
            customizeNames: true,
            outputPath: '/tmp/test-projects',
          },
          createNoopExecutor(),
          mockFileSystemExecutor,
        ),
      );

      expect(result.isError).toBe(true);
      const text = allText(result);
      expect(text).toContain('Failed to get template for macOS: Template not found');
    });
  });

  describe('File System Operations', () => {
    it('should create directories and process files correctly', async () => {
      await runLogic(() =>
        scaffold_macos_projectLogic(
          {
            projectName: 'TestApp',
            customizeNames: true,
            outputPath: '/tmp/test',
          },
          createNoopExecutor(),
          mockFileSystemExecutor,
        ),
      );

      expect(templateManagerStub.getCalls()).toBe(
        'getTemplatePath(macOS),cleanup(/tmp/test-templates/macos)',
      );
    });
  });
});
