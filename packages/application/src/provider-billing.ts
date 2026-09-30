import { createHash } from 'node:crypto';
import type { Config } from '@assistant/config';
import type { ToolExecutionRepository } from '@assistant/persistence';
import { GoogleAuth } from 'google-auth-library';
import { z } from 'zod';
import type { ModelProviderPorts } from './model-providers.js';

export interface BillingLine {
  service: string;
  detail: string;
  currency: string;
  cost: number;
  credits: number;
  net: number;
}

/** Provider statements and the operation ledger overlap. Never add them together. */
export interface ProviderBilling {
  id: string;
  label: string;
  status: 'reported' | 'unavailable' | 'stale' | 'not_configured' | 'unsupported' | 'included';
  period: string;
  scope: string;
  source: string;
  message: string;
  fetchedAt: string | null;
  latestExportAt: string | null;
  latestUsageAt: string | null;
  lines: BillingLine[];
  includedIn?: string;
  forecast?: BillingForecast;
}

export interface BillingForecast {
  through: string;
  observedDays: number;
  daysInMonth: number;
  totals: Array<{ currency: string; spent: number; dailyAverage: number; projected: number }>;
  message: string;
}

/** A transparent run rate, never an invoice prediction or an extrapolated stale snapshot. */
export function billingForecast(report: ProviderBilling): BillingForecast | undefined {
  if (report.status !== 'reported' || !report.lines.length) return;
  const through = report.id === 'google-cloud' ? report.latestUsageAt : report.fetchedAt;
  if (!through || !/^\d{4}-\d{2}$/.test(report.period)) return;
  const start = Date.parse(`${report.period}-01T00:00:00Z`);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  const observedDays = (Date.parse(through) - start) / 86_400_000;
  const daysInMonth = (end.getTime() - start) / 86_400_000;
  if (!Number.isFinite(observedDays) || observedDays < 3 || observedDays > daysInMonth) return;
  const amounts = new Map<string, number>();
  for (const line of report.lines)
    amounts.set(line.currency, (amounts.get(line.currency) ?? 0) + line.net);
  return {
    through,
    observedDays,
    daysInMonth,
    totals: [...amounts].map(([currency, spent]) => ({
      currency,
      spent,
      dailyAverage: spent / observedDays,
      projected: (spent / observedDays) * daysInMonth,
    })),
    message:
      'Month-end estimate at the observed average daily spend, after credits. Assumes this export covers the month from day one and usage stays similar. Delayed charges, changing usage and one-off credits can change the result.',
  };
}

export type BillingConfig = Pick<
  Config,
  | 'GCP_PROJECT'
  | 'GCP_BILLING_EXPORT_TABLE'
  | 'GCP_BILLING_QUERY_PROJECT'
  | 'GCP_BILLING_LOCATION'
  | 'GCP_BILLING_SCOPE'
  | 'GCP_BILLING_MAX_BYTES'
>;
export type BillingCache = Pick<ToolExecutionRepository, 'cacheGet' | 'cachePut'>;
export interface BillingPorts {
  models: ModelProviderPorts;
  config: BillingConfig;
  cache: BillingCache;
  fetch?: typeof fetch;
  accessToken?: () => Promise<string>;
  now?: () => Date;
}

const HOUR = 3_600_000;
const RETRY = 300_000;
const RETENTION = 7 * 24 * HOUR;
// Do not share a pending response across installation-specific repositories.
const requests = new WeakMap<BillingCache, Map<string, Promise<ProviderBilling>>>();

function empty(
  id: string,
  label: string,
  period: string,
  scope: string,
  source: string,
): ProviderBilling {
  return {
    id,
    label,
    period,
    scope,
    source,
    status: 'unavailable',
    message: '',
    fetchedAt: null,
    latestExportAt: null,
    latestUsageAt: null,
    lines: [],
  };
}

interface CachedBilling {
  checkedAt: string;
  report: ProviderBilling;
}

