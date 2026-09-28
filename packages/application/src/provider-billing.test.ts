import { describe, expect, it, vi } from 'vitest';
import type { ModelProviderPorts } from './model-providers.js';
import {
  type BillingPorts,
  getProviderBilling,
  googleBillingQuery,
  type ProviderBilling,
  readGoogleBilling,
  readOpenRouterBilling,
} from './provider-billing.js';

const now = new Date('2026-09-27T12:00:00Z');
const base: ProviderBilling = {
  id: 'google-cloud',
  label: 'Google Cloud',
  period: '2026-09',
  scope: 'Project: assistant',
  source: 'test',
  status: 'unavailable',
  message: '',
  fetchedAt: null,
  latestExportAt: null,
  latestUsageAt: null,
  lines: [],
};
const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
function ports(): BillingPorts {
  const cache = new Map<string, unknown>();
  return {
    config: {
      GCP_PROJECT: 'assistant',
      GCP_BILLING_EXPORT_TABLE: 'billing.data.gcp_billing_export_v1_test',
      GCP_BILLING_QUERY_PROJECT: '',
      GCP_BILLING_LOCATION: 'US',
      GCP_BILLING_SCOPE: 'project',
      GCP_BILLING_MAX_BYTES: 1_000_000_000,
    },
    models: {
      config: {
        LLM_PROVIDER: 'vertex',
        OPENROUTER_API_KEY: '',
        VERTEX_PROJECT: '',
        VERTEX_LOCATION: 'global',
      },
      connections: { list: vi.fn(async () => []) },
      open: (key: string) => key,
    } as unknown as ModelProviderPorts,
    cache: {
      cacheGet: async (key) => (cache.has(key) ? { result: cache.get(key) } : null),
      cachePut: async (input) => {
        cache.set(input.cacheKey, input.result);
      },
    },
    now: () => now,
    accessToken: async () => 'test-google-token',
  };
}
function row(currency = 'USD', cost = '10', credits = '-3', net = '7') {
  return {
    f: [
      currency,
      'assistant',
      'Cloud Firestore',
      'Document reads',
      'regular',
      cost,
      credits,
      net,
      '2026-09-27T08:00:00Z',
      '2026-09-26T23:00:00Z',
    ].map((v) => ({ v })),
  };
}

