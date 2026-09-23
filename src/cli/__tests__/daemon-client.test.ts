import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { DaemonClient, DaemonVersionMismatchError } from '../daemon-client.ts';
import { createFrameReader, writeFrame } from '../../daemon/framing.ts';
import { DAEMON_PROTOCOL_VERSION } from '../../daemon/protocol.ts';

async function createSocketPath(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'mobilebuildmcp-client-'));
  return path.join(directory, 'daemon.sock');
}

async function listen(server: net.Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

describe('DaemonClient invokeTool streaming', () => {
  const cleanupPaths: string[] = [];
  const cleanupServers: net.Server[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanupServers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      ),
    );
    await Promise.all(
      cleanupPaths.splice(0).map(async (socketPath) => {
        await rm(path.dirname(socketPath), { recursive: true, force: true });
      }),
    );
  });

  it('preserves protocol version mismatch detection for tool.invoke', async () => {
    const socketPath = await createSocketPath();
    cleanupPaths.push(socketPath);

    const server = net.createServer((socket) => {
      const onData = createFrameReader((message) => {
        const request = message as { id: string; v: number };
        writeFrame(socket, {
          v: DAEMON_PROTOCOL_VERSION,
          id: request.id,
          error: {
            code: 'BAD_REQUEST',
            message: `Unsupported protocol version: ${request.v}`,
          },
        });
      });

      socket.on('data', onData);
    });
    cleanupServers.push(server);
    await listen(server, socketPath);

    const client = new DaemonClient({ socketPath, timeout: 1000 });

    await expect(client.invokeTool('stream_tool', {})).rejects.toBeInstanceOf(
      DaemonVersionMismatchError,
    );
  });

  it('rejects malformed frame sequences that send progress after the terminal result', async () => {
    const socketPath = await createSocketPath();
    cleanupPaths.push(socketPath);

    const server = net.createServer((socket) => {
      const onData = createFrameReader((message) => {
        const request = message as { id: string };
        writeFrame(socket, {
          v: DAEMON_PROTOCOL_VERSION,
          id: request.id,
          result: {
            structuredOutput: {
              schema: 'mobilebuildmcp.output.simulator-list',
              schemaVersion: '1',
              result: {
                kind: 'simulator-list',
                didError: false,
                error: null,
                simulators: [],
              },
            },
          },
        });
        writeFrame(socket, {
          v: DAEMON_PROTOCOL_VERSION,
          id: request.id,
          stream: {
            kind: 'progress',
            event: {
              type: 'status',
              level: 'info',
              message: 'late progress',
            },
          },
        });
      });

      socket.on('data', onData);
    });
    cleanupServers.push(server);
    await listen(server, socketPath);

    const client = new DaemonClient({ socketPath, timeout: 1000 });

    await expect(client.invokeTool('stream_tool', {})).rejects.toThrow(
      'Daemon protocol error: received progress after terminal result',
    );
  });
});