/** Durable, scope/credential/version-keyed snapshots prevent a query on every mobile refresh. */
async function cached(
  ports: BillingPorts,
  base: ProviderBilling,
  identity: unknown,
  load: () => Promise<ProviderBilling>,
): Promise<ProviderBilling> {
  const now = (ports.now ?? (() => new Date()))();
  const key = `provider-billing:v1:${createHash('sha256')
    .update(JSON.stringify([base.period, identity]))
    .digest('hex')}`;
  let saved: CachedBilling | undefined;
  try {
    saved = (await ports.cache.cacheGet(key, now))?.result as CachedBilling | undefined;
  } catch {
    // Do not start potentially billable queries when their cache is unavailable.
    return {
      ...base,
      message: 'Billing snapshots are temporarily unavailable. The usage ledger remains separate.',
    };
  }
  if (saved?.report?.period === base.period && Number.isFinite(Date.parse(saved.checkedAt))) {
    const age = now.getTime() - Date.parse(saved.checkedAt);
    if (age >= 0 && age < (saved.report.status === 'reported' ? HOUR : RETRY)) return saved.report;
  }
  let pendingForStore = requests.get(ports.cache);
  if (!pendingForStore) {
    pendingForStore = new Map();
    requests.set(ports.cache, pendingForStore);
  }
  const existing = pendingForStore.get(key);
  if (existing) return existing;
  const run = async () => {
    let report: ProviderBilling;
    try {
      report = await load();
    } catch {
      // Never forward HTTP/auth errors: they may contain a request credential.
      const previous =
        saved?.report?.period === base.period && saved.report.fetchedAt ? saved.report : null;
      report = previous
        ? {
            ...previous,
            status: 'stale',
            message:
              'Refresh failed. Showing the last successful provider snapshot; check credentials, permissions and export settings.',
          }
        : {
            ...base,
            status: 'unavailable',
            message:
              'Provider data could not be loaded. Check credentials, permissions and export settings. Missing spend is not zero.',
          };
    }
    try {
      await ports.cache.cachePut({
        cacheKey: key,
        toolName: 'billing.snapshot',
        result: { checkedAt: now.toISOString(), report },
        expiresAt: new Date(now.getTime() + RETENTION),
      });
    } catch {
      report = { ...report, message: `${report.message} This snapshot could not be saved.` };
    }
    return report;
  };
  const pending = run().finally(() => pendingForStore.delete(key));
  pendingForStore.set(key, pending);
  return pending;
}

async function json(request: typeof fetch, url: string, init: RequestInit = {}): Promise<unknown> {
  const response = await request(url, {
    ...init,
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`Billing HTTP ${response.status}`);
  return response.json();
}

const openrouterKey = z.object({
  data: z.object({
    usage_monthly: z.number().finite().nonnegative(),
    byok_usage_monthly: z.number().finite().nonnegative().optional(),
  }),
});

export async function readOpenRouterBilling(
  request: typeof fetch,
  apiKey: string,
  base: ProviderBilling,
  now: Date,
): Promise<ProviderBilling> {
  const { data } = openrouterKey.parse(
    await json(request, 'https://openrouter.ai/api/v1/key', {
      headers: { Authorization: `Bearer ${apiKey}` },
    }),
  );
  return {
    ...base,
    status: 'reported',
    fetchedAt: now.toISOString(),
    message: `Spend reported for the connected API key, including use outside this assistant. Credit purchases and other keys are excluded.${data.byok_usage_monthly ? ' BYOK upstream usage is billed separately by that provider and is not added here.' : ''}`,
    lines: [
      {
        service: 'OpenRouter',
        detail: 'Current API key · month to date',
        currency: 'USD',
        cost: data.usage_monthly,
        credits: 0,
        net: data.usage_monthly,
      },
    ],
  };
}

const queryPage = z.object({
  jobComplete: z.boolean(),
  jobReference: z
    .object({ projectId: z.string(), jobId: z.string(), location: z.string().optional() })
    .optional(),
  pageToken: z.string().optional(),
  errors: z.array(z.unknown()).optional(),
  rows: z.array(z.object({ f: z.array(z.object({ v: z.unknown() })) })).optional(),
});

/** Parameterized values; identifiers are validated before entering SQL. No service-name allowlist. */
export function googleBillingQuery(config: BillingConfig, now: Date) {
  if (!/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9_]+\.[a-zA-Z0-9_]+$/.test(config.GCP_BILLING_EXPORT_TABLE))
    throw new Error('Invalid Cloud Billing export table');
  if (config.GCP_BILLING_SCOPE === 'project' && !config.GCP_PROJECT)
    throw new Error('Missing billing project scope');
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const parameters = [
    {
      name: 'start',
      parameterType: { type: 'TIMESTAMP' },
      parameterValue: { value: start.toISOString() },
    },
    {
      name: 'end',
      parameterType: { type: 'TIMESTAMP' },
      parameterValue: { value: now.toISOString() },
    },
    ...(config.GCP_BILLING_SCOPE === 'project'
      ? [
          {
            name: 'project',
            parameterType: { type: 'STRING' },
            parameterValue: { value: config.GCP_PROJECT },
          },
        ]
      : []),
  ];
  return {
    query: `SELECT currency, COALESCE(project.id, '(unallocated)'), service.description, sku.description, cost_type,
      CAST(SUM(CAST(cost AS NUMERIC)) AS STRING),
      CAST(SUM(IFNULL((SELECT SUM(CAST(c.amount AS NUMERIC)) FROM UNNEST(credits) c), 0)) AS STRING),
      CAST(SUM(CAST(cost AS NUMERIC) + IFNULL((SELECT SUM(CAST(c.amount AS NUMERIC)) FROM UNNEST(credits) c), 0)) AS STRING),
      FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', MAX(export_time), 'UTC'),
      FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', MAX(usage_end_time), 'UTC')
      FROM \`${config.GCP_BILLING_EXPORT_TABLE}\`
      WHERE usage_start_time >= @start AND usage_start_time < @end
      ${config.GCP_BILLING_SCOPE === 'project' ? 'AND project.id = @project' : ''}
      GROUP BY 1, 2, 3, 4, 5 ORDER BY 1, 2, 3, 4, 5`,
    useLegacySql: false,
    parameterMode: 'NAMED',
    queryParameters: parameters,
    maximumBytesBilled: String(config.GCP_BILLING_MAX_BYTES),
    location: config.GCP_BILLING_LOCATION,
    timeoutMs: 10_000,
    maxResults: 1_000,
  };
}

