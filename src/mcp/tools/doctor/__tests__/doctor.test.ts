import { describe, it, expect } from 'vitest';
import * as z from 'zod';
import { createDoctorExecutor, schema, runDoctor, type DoctorDependencies } from '../doctor.ts';
import { createMockExecutor } from '../../../../test-utils/mock-executors.ts';
import { allText } from '../../../../test-utils/test-helpers.ts';

function createDeps(overrides?: Partial<DoctorDependencies>): DoctorDependencies {
  const base: DoctorDependencies = {
    commandExecutor: createMockExecutor({ output: 'lldb-dap' }),
    binaryChecker: {
      async checkBinaryAvailability(binary: string) {
        // default: all available with generic version
        return { available: true, version: `${binary} version 1.0.0` };
      },
    },
    xcode: {
      async getXcodeInfo() {
        return {
          version: 'Xcode 15.0 - Build version 15A240d',
          path: '/Applications/Xcode.app/Contents/Developer',
          selectedXcode: '/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild',
          xcrunVersion: 'xcrun version 65',
        };
      },
    },
    env: {
      getEnvironmentVariables() {
        const x: Record<string, string | undefined> = {
          MOBILEBUILDMCP_DEBUG: 'true',
          INCREMENTAL_BUILDS_ENABLED: '1',
          PATH: '/usr/local/bin:/usr/bin:/bin',
          DEVELOPER_DIR: '/Applications/Xcode.app/Contents/Developer',
          HOME: '/Users/testuser',
          USER: 'testuser',
          TMPDIR: '/tmp',
          NODE_ENV: 'test',
          SENTRY_DISABLED: 'false',
        };
        return x;
      },
      getSystemInfo() {
        return {
          platform: 'darwin',
          release: '25.0.0',
          arch: 'arm64',
          cpus: '10 x Apple M3',
          memory: '32 GB',
          hostname: 'localhost',
          username: 'testuser',
          homedir: '/Users/testuser',
          tmpdir: '/tmp',
        };
      },
      getNodeInfo() {
        return {
          version: 'v22.0.0',
          execPath: '/usr/local/bin/node',
          pid: '123',
          ppid: '1',
          platform: 'darwin',
          arch: 'arm64',
          cwd: '/',
          argv: 'node build/index.js',
        };
      },
    },
    manifest: {
      async getManifestToolInfo() {
        return {
          totalTools: 1,
          workflowCount: 1,
          toolsByWorkflow: { doctor: 1 },
        };
      },
    },
    features: {
      areAxeToolsAvailable: () => true,
      isAxeAtLeastVersion: async () => true,
      isXcodemakeEnabled: () => true,
      isXcodemakeBinaryAvailable: () => true,
      doesMakefileExist: () => true,
    },
    runtime: {
      async getRuntimeToolInfo() {
        return {
          enabledWorkflows: ['doctor'],
          registeredToolCount: 1,
        };
      },
    },
  };

  return {
    ...base,
    ...overrides,
    binaryChecker: {
      ...base.binaryChecker,
      ...(overrides?.binaryChecker ?? {}),
    },
    xcode: {
      ...base.xcode,
      ...(overrides?.xcode ?? {}),
    },
    env: {
      ...base.env,
      ...(overrides?.env ?? {}),
    },
    manifest: {
      ...base.manifest,
      ...(overrides?.manifest ?? {}),
    },
    features: {
      ...base.features,
      ...(overrides?.features ?? {}),
    },
  };
}

