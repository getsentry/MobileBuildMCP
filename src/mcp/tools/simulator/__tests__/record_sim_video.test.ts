import { describe, it, expect, vi, afterEach } from 'vitest';

import { schema, handler, record_sim_videoLogic } from '../record_sim_video.ts';
import { createMockFileSystemExecutor } from '../../../../test-utils/mock-executors.ts';
import { createMockToolHandlerContext, callHandler } from '../../../../test-utils/test-helpers.ts';

const DUMMY_EXECUTOR: any = (async () => ({ success: true })) as any; // CommandExecutor stub
const VALID_SIM_ID = '00000000-0000-0000-0000-000000000000';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('record_sim_video tool - validation', () => {
  it('errors when start and stop are both true (mutually exclusive)', async () => {
    const res = await callHandler(handler, {
      simulatorId: VALID_SIM_ID,
      start: true,
      stop: true,
    } as any);

    expect(res.isError).toBe(true);
    const text = (res.content?.[0] as any)?.text ?? '';
    expect(text.toLowerCase()).toContain('mutually exclusive');
  });

  it('errors when stop=true but outputFile is missing', async () => {
    const res = await callHandler(handler, {
      simulatorId: VALID_SIM_ID,
      stop: true,
    } as any);

    expect(res.isError).toBe(true);
    const text = (res.content?.[0] as any)?.text ?? '';
    expect(text.toLowerCase()).toContain('outputfile is required');
  });
});

describe('record_sim_video logic - start behavior', () => {
  it('starts with default fps (30) and warns when outputFile is provided on start (ignored)', async () => {
    const video: any = {
      checkMp4Finalized: async () => ({ finalized: true }),
      startSimulatorVideoCapture: async () => ({
        started: true,
        sessionId: 'sess-123',
      }),
      stopSimulatorVideoCapture: async () => ({
        stopped: false,
      }),
    };

    const axe = {
      areAxeToolsAvailable: () => true,
      isAxeAtLeastVersion: async () => true,
    };

    const fs = createMockFileSystemExecutor();

    const { result, run } = createMockToolHandlerContext();
    await run(() =>
      record_sim_videoLogic(
        {
          simulatorId: VALID_SIM_ID,
          start: true,
          outputFile: '/tmp/ignored.mp4',
        } as any,
        DUMMY_EXECUTOR,
        axe,
        video,
        fs,
      ),
    );

    expect(result.isError()).toBe(false);
    const texts = result.text();

    expect(texts).toContain('30');
    expect(texts).toContain('Video recording started');
    expect(texts).toContain('sess-123');
    expect(texts.toLowerCase()).not.toContain('outputfile is ignored');

    expect(result.nextStepParams).toBeDefined();
    expect(result.nextStepParams?.record_sim_video).toBeDefined();
    expect(result.nextStepParams?.record_sim_video).toHaveProperty('stop', true);
    expect(result.nextStepParams?.record_sim_video).toHaveProperty('outputFile');
  });

  it('keeps start failure summary short and preserves diagnostics', async () => {
    const video: any = {
      checkMp4Finalized: async () => ({ finalized: true }),
      startSimulatorVideoCapture: async () => ({
        started: false,
        error: 'AXe stderr: permission denied',
      }),
      stopSimulatorVideoCapture: async () => ({
        stopped: false,
      }),
    };

    const axe = {
      areAxeToolsAvailable: () => true,
      isAxeAtLeastVersion: async () => true,
    };

    const { result, run } = createMockToolHandlerContext();
    await run(() =>
      record_sim_videoLogic(
        {
          simulatorId: VALID_SIM_ID,
          start: true,
        } as any,
        DUMMY_EXECUTOR,
        axe,
        video,
        createMockFileSystemExecutor(),
      ),
    );

    expect(result.isError()).toBe(true);
    const text = result.text();
    expect(text).toContain('Failed to start video recording.');
    expect(text).toContain('AXe stderr: permission denied');
  });
});