function amount(value: unknown): number {
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value))
    throw new Error('Invalid billing amount');
  const result = Number(value);
  if (!Number.isFinite(result) || Math.abs(result) > Number.MAX_SAFE_INTEGER / 1_000_000)
    throw new Error('Billing amount overflow');
  return result;
}

function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
    throw new Error('Invalid billing timestamp');
  return new Date(value).toISOString();
}

export async function readGoogleBilling(
  ports: BillingPorts,
  base: ProviderBilling,
  now: Date,
): Promise<ProviderBilling> {
  const config = ports.config;
  const body = googleBillingQuery(config, now);
  const token = await (
    ports.accessToken ??
    (async () => {
      const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/bigquery'] });
      const token = await auth.getAccessToken();
      if (!token) throw new Error('No Google credentials');
      return token;
    })
  )();
  const project = config.GCP_BILLING_QUERY_PROJECT || config.GCP_BILLING_EXPORT_TABLE.split('.')[0];
  const root = 'https://bigquery.googleapis.com/bigquery/v2/projects';
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const request = ports.fetch ?? fetch;
  let page = queryPage.parse(
    await json(request, `${root}/${encodeURIComponent(project ?? '')}/queries`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
  );
  const lines: BillingLine[] = [];
  let latestExportAt: string | null = null;
  let latestUsageAt: string | null = null;
  // Bounded polling and pagination: incomplete results are an error, never a partial total.
  for (let index = 0; index < 50; index++) {
    if (page.errors?.length) throw new Error('Billing query failed');
    if (page.jobComplete) {
      for (const row of page.rows ?? []) {
        const cells = row.f.map((cell) => cell.v);
        if (cells.length !== 10 || typeof cells[0] !== 'string' || !/^[A-Z]{3}$/.test(cells[0]))
          throw new Error('Invalid billing row');
        lines.push({
          currency: cells[0],
          service: String(cells[2] ?? 'Other'),
          detail: `${cells[1]} · ${cells[3] ?? 'Other'} · ${cells[4] ?? 'regular'}`,
          cost: amount(cells[5]),
          credits: amount(cells[6]),
          net: amount(cells[7]),
        });
        const exported = timestamp(cells[8]);
        const used = timestamp(cells[9]);
        if (!latestExportAt || exported > latestExportAt) latestExportAt = exported;
        if (!latestUsageAt || used > latestUsageAt) latestUsageAt = used;
      }
      if (!page.pageToken)
        return {
          ...base,
          status: lines.length ? 'reported' : 'unavailable',
          fetchedAt: now.toISOString(),
          latestExportAt,
          latestUsageAt,
          lines,
          message: lines.length
            ? 'Exported usage this UTC month, after credits. Reporting is delayed and may be corrected; this is not a final invoice. Latest usage is not a completeness guarantee.'
            : 'No exported usage for this period and scope yet. Spend is unavailable, not zero.',
        };
    }
    if (!page.jobReference || (!page.jobComplete && index >= 2))
      throw new Error('Billing query incomplete');
    const job = page.jobReference;
    const params = new URLSearchParams({
      location: job.location ?? config.GCP_BILLING_LOCATION,
      timeoutMs: '1000',
      maxResults: '1000',
      ...(page.pageToken ? { pageToken: page.pageToken } : {}),
    });
    const next = queryPage.parse(
      await json(
        request,
        `${root}/${encodeURIComponent(job.projectId)}/queries/${encodeURIComponent(job.jobId)}?${params}`,
        { headers },
      ),
    );
    page = { ...next, jobReference: next.jobReference ?? job };
  }
  throw new Error('Billing results exceed the supported page limit');
}

/** Adding a connected provider automatically exposes its billing coverage, even without a billing API. */
export async function getProviderBilling(ports: BillingPorts): Promise<ProviderBilling[]> {
  const now = (ports.now ?? (() => new Date()))();
  const period = now.toISOString().slice(0, 7);
  let connections: Awaited<ReturnType<ModelProviderPorts['connections']['list']>> = [];
  let connectionsUnavailable = false;
  try {
    connections = [...(await ports.models.connections.list())];
  } catch {
    connectionsUnavailable = true;
  }
  const config = ports.config;
  const base = empty(
    'google-cloud',
    'Google Cloud',
    period,
    config.GCP_BILLING_SCOPE === 'project'
      ? `Project: ${config.GCP_PROJECT || 'not configured'}`
      : 'Billing export account (all projects)',
    'Google Cloud Billing export',
  );
  const google = config.GCP_BILLING_EXPORT_TABLE
    ? cached(ports, base, ['google', config], () => readGoogleBilling(ports, base, now))
    : Promise.resolve({
        ...base,
        status: 'not_configured' as const,
        message:
          'Connect a Cloud Billing BigQuery export to see database, models, hosting, storage and other Google Cloud services.',
      });
  if (connectionsUnavailable)
    return [
      await google,
      {
        ...empty(
          'model-providers',
          'Model providers',
          period,
          'Connected providers',
          'Provider connections',
        ),
        message: 'Model provider connections could not be loaded. Billing coverage is unavailable.',
      },
    ];
  if (
    !connections.some((row) => row.id === 'openrouter') &&
    ports.models.config.LLM_PROVIDER !== 'vertex'
  ) {
    connections.push({
      id: 'openrouter',
      kind: 'openrouter',
      label: 'OpenRouter',
      apiKeyEncrypted: null,
      baseUrl: null,
      vertexProject: null,
      vertexLocation: null,
      enabled: true,
      lastTestedAt: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    });
  }
  if (!connections.some((row) => row.id === 'vertex') && ports.models.config.VERTEX_PROJECT) {
    connections.push({
      id: 'vertex',
      kind: 'vertex',
      label: 'Google Vertex AI',
      apiKeyEncrypted: null,
      baseUrl: null,
      vertexProject: ports.models.config.VERTEX_PROJECT,
      vertexLocation: ports.models.config.VERTEX_LOCATION,
      enabled: true,
      lastTestedAt: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    });
  }
  const googleReport = await google;
  const reports = connections.map(async (connection) => {
    const report = empty(
      connection.id,
      connection.label,
      period,
      `Connection: ${connection.label}`,
      connection.kind,
    );
    if (connection.kind === 'vertex') {
      const project = connection.vertexProject || ports.models.config.VERTEX_PROJECT;
      const covered =
        Boolean(project) &&
        (config.GCP_BILLING_SCOPE === 'billing_account'
          ? googleReport.lines.some((line) => line.detail.startsWith(`${project} ·`))
          : project === config.GCP_PROJECT);
      const available = covered && ['reported', 'stale'].includes(googleReport.status);
      return {
        ...report,
        status: available ? ('included' as const) : ('unavailable' as const),
        ...(available ? { includedIn: 'google-cloud' } : {}),
        message:
          project && config.GCP_BILLING_SCOPE === 'project' && project !== config.GCP_PROJECT
            ? `Vertex uses project ${project}, outside the selected Google Cloud billing scope. Its costs are not included above.`
            : available
              ? 'Vertex AI is covered by Google Cloud billing above. See its service breakdown; no separate bill is added. Model-level token costs below remain estimates.'
              : 'Connect Google Cloud billing to track Vertex AI charges. Both use the same billing export. Model-level token costs below remain estimates.',
      };
    }
    if (connection.kind !== 'openrouter')
      return {
        ...report,
        status: 'unsupported' as const,
        message:
          'No billing connector for this provider yet. Calls are tracked in the usage ledger; configured prices are estimates, not a provider bill.',
      };
    let key: string;
    try {
      key = connection.apiKeyEncrypted
        ? ports.models.open(connection.apiKeyEncrypted)
        : ports.models.config.OPENROUTER_API_KEY;
    } catch {
      return { ...report, message: 'The saved billing credential could not be opened.' };
    }
    if (!key)
      return {
        ...report,
        status: 'not_configured' as const,
        message: 'Connect an OpenRouter API key in AI providers to read its reported spend.',
      };
    return cached(ports, report, ['openrouter', connection.id, connection.label, key], () =>
      readOpenRouterBilling(ports.fetch ?? fetch, key, report, now),
    );
  });
  const result = await Promise.all([googleReport, ...reports]);
  return result.map((report) => ({ ...report, forecast: billingForecast(report) }));
}
