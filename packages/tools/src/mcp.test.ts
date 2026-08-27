import { createServer } from 'node:http';
import { reloadConfig } from '@assistant/config';
import { encryptMcpBearerToken } from '@assistant/core/mcp-secrets';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkedMcpEndpoint, inspectMcpConnection } from './mcp.js';

const ORIGINAL_MCP_ENC_KEY = process.env.MCP_ENC_KEY;

describe('MCP Streamable HTTP client', () => {
  beforeEach(() => {
    process.env.MCP_ENC_KEY = '11'.repeat(32);
    reloadConfig();
  });

  afterEach(() => {
    if (ORIGINAL_MCP_ENC_KEY === undefined) delete process.env.MCP_ENC_KEY;
    else process.env.MCP_ENC_KEY = ORIGINAL_MCP_ENC_KEY;
    reloadConfig();
  });

  it('discovers a bounded tool list after the initialize handshake', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          {
            jsonrpc: '2.0',
            id: 1,
            result: {
              protocolVersion: '2025-11-25',
              serverInfo: { name: 'Demo tools', version: '2.4.0' },
              instructions: 'Use only for the owner’s projects.',
            },
          },
          { headers: { 'Mcp-Session-Id': 'session-1' } },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(
        Response.json({
          jsonrpc: '2.0',
          id: 2,
          result: {
            tools: [
              {
                name: 'projects.list',
                description: 'List the owner’s active projects.',
                inputSchema: { type: 'object', properties: {} },
              },
            ],
          },
        }),
      );

    const discovery = await inspectMcpConnection('http://localhost:3010/mcp', { fetchImpl });

    expect(discovery).toMatchObject({
      status: 'ready',
      serverName: 'Demo tools',
      serverVersion: '2.4.0',
      tools: [{ name: 'projects.list' }],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[1]?.[1]?.headers).toMatchObject({ 'Mcp-Session-Id': 'session-1' });
  });

  it('keeps an authorization-required server visible instead of treating it as ready', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 }));
    await expect(
      inspectMcpConnection('http://localhost:3010/mcp', { fetchImpl }),
    ).resolves.toMatchObject({
      status: 'authorization_required',
      tools: [],
    });
  });

  it('stops reading a chunked response after the byte limit', async () => {
    const oversizedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(200_000));
        controller.enqueue(new Uint8Array(200_000));
        controller.close();
      },
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'Large MCP' } } }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(
        new Response(oversizedBody, { headers: { 'content-type': 'application/json' } }),
      );

    await expect(
      inspectMcpConnection('http://localhost:3010/mcp', { fetchImpl }),
    ).resolves.toMatchObject({ status: 'error', error: 'MCP response is too large.' });
  });

  it('sends an encrypted bearer credential on discovery requests without exposing it', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          { jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'Private MCP' } } },
          { headers: { 'Mcp-Session-Id': 'session-1' } },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ jsonrpc: '2.0', id: 2, result: { tools: [] } }));

    const discovery = await inspectMcpConnection('http://localhost:3010/mcp', {
      fetchImpl,
      bearerTokenEncrypted: encryptMcpBearerToken('secret-token'),
    });

    expect(discovery.status).toBe('ready');
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer secret-token',
    });
    expect(JSON.stringify(discovery)).not.toContain('secret-token');
  });

  it('rejects non-local HTTP before it can become an outbound request', async () => {
    await expect(checkedMcpEndpoint('http://example.com/mcp')).rejects.toThrow(/public HTTPS/);
  });

  it.each([
    'https://[::ffff:127.0.0.1]/mcp',
    'https://[::ffff:169.254.169.254]/mcp',
    'https://[::ffff:172.16.0.1]/mcp',
    'https://[4000::1]/mcp',
  ])('rejects private or non-public IPv6 endpoints: %s', async (endpoint) => {
    await expect(checkedMcpEndpoint(endpoint)).rejects.toThrow(/private network/);
  });

  // The rejection cases above all passed while every public IPv4 endpoint was
  // also being rejected: one BlockList held both families, and `::ffff:0:0/96`
  // — the IPv4-mapped range — matches any plain IPv4 address, so a single IPv6
  // rule blocked all of IPv4. Nothing asserted the guard still lets normal
  // traffic through, so the whole feature was unusable in production.
  it.each([
    'https://140.82.113.22/mcp/',
    'https://8.8.8.8/mcp',
    'https://[2606:4700:4700::1111]/mcp',
  ])('accepts a public endpoint: %s', async (endpoint) => {
    await expect(checkedMcpEndpoint(endpoint)).resolves.toBeInstanceOf(URL);
  });

  it.each([
    'https://10.0.0.1/mcp',
    'https://192.168.1.10/mcp',
    'https://172.16.0.1/mcp',
    'https://169.254.169.254/mcp',
    'https://100.64.0.1/mcp',
    // Loopback is deliberately absent: it is allowed in local development,
    // which is the mode this suite runs in, and the pinned-loopback test below
    // covers it. In production the same address falls to the check above.
  ])('still rejects private IPv4 endpoints: %s', async (endpoint) => {
    await expect(checkedMcpEndpoint(endpoint)).rejects.toThrow(/private network/);
  });

  it('pins and reuses a validated loopback connection in local development', async () => {
    let requests = 0;
    const server = createServer((request, response) => {
      requests += 1;
      expect(request.headers.authorization).toBe('Bearer local-secret');
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        const method = (JSON.parse(body) as { method?: string }).method;
        if (method === 'notifications/initialized') {
          response.writeHead(202).end();
          return;
        }
        const result =
          method === 'initialize'
            ? { serverInfo: { name: 'Pinned local MCP' } }
            : { tools: [{ name: 'status.read', inputSchema: { type: 'object' } }] };
        response
          .writeHead(200, {
            'content-type': 'application/json',
            'mcp-session-id': 'local-session',
          })
          .end(JSON.stringify({ jsonrpc: '2.0', id: method === 'initialize' ? 1 : 2, result }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server has no TCP address');

    try {
      const discovery = await inspectMcpConnection(`http://127.0.0.1:${address.port}/mcp`, {
        bearerTokenEncrypted: encryptMcpBearerToken('local-secret'),
      });
      expect(discovery).toMatchObject({
        status: 'ready',
        serverName: 'Pinned local MCP',
        tools: [{ name: 'status.read' }],
      });
      expect(requests).toBe(3);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