describe('provider billing without guessed totals', () => {
  it('uses real credits, adjustments and currencies, and reads every page', async () => {
    const p = ports();
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          jobComplete: false,
          jobReference: { projectId: 'billing', jobId: 'query', location: 'US' },
        }),
      )
      .mockResolvedValueOnce(response({ jobComplete: true, rows: [row()], pageToken: 'next' }))
      .mockResolvedValueOnce(response({ jobComplete: true, rows: [row('EUR', '-2', '0', '-2')] }));
    p.fetch = request;
    const report = await readGoogleBilling(p, base, now);
    expect(report.lines.map((line) => [line.currency, line.net])).toEqual([
      ['USD', 7],
      ['EUR', -2],
    ]);
    expect(report.lines[0]?.credits).toBe(-3);
    expect(report.latestExportAt).toBe('2026-09-27T08:00:00.000Z');
    expect(request.mock.calls[2]?.[0]).toContain('pageToken=next');
    const body = JSON.parse(request.mock.calls[0]?.[1].body);
    expect(body.maximumBytesBilled).toBe('1000000000');
    expect(body.query).toContain('project.id = @project');
    expect(
      body.queryParameters.find((parameter: { name: string }) => parameter.name === 'project')
        .parameterValue.value,
    ).toBe('assistant');
  });

  it('does not report an empty export as zero spend', async () => {
    const p = ports();
    p.fetch = vi.fn(async () => response({ jobComplete: true }));
    const report = await readGoogleBilling(p, base, now);
    expect(report.status).toBe('unavailable');
    expect(report.lines).toEqual([]);
  });

  it('rejects unsafe identifiers and requires an explicit project scope', () => {
    const config = ports().config;
    expect(() =>
      googleBillingQuery({ ...config, GCP_BILLING_EXPORT_TABLE: 'p.d.t` UNION SELECT 1' }, now),
    ).toThrow();
    expect(() => googleBillingQuery({ ...config, GCP_PROJECT: '' }, now)).toThrow();
    expect(
      googleBillingQuery({ ...config, GCP_BILLING_SCOPE: 'billing_account' }, now).query,
    ).not.toContain('project.id = @project');
  });

  it('rejects missing money rather than converting null to zero', async () => {
    const p = ports();
    const invalid = row();
    invalid.f[5] = { v: '' };
    p.fetch = vi.fn(async () => response({ jobComplete: true, rows: [invalid] }));
    await expect(readGoogleBilling(p, base, now)).rejects.toThrow('Invalid billing amount');
  });

  it('rejects an unfinished or failed query without publishing partial spend', async () => {
    const p = ports();
    p.fetch = vi.fn(async () =>
      response({ jobComplete: false, jobReference: { projectId: 'billing', jobId: 'slow' } }),
    );
    await expect(readGoogleBilling(p, base, now)).rejects.toThrow('incomplete');
    p.fetch = vi.fn(async () => response({ jobComplete: true, rows: [row()], errors: [{}] }));
    await expect(readGoogleBilling(p, base, now)).rejects.toThrow('failed');
  });

  it('uses key-reported OpenRouter spend and does not add BYOK upstream costs', async () => {
    const report = await readOpenRouterBilling(
      vi.fn(async () => response({ data: { usage_monthly: 12, byok_usage_monthly: 100 } })),
      'secret',
      base,
      now,
    );
    expect(report.lines[0]?.net).toBe(12);
    expect(report.message).toContain('not added here');
    const zero = await readOpenRouterBilling(
      vi.fn(async () => response({ data: { usage_monthly: 0 } })),
      'secret',
      base,
      now,
    );
    expect(zero.lines[0]?.net).toBe(0);
    await expect(
      readOpenRouterBilling(
        vi.fn(async () => response({ data: {} })),
        'secret',
        base,
        now,
      ),
    ).rejects.toThrow();
  });

  it('caches successful snapshots and preserves stale spend after failure without leaking errors', async () => {
    const p = ports();
    const request = vi.fn(async () => response({ jobComplete: true, rows: [row()] }));
    p.fetch = request;
    expect((await getProviderBilling(p))[0]?.status).toBe('reported');
    await getProviderBilling(p);
    expect(request).toHaveBeenCalledTimes(1);
    p.now = () => new Date(now.getTime() + 3_600_001);
    request.mockRejectedValue(new Error('Authorization: secret-token'));
    const failed = await getProviderBilling(p);
    expect(failed[0]?.status).toBe('stale');
    expect(failed[0]?.lines[0]?.net).toBe(7);
    expect(failed[0]?.fetchedAt).toBe(now.toISOString());
    expect(JSON.stringify(failed)).not.toContain('secret-token');
    await getProviderBilling(p);
    expect(request).toHaveBeenCalledTimes(2);
    p.now = () => new Date('2026-10-01T00:00:00Z');
    const nextMonth = await getProviderBilling(p);
    expect(nextMonth[0]?.status).toBe('unavailable');
    expect(nextMonth[0]?.lines).toEqual([]);
  });

  it('isolates billing scopes and surfaces newly connected providers without invented prices', async () => {
    const p = ports();
    p.config.GCP_BILLING_EXPORT_TABLE = '';
    vi.mocked(p.models.connections.list).mockResolvedValue([
      {
        id: 'my-gateway',
        kind: 'openai_compatible',
        label: 'My models',
        apiKeyEncrypted: null,
        baseUrl: 'https://models.example.test/v1',
        enabled: true,
        vertexLocation: null,
        vertexProject: null,
        lastTestedAt: null,
        lastError: null,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    const reports = await getProviderBilling(p);
    expect(reports.map((report) => report.status)).toEqual(['not_configured', 'unsupported']);
    expect(reports[1]?.lines).toEqual([]);
  });
});

it('keeps billing cache failures from taking down the ledger or triggering uncached cloud queries', async () => {
  const p = ports();
  p.cache.cacheGet = vi.fn(async () => {
    throw new Error('cache down');
  });
  p.fetch = vi.fn();
  const report = (await getProviderBilling(p))[0];
  expect(report?.status).toBe('unavailable');
  expect(p.fetch).not.toHaveBeenCalled();
});

it('reports model connection failures without hiding Google Cloud coverage', async () => {
  const p = ports();
  vi.mocked(p.models.connections.list).mockRejectedValue(
    new Error('credentials in error should not leak'),
  );
  p.fetch = vi.fn(async () => response({ jobComplete: true, rows: [row()] }));
  const reports = await getProviderBilling(p);
  expect(reports[0]?.status).toBe('reported');
  expect(reports[1]?.status).toBe('unavailable');
  expect(JSON.stringify(reports)).not.toContain('credentials in error');
});

it('flags a Vertex project outside the selected Google Cloud scope', async () => {
  const p = ports();
  p.config.GCP_BILLING_EXPORT_TABLE = '';
  p.models.config.VERTEX_PROJECT = 'other-project';
  const report = (await getProviderBilling(p)).find((report) => report.id === 'vertex');
  expect(report?.message).toContain('outside the selected Google Cloud billing scope');
});

it('does not reuse a snapshot when the selected Google Cloud scope changes', async () => {
  const p = ports();
  p.fetch = vi.fn(async () => response({ jobComplete: true, rows: [row()] }));
  await getProviderBilling(p);
  p.config.GCP_PROJECT = 'different-project';
  await getProviderBilling(p);
  expect(p.fetch).toHaveBeenCalledTimes(2);
});
