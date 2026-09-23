import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMockExecutor } from '../../test-utils/mock-executors.ts';

const { executeXcodemakeCommandMock } = vi.hoisted(() => ({
  executeXcodemakeCommandMock: vi.fn(),
}));

vi.mock('../xcodemake.ts', () => ({
  isXcodemakeEnabled: () => true,
  isXcodemakeAvailable: () => Promise.resolve(true),
  executeXcodemakeCommand: executeXcodemakeCommandMock,
}));

import { executeXcodeBuildCommand } from '../build-utils.ts';
import { XcodePlatform } from '../xcode.ts';

describe('build-utils xcodemake lifecycle', () => {
  let projectDirectory: string;

  beforeEach(() => {
    projectDirectory = mkdtempSync(path.join(tmpdir(), 'mobilebuildmcp-xcodemake-'));
    writeFileSync(path.join(projectDirectory, 'Makefile'), 'all:\n\t@true\n');
    executeXcodemakeCommandMock.mockResolvedValue({ success: true, output: 'BUILD SUCCEEDED' });
  });

  afterEach(() => {
    rmSync(projectDirectory, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('delegates existing Makefile validation to xcodemake for external DerivedData', async () => {
    const workspacePath = path.join(projectDirectory, 'MyWorkspace.xcworkspace');
    const derivedDataPath =
      '/Users/developer/Library/Developer/MobileBuildMCP/DerivedData/MyWorkspace-57a542dedf16';
    const executorCall = vi.fn();
    const executor = createMockExecutor({ onExecute: executorCall });

    const result = await executeXcodeBuildCommand(
      {
        scheme: 'MyScheme',
        configuration: 'Debug',
        workspacePath,
        derivedDataPath,
      },
      {
        platform: XcodePlatform.iOSSimulator,
        simulatorId: 'SIMULATOR-UDID',
        logPrefix: 'iOS Simulator Build',
      },
      false,
      'build',
      executor,
    );

    expect(result.isError).toBeFalsy();
    expect(executorCall).not.toHaveBeenCalled();
    expect(executeXcodemakeCommandMock).toHaveBeenCalledWith(
      projectDirectory,
      [
        '-workspace',
        workspacePath,
        '-scheme',
        'MyScheme',
        '-configuration',
        'Debug',
        '-skipMacroValidation',
        '-destination',
        'platform=iOS Simulator,id=SIMULATOR-UDID',
        '-collect-test-diagnostics',
        'never',
        '-derivedDataPath',
        derivedDataPath,
        'build',
      ],
      'iOS Simulator Build',
    );
  });

  it('uses the current working directory when no project or workspace path is provided', async () => {
    const derivedDataPath =
      '/Users/developer/Library/Developer/MobileBuildMCP/DerivedData/MyScheme-57a542dedf16';
    const executorCall = vi.fn();
    const executor = createMockExecutor({ onExecute: executorCall });

    const result = await executeXcodeBuildCommand(
      {
        scheme: 'MyScheme',
        derivedDataPath,
      },
      {
        platform: XcodePlatform.iOSSimulator,
        simulatorId: 'SIMULATOR-UDID',
        logPrefix: 'iOS Simulator Build',
      },
      false,
      'build',
      executor,
    );

    expect(result.isError).toBeFalsy();
    expect(executorCall).not.toHaveBeenCalled();
    expect(executeXcodemakeCommandMock).toHaveBeenCalledWith(
      process.cwd(),
      expect.arrayContaining(['-derivedDataPath', derivedDataPath]),
      'iOS Simulator Build',
    );
  });
});
