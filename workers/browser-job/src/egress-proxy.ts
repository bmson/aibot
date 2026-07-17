import { createServer, request as httpRequest, type OutgoingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as netConnect } from 'node:net';
import { type HostResolver, resolvePublicHost } from './network.js';

const MAX_RESOURCE_BYTES = 16 * 1024 * 1024;

export interface BrowserEgressProxy {
  url: string;
  close(): Promise<void>;
}

function allowedPort(protocol: string, port: string): number {
  const value = Number(port || (protocol === 'https:' ? 443 : 80));
  const expected = protocol === 'https:' ? 443 : 80;
  if (value !== expected) throw new Error(`browser egress port ${value} is blocked`);
  return value;
}

/**
 * Loopback-only forward proxy. It resolves and validates each destination,
 * then connects to that exact IP. Chromium never resolves or connects to a
 * target directly, closing the DNS-rebinding gap between policy and socket.
 */
export async function startBrowserEgressProxy(
  options: { resolver?: HostResolver } = {},
): Promise<BrowserEgressProxy> {
  const server = createServer(async (request, response) => {
    try {
      const target = new URL(request.url ?? '');
      if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        throw new Error('proxy accepts http(s) only');
      }
      if (target.username || target.password) throw new Error('URL credentials are blocked');
      const port = allowedPort(target.protocol, target.port);
      const [pinned] = await resolvePublicHost(target.hostname, options.resolver);
      if (!pinned) throw new Error('destination did not resolve');

      const headers: OutgoingHttpHeaders = { ...request.headers, host: target.host };
      delete headers.connection;
      delete headers['proxy-connection'];
      const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
      const upstream = send(
        target,
        {
          method: request.method,
          headers,
          agent: false,
          family: pinned.family,
          lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family),
        },
        (upstreamResponse) => {
          response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
          let bytes = 0;
          upstreamResponse.on('data', (chunk: Buffer) => {
            bytes += chunk.byteLength;
            if (bytes > MAX_RESOURCE_BYTES) {
              upstreamResponse.destroy(new Error('browser resource exceeds byte limit'));
              response.destroy();
            }
          });
          upstreamResponse.pipe(response);
        },
      );
      upstream.setTimeout(30_000, () => upstream.destroy(new Error('browser proxy timed out')));
      upstream.once('error', (error) => {
        if (!response.headersSent) response.writeHead(502);
        response.end(String(error).slice(0, 300));
      });
      request.pipe(upstream);
      void port; // validated above; URL/request selects the same standard port
    } catch (error) {
      response.writeHead(403, { 'content-type': 'text/plain' });
      response.end(`blocked by browser egress policy: ${String(error).slice(0, 300)}`);
    }
  });

  server.on('connect', async (request, clientSocket, head) => {
    try {
      const authority = new URL(`https://${request.url ?? ''}`);
      const port = allowedPort('https:', authority.port);
      const [pinned] = await resolvePublicHost(authority.hostname, options.resolver);
      if (!pinned) throw new Error('destination did not resolve');
      const upstream = netConnect({ host: pinned.address, port, family: pinned.family });
      upstream.setTimeout(30_000, () => upstream.destroy(new Error('browser tunnel timed out')));
      upstream.once('connect', () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.once('error', () => clientSocket.destroy());
      clientSocket.once('error', () => upstream.destroy());
    } catch (error) {
      clientSocket.write(
        `HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${String(error).slice(0, 200)}`,
      );
      clientSocket.destroy();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('browser proxy failed to bind');

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
