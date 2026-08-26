import { describe, expect, it, vi } from 'vitest';
import { encryptMcpBearerToken } from '@assistant/core/mcp-secrets';
import { checkedMcpEndpoint, inspectMcpConnection } from './mcp.js';

describe('MCP Streamable HTTP client', () => {
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

  it('sends an encrypted bearer credential on discovery requests without exposing it', async () => {
    process.env.MCP_ENC_KEY = 'test-mcp-encryption-key';
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          { jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'Private MCP' } } },
          { headers: { 'Mcp-Session-Id': 'session-1' } },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(
        Response.json({ jsonrpc: '2.0', id: 2, result: { tools: [] } }),
      );

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
});
