import { existsSync, mkdtempSync, readFileSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../server/server-state.ts', () => ({
  getServer: vi.fn(),
}));

vi.mock('../../../../integrations/xcode-tools-bridge/core.ts', () => ({
  buildXcodeToolsBridgeStatus: vi.fn(),
  classifyBridgeError: vi.fn(() => 'XCODE_MCP_UNAVAILABLE'),
  getMcpBridgeAvailability: vi.fn(),
  serializeBridgeTool: vi.fn((tool) => tool),
}));

const clientMocks = {
  connectOnce: vi.fn(),
  listTools: vi.fn(),
  callTool: vi.fn(),
  disconnect: vi.fn(),
  getStatus: vi.fn(),
};

vi.mock('../../../../integrations/xcode-tools-bridge/client.ts', () => ({
  XcodeToolsBridgeClient: class {
    connectOnce = clientMocks.connectOnce;
    listTools = clientMocks.listTools;
    callTool = clientMocks.callTool;
    disconnect = clientMocks.disconnect;
    getStatus = clientMocks.getStatus;
  },
}));

import {
  handler as statusHandler,
  xcodeToolsBridgeStatusLogic,
} from '../xcode_tools_bridge_status.ts';
import { handler as syncHandler, xcodeToolsBridgeSyncLogic } from '../xcode_tools_bridge_sync.ts';
import {
  handler as disconnectHandler,
  xcodeToolsBridgeDisconnectLogic,
} from '../xcode_tools_bridge_disconnect.ts';
import { handler as listHandler, xcodeIdeListToolsLogic } from '../xcode_ide_list_tools.ts';
import { handler as ideCallToolHandler, xcodeIdeCallToolLogic } from '../xcode_ide_call_tool.ts';
import { getServer } from '../../../../server/server-state.ts';
import { shutdownXcodeToolsBridge } from '../../../../integrations/xcode-tools-bridge/index.ts';
import {
  buildXcodeToolsBridgeStatus,
  getMcpBridgeAvailability,
} from '../../../../integrations/xcode-tools-bridge/core.ts';
import { allText, runToolLogic, callHandler } from '../../../../test-utils/test-helpers.ts';
import { setMobileBuildMCPAppDirOverrideForTests } from '../../../../utils/log-paths.ts';
import { setRuntimeInstanceForTests } from '../../../../utils/runtime-instance.ts';

