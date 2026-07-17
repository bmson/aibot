import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { type BrowserEgressProxy, startBrowserEgressProxy } from './egress-proxy.js';
import type { HostResolver } from './network.js';

let proxy: BrowserEgressProxy | undefined;

afterEach(async () => {
  await proxy?.close();
  proxy = undefined;
});

describe('browser egress proxy', () => {
  it('blocks a target whose pinned DNS answer is private', async () => {
    const resolver: HostResolver = async () => [{ address: '169.254.169.254', family: 4 }];
    proxy = await startBrowserEgressProxy({ resolver });
    const endpoint = new URL(proxy.url);

    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = httpRequest(
        {
          host: endpoint.hostname,
          port: Number(endpoint.port),
          method: 'GET',
          path: 'http://rebind.example/latest/meta-data',
        },
        (result) => {
          let body = '';
          result.setEncoding('utf8');
          result.on('data', (chunk) => {
            body += chunk;
          });
          result.on('end', () => resolve({ status: result.statusCode ?? 0, body }));
        },
      );
      request.once('error', reject);
      request.end();
    });

    expect(response.status).toBe(403);
    expect(response.body).toContain('private');
  });
});