describe('record_sim_video logic - end-to-end stop with rename', () => {
  it('stops, parses stdout path, and renames to outputFile', async () => {
    const video: any = {
      checkMp4Finalized: async () => ({ finalized: true }),
      startSimulatorVideoCapture: async () => ({
        started: true,
        sessionId: 'sess-abc',
      }),
      stopSimulatorVideoCapture: async () => ({
        stopped: true,
        parsedPath: '/tmp/recorded.mp4',
        stdout: 'Saved to /tmp/recorded.mp4',
      }),
    };

    const fs = createMockFileSystemExecutor();

    const axe = {
      areAxeToolsAvailable: () => true,
      isAxeAtLeastVersion: async () => true,
    };

    const { result: startResult, run: runStart } = createMockToolHandlerContext();
    await runStart(() =>
      record_sim_videoLogic(
        {
          simulatorId: VALID_SIM_ID,
          start: true,
        } as any,
        DUMMY_EXECUTOR,
        axe,
        video,
        fs,
      ),
    );
    expect(startResult.isError()).toBe(false);

    const outputFile = '/var/videos/final.mp4';
    const { result: stopResult, run: runStop } = createMockToolHandlerContext();
    await runStop(() =>
      record_sim_videoLogic(
        {
          simulatorId: VALID_SIM_ID,
          stop: true,
          outputFile,
        } as any,
        DUMMY_EXECUTOR,
        axe,
        video,
        fs,
      ),
    );

    expect(stopResult.isError()).toBe(false);
    const texts = stopResult.text();
    expect(texts).toContain('Video recording stopped');
    expect(texts).toContain(`Output File: ${outputFile}`);
  });

  it('keeps missing parsed path summary short and preserves raw AXe output', async () => {
    const video: any = {
      checkMp4Finalized: async () => ({ finalized: true }),
      startSimulatorVideoCapture: async () => ({
        started: true,
        sessionId: 'sess-abc',
      }),
      stopSimulatorVideoCapture: async () => ({
        stopped: true,
        stdout: 'Saved recording but did not include a file path',
      }),
    };

    const axe = {
      areAxeToolsAvailable: () => true,
      isAxeAtLeastVersion: async () => true,
    };

    const { result, run } = createMockToolHandlerContext();
    await run(() =>
      record_sim_videoLogic(
        {
          simulatorId: VALID_SIM_ID,
          stop: true,
          outputFile: '/var/videos/final.mp4',
        } as any,
        DUMMY_EXECUTOR,
        axe,
        video,
        createMockFileSystemExecutor(),
      ),
    );

    expect(result.isError()).toBe(true);
    const text = result.text();
    expect(text).toContain('Recording stopped but could not determine the recorded file path.');
    expect(text).toContain('Raw output: Saved recording but did not include a file path');
  });
});

describe('record_sim_video logic - version gate', () => {
  it('errors when AXe version is below 1.1.0', async () => {
    const axe = {
      areAxeToolsAvailable: () => true,
      isAxeAtLeastVersion: async () => false,
    };

    const video: any = {
      checkMp4Finalized: async () => ({ finalized: true }),
      startSimulatorVideoCapture: async () => ({
        started: true,
        sessionId: 'sess-xyz',
      }),
      stopSimulatorVideoCapture: async () => ({
        stopped: true,
      }),
    };

    const fs = createMockFileSystemExecutor();

    const { result, run } = createMockToolHandlerContext();
    await run(() =>
      record_sim_videoLogic(
        {
          simulatorId: VALID_SIM_ID,
          start: true,
        } as any,
        DUMMY_EXECUTOR,
        axe,
        video,
        fs,
      ),
    );

    expect(result.isError()).toBe(true);
    const text = result.text();
    expect(text).toContain('AXe v1.1.0');
  });
});

describe('record_sim_video logic - incomplete recordings', () => {
  const axe = {
    areAxeToolsAvailable: () => true,
    isAxeAtLeastVersion: async () => true,
  };

  async function stopWith(stopResult: object, finalization: object) {
    const copied: string[] = [];
    const fs = createMockFileSystemExecutor({
      cp: async (source: string) => {
        copied.push(source);
      },
    });
    const video: any = {
      startSimulatorVideoCapture: async () => ({ started: true, sessionId: 's' }),
      stopSimulatorVideoCapture: async () => ({ stopped: true, ...stopResult }),
      checkMp4Finalized: async () => finalization,
    };
    const { result, run } = createMockToolHandlerContext();
    await run(() =>
      record_sim_videoLogic(
        { simulatorId: VALID_SIM_ID, stop: true, outputFile: '/var/videos/final.mp4' } as any,
        DUMMY_EXECUTOR,
        axe,
        video,
        fs,
      ),
    );
    return { result, copied };
  }

  it('fails without copying when the recording has no moov box', async () => {
    const { result, copied } = await stopWith(
      { parsedPath: '/tmp/recorded.mp4', stdout: 'Saved /tmp/recorded.mp4', exitCode: 0 },
      { finalized: false, reason: 'no moov box found' },
    );
    expect(result.isError()).toBe(true);
    expect(copied).toEqual([]);
    const text = result.text();
    expect(text).toContain('incomplete');
    expect(text).toContain('no moov box found');
    expect(text).toContain('Saved /tmp/recorded.mp4');
  });

  it('fails when AXe had to be force-killed even if the file looks finalized', async () => {
    const { result, copied } = await stopWith(
      { parsedPath: '/tmp/recorded.mp4', stdout: 'Saved /tmp/recorded.mp4', forcedKill: true },
      { finalized: true },
    );
    expect(result.isError()).toBe(true);
    expect(copied).toEqual([]);
    expect(result.text()).toContain('force-killed');
  });

  it('copies a finalized recording', async () => {
    const { result, copied } = await stopWith(
      { parsedPath: '/tmp/recorded.mp4', stdout: 'Saved /tmp/recorded.mp4', exitCode: 0 },
      { finalized: true },
    );
    expect(result.isError()).toBe(false);
    expect(copied).toEqual(['/tmp/recorded.mp4']);
  });
});