describe('xcode-ide bridge tools (standalone fallback)', () => {
  let tempAppDir: string;

  beforeEach(async () => {
    tempAppDir = mkdtempSync(join(tmpdir(), 'mobilebuildmcp-xcode-ide-test-'));
    setMobileBuildMCPAppDirOverrideForTests(tempAppDir);
    setRuntimeInstanceForTests({
      instanceId: 'test-instance',
      pid: 1234,
      workspaceKey: 'workspace-a',
    });

    await shutdownXcodeToolsBridge();

    vi.mocked(getServer).mockReset();
    vi.mocked(buildXcodeToolsBridgeStatus).mockReset();
    vi.mocked(getMcpBridgeAvailability).mockReset();
    clientMocks.connectOnce.mockReset();
    clientMocks.listTools.mockReset();
    clientMocks.disconnect.mockReset();
    clientMocks.getStatus.mockReset();
    clientMocks.callTool.mockReset();

    vi.mocked(getServer).mockReturnValue(undefined);
    clientMocks.getStatus.mockReturnValue({
      connected: false,
      bridgePid: null,
      lastError: null,
    });
    vi.mocked(buildXcodeToolsBridgeStatus).mockResolvedValue({
      workflowEnabled: true,
      bridgeAvailable: true,
      bridgePath: '/usr/bin/mcpbridge',
      xcodeRunning: true,
      connected: false,
      bridgePid: null,
      proxiedToolCount: 0,
      lastError: null,
      xcodePid: null,
      xcodeSessionId: null,
    });
    vi.mocked(getMcpBridgeAvailability).mockResolvedValue({
      available: true,
      path: '/usr/bin/mcpbridge',
    });
    clientMocks.listTools.mockResolvedValue([{ name: 'toolA' }, { name: 'toolB' }]);
    clientMocks.connectOnce.mockResolvedValue(undefined);
    clientMocks.callTool.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    });
    clientMocks.disconnect.mockResolvedValue(undefined);
  });

  afterEach(() => {
    setRuntimeInstanceForTests(null);
    setMobileBuildMCPAppDirOverrideForTests(null);
    rmSync(tempAppDir, { recursive: true, force: true });
  });

  it('status handler returns bridge status without MCP server instance', async () => {
    const result = await callHandler(statusHandler, {});
    const text = allText(result);
    expect(text).toContain('Bridge Status');
    expect(text).toContain('"bridgeAvailable": true');
    expect(buildXcodeToolsBridgeStatus).toHaveBeenCalledOnce();
  });

  it('sync handler uses direct bridge client when MCP server is not initialized', async () => {
    const result = await callHandler(syncHandler, {});
    const text = allText(result);
    expect(text).toContain('Bridge Sync');
    expect(text).toContain('"total": 2');
    expect(clientMocks.connectOnce).toHaveBeenCalledOnce();
    expect(clientMocks.listTools).toHaveBeenCalledOnce();
    expect(clientMocks.disconnect).not.toHaveBeenCalled();
  });

  it('disconnect handler succeeds without MCP server instance', async () => {
    const result = await callHandler(disconnectHandler, {});
    const text = allText(result);
    expect(text).toContain('Bridge Disconnect');
    expect(text).toContain('"connected": false');
    expect(clientMocks.disconnect).toHaveBeenCalledOnce();
  });

  it('list handler returns bridge tools without MCP server instance', async () => {
    const result = await callHandler(listHandler, { refresh: true });
    const text = allText(result);
    expect(text).toContain('Xcode IDE List Tools');
    expect(text).toContain('Found 2 tool(s). Raw response saved to artifact.');
    expect(text).toContain('Raw Response JSON');
    expect(text).not.toContain('toolA');
    expect(text).not.toContain('toolB');
    expect(text).not.toContain('"toolCount": 2');
    expect(clientMocks.listTools).toHaveBeenCalledOnce();
    expect(clientMocks.disconnect).not.toHaveBeenCalled();
  });

  it('list handler can return cached bridge tools without reconnecting', async () => {
    const refreshed = await callHandler(listHandler, { refresh: true });
    const cached = await callHandler(listHandler, { refresh: false });

    expect(allText(refreshed)).toContain('Found 2 tool(s). Raw response saved to artifact.');
    expect(allText(cached)).toContain('Found 2 tool(s). Raw response saved to artifact.');
    expect(clientMocks.connectOnce).toHaveBeenCalledOnce();
    expect(clientMocks.listTools).toHaveBeenCalledOnce();
    expect(clientMocks.disconnect).not.toHaveBeenCalled();
  });

  it('list handler defaults to refresh only when cache is empty', async () => {
    const initial = await callHandler(listHandler, {});
    const cached = await callHandler(listHandler, {});
    const forced = await callHandler(listHandler, { refresh: true });

    expect(allText(initial)).toContain('Found 2 tool(s). Raw response saved to artifact.');
    expect(allText(cached)).toContain('Found 2 tool(s). Raw response saved to artifact.');
    expect(allText(forced)).toContain('Found 2 tool(s). Raw response saved to artifact.');
    expect(clientMocks.connectOnce).toHaveBeenCalledTimes(2);
    expect(clientMocks.listTools).toHaveBeenCalledTimes(2);
    expect(clientMocks.disconnect).not.toHaveBeenCalled();
  });

  it('call handler forwards remote tool calls and writes a raw response artifact', async () => {
    const result = await callHandler(ideCallToolHandler, {
      remoteTool: 'toolA',
      arguments: '{"foo":"bar"}',
    });
    const text = allText(result);
    const artifactDir = join(
      tempAppDir,
      'workspaces',
      'workspace-a',
      'state',
      'xcode-ide',
      'call-tool',
      'ownerpid1234_test-instance',
    );
    const artifactPath = join(artifactDir, readdirSync(artifactDir)[0] ?? 'missing');

    expect(result.isError).toBeFalsy();
    expect(text).toContain('Xcode IDE Call Tool');
    expect(text).toContain('Raw Response JSON');
    expect(text).toContain(artifactPath);
    expect(text).not.toContain('Relayed Content');
    expect(text).not.toContain('Structured Content');
    expect(existsSync(artifactPath)).toBe(true);
    expect(JSON.parse(readFileSync(artifactPath, 'utf8'))).toMatchObject({
      remoteTool: 'toolA',
      arguments: { foo: 'bar' },
      response: {
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      },
    });
    expect(clientMocks.callTool).toHaveBeenCalledWith('toolA', { foo: 'bar' }, {});
    expect(clientMocks.disconnect).not.toHaveBeenCalled();
  });

  it('call handler preserves already-decoded CLI arguments', async () => {
    const result = await callHandler(ideCallToolHandler, {
      remoteTool: 'toolA',
      arguments: { foo: 'bar' },
    });

    expect(result.isError).toBeFalsy();
    expect(clientMocks.callTool).toHaveBeenCalledWith('toolA', { foo: 'bar' }, {});
  });

  it('reports invalid MCP JSON at the arguments field', async () => {
    const result = await callHandler(ideCallToolHandler, {
      remoteTool: 'toolA',
      arguments: 'not-json',
    });

    expect(result.isError).toBe(true);
    expect(allText(result)).toContain('arguments: Invalid input');
    expect(allText(result)).not.toContain('arguments.arguments');
  });

  it('call handler hard-fails when the raw response artifact cannot be written', async () => {
    const blockingAppDir = join(tempAppDir, 'app-dir-file');
    writeFileSync(blockingAppDir, 'not a directory');
    setMobileBuildMCPAppDirOverrideForTests(blockingAppDir);
    clientMocks.callTool.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'large inline payload' }],
      structuredContent: { raw: 'structured payload' },
      isError: false,
    });

    const result = await callHandler(ideCallToolHandler, {
      remoteTool: 'toolA',
      arguments: '{"foo":"bar"}',
    });
    const text = allText(result);

    expect(result.isError).toBe(true);
    expect(text).toContain('Failed to write Xcode IDE bridge response artifact');
    expect(text).not.toContain('Raw Response JSON');
    expect(text).not.toContain('Relayed Content');
    expect(text).not.toContain('Structured Content');
    expect(text).not.toContain('large inline payload');
    expect(text).not.toContain('structured payload');
    expect(clientMocks.callTool).toHaveBeenCalledWith('toolA', { foo: 'bar' }, {});
  });

  it('logic functions do not emit progress events', async () => {
    const status = await runToolLogic(() => xcodeToolsBridgeStatusLogic({}));
    expect(status.result.events).toHaveLength(0);

    const sync = await runToolLogic(() => xcodeToolsBridgeSyncLogic({}));
    expect(sync.result.events).toHaveLength(0);

    const disconnect = await runToolLogic(() => xcodeToolsBridgeDisconnectLogic({}));
    expect(disconnect.result.events).toHaveLength(0);

    const list = await runToolLogic(() => xcodeIdeListToolsLogic({ refresh: true }));
    expect(list.result.events).toHaveLength(0);

    const call = await runToolLogic(() =>
      xcodeIdeCallToolLogic({ remoteTool: 'toolA', arguments: { foo: 'bar' } }),
    );
    expect(call.result.events).toHaveLength(0);
  });
});