describe('doctor tool', () => {
  describe('Schema Validation', () => {
    it('should support optional nonRedacted flag', () => {
      const schemaObj = z.object(schema);

      // Valid input
      expect(schemaObj.safeParse({}).success).toBe(true);
      expect(schemaObj.safeParse({ nonRedacted: true }).success).toBe(true);
      expect(schemaObj.safeParse({ nonRedacted: false }).success).toBe(true);

      // Invalid type
      expect(schemaObj.safeParse({ nonRedacted: 'yes' }).success).toBe(false);
    });
  });

  describe('Handler Behavior (Complete Literal Returns)', () => {
    it('returns a result without requiring an execution context', async () => {
      const executeDoctor = createDoctorExecutor(createDeps());
      const result = await executeDoctor({});

      expect(result.didError).toBe(false);
    });

    it('keeps doctor executor failure summary short and preserves diagnostics', async () => {
      const deps = createDeps();
      deps.env.getSystemInfo = () => {
        throw new Error('system profiler failed');
      };
      const executeDoctor = createDoctorExecutor(deps);

      const result = await executeDoctor({});

      expect(result.didError).toBe(true);
      expect(result.error).toBe('Doctor failed.');
      expect(result.diagnostics?.errors).toEqual([{ message: 'system profiler failed' }]);
    });

    it('should handle successful doctor execution', async () => {
      const deps = createDeps();
      const result = await runDoctor({}, deps);

      expect(result.content.length).toBeGreaterThan(0);
      const text = allText(result);
      expect(text).toContain('Manifest Tool Inventory');
      expect(text).not.toContain('Total Plugins');
    });

    it('should handle manifest loading failure', async () => {
      const deps = createDeps({
        manifest: {
          async getManifestToolInfo() {
            return { error: 'Manifest loading failed' };
          },
        },
      });

      const result = await runDoctor({}, deps);

      expect(result.content.length).toBeGreaterThan(0);
      const text = allText(result);
      expect(text).toContain('Manifest loading failed');
    });

    it('should handle xcode command failure', async () => {
      const deps = createDeps({
        xcode: {
          async getXcodeInfo() {
            return { error: 'Xcode not found' };
          },
        },
      });
      const result = await runDoctor({}, deps);

      expect(result.content.length).toBeGreaterThan(0);
      const text = allText(result);
      expect(text).toContain('Xcode not found');
    });

    it('should handle xcodemake check failure', async () => {
      const deps = createDeps({
        features: {
          areAxeToolsAvailable: () => true,
          isAxeAtLeastVersion: async () => true,
          isXcodemakeEnabled: () => true,
          isXcodemakeBinaryAvailable: () => false,
          doesMakefileExist: () => true,
        },
        binaryChecker: {
          async checkBinaryAvailability(binary: string) {
            if (binary === 'xcodemake') return { available: false };
            return { available: true, version: `${binary} version 1.0.0` };
          },
        },
      });
      const result = await runDoctor({}, deps);

      expect(result.content.length).toBeGreaterThan(0);
      const text = allText(result);
      expect(text).toContain('xcodemake: Not found');
    });

    it('should redact path and sensitive values in output', async () => {
      const deps = createDeps({
        env: {
          getEnvironmentVariables() {
            return {
              PATH: '/Users/testuser/Developer/MySecretProject/bin:/usr/bin',
              HOME: '/Users/testuser',
              USER: 'testuser',
              TMPDIR: '/Users/testuser/tmp',
              MOBILEBUILDMCP_API_KEY: 'super-secret-key',
            };
          },
          getSystemInfo: () => ({
            platform: 'darwin',
            release: '25.0.0',
            arch: 'arm64',
            cpus: '10 x Apple M3',
            memory: '32 GB',
            hostname: 'testhost',
            username: 'testuser',
            homedir: '/Users/testuser',
            tmpdir: '/Users/testuser/tmp',
          }),
          getNodeInfo: () => ({
            version: 'v22.0.0',
            execPath: '/usr/local/bin/node',
            pid: '123',
            ppid: '1',
            platform: 'darwin',
            arch: 'arm64',
            cwd: '/Users/testuser/Developer/MySecretProject',
            argv: 'node /Users/testuser/Developer/MySecretProject/build/doctor-cli.js --token=abc123',
          }),
        },
      });

      const result = await runDoctor({}, deps);
      const text = allText(result);

      expect(text).toContain('<redacted>');
      expect(text).not.toContain('testuser');
      expect(text).not.toContain('MySecretProject');
      expect(text).not.toContain('super-secret-key');
      expect(text).toContain('/Users/<redacted>');
      expect(text).toContain('Output Mode: Redacted (default)');
    });

    it('should allow non-redacted output when explicitly requested', async () => {
      const deps = createDeps({
        env: {
          getEnvironmentVariables() {
            return {
              PATH: '/Users/testuser/Developer/MySecretProject/bin:/usr/bin',
              HOME: '/Users/testuser',
              USER: 'testuser',
              TMPDIR: '/Users/testuser/tmp',
            };
          },
          getSystemInfo: () => ({
            platform: 'darwin',
            release: '25.0.0',
            arch: 'arm64',
            cpus: '10 x Apple M3',
            memory: '32 GB',
            hostname: 'testhost',
            username: 'testuser',
            homedir: '/Users/testuser',
            tmpdir: '/Users/testuser/tmp',
          }),
          getNodeInfo: () => ({
            version: 'v22.0.0',
            execPath: '/usr/local/bin/node',
            pid: '123',
            ppid: '1',
            platform: 'darwin',
            arch: 'arm64',
            cwd: '/Users/testuser/Developer/MySecretProject',
            argv: 'node /Users/testuser/Developer/MySecretProject/build/doctor-cli.js',
          }),
        },
      });

      const result = await runDoctor({ nonRedacted: true }, deps);
      const text = allText(result);

      expect(text).toContain('Output Mode: Non-redacted (opt-in)');
      expect(text).toContain('testuser');
      expect(text).toContain('MySecretProject');
    });

    it('should handle axe tools not available', async () => {
      const deps = createDeps({
        features: {
          areAxeToolsAvailable: () => false,
          isAxeAtLeastVersion: async () => false,
          isXcodemakeEnabled: () => false,
          isXcodemakeBinaryAvailable: () => false,
          doesMakefileExist: () => false,
        },
        binaryChecker: {
          async checkBinaryAvailability(binary: string) {
            if (binary === 'axe') return { available: false };
            if (binary === 'xcodemake') return { available: false };
            if (binary === 'mise') return { available: true, version: 'mise 1.0.0' };
            return { available: true };
          },
        },
        env: {
          getEnvironmentVariables() {
            const x: Record<string, string | undefined> = {
              MOBILEBUILDMCP_DEBUG: 'true',
              INCREMENTAL_BUILDS_ENABLED: '0',
              PATH: '/usr/local/bin:/usr/bin:/bin',
              DEVELOPER_DIR: '/Applications/Xcode.app/Contents/Developer',
              HOME: '/Users/testuser',
              USER: 'testuser',
              TMPDIR: '/tmp',
              NODE_ENV: 'test',
              SENTRY_DISABLED: 'true',
            };
            return x;
          },
          getSystemInfo: () => ({
            platform: 'darwin',
            release: '25.0.0',
            arch: 'arm64',
            cpus: '10 x Apple M3',
            memory: '32 GB',
            hostname: 'localhost',
            username: 'testuser',
            homedir: '/Users/testuser',
            tmpdir: '/tmp',
          }),
          getNodeInfo: () => ({
            version: 'v22.0.0',
            execPath: '/usr/local/bin/node',
            pid: '123',
            ppid: '1',
            platform: 'darwin',
            arch: 'arm64',
            cwd: '/',
            argv: 'node build/index.js',
          }),
        },
      });

      const result = await runDoctor({}, deps);

      expect(result.content.length).toBeGreaterThan(0);
      const text = allText(result);
      expect(text).toContain('Available: No');
      expect(text).toContain('UI Automation Supported: No');
    });
  });
});
