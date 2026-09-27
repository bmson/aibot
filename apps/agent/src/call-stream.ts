import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { isModuleEnabled, loadConfig } from '@assistant/config';
import type { CallBridge, ModuleServices } from '@assistant/modules';
import { WebSocketServer } from 'ws';

export const CALL_STREAM_PATH = '/voice/stream';

/**
 * Twilio opens a bidirectional media stream here when a placed call is
 * answered. The upgrade itself carries no credential; the per-call one-shot
 * token arrives in the stream's first `start` message, and the bridge closes
 * the socket unless it redeems. Every other upgrade is refused.
 */
export function attachCallStream(
  server: Server,
  bridge: CallBridge,
  services: () => ModuleServices,
): void {
  // 20 ms μ-law frames are ~300 bytes of JSON; nothing legitimate is large.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path !== CALL_STREAM_PATH || !isModuleEnabled(loadConfig(), 'calls')) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => bridge.attach(ws, services()));
  });
}
