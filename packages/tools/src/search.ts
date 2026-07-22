import { recordCostEvent } from '@assistant/core';
import { z } from 'zod';
import type { ToolRegistry } from './registry.js';
import type { AssistantTool, ToolFlags } from './types.js';

export type SearchProvider = 'brave' | 'tavily' | 'serper';

export interface SearchResult {
  url: string;
  title: string;
  snippet: string;
}

export interface SearchToolDeps {
  provider: SearchProvider;
  apiKey: string;
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** Conservative per-call cost estimate (USD) by provider, for the ledger. */
const PROVIDER_COST_USD: Record<SearchProvider, number> = {
  brave: 0.005,
  tavily: 0.008,
  serper: 0.001,
};

const MAX_SNIPPET = 400;

function clip(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

/** Normalize each provider's response shape into ranked {url,title,snippet}. */
export function normalizeResults(
  provider: SearchProvider,
  body: unknown,
  count: number,
): SearchResult[] {
  const rows: SearchResult[] = [];
  const push = (url: unknown, title: unknown, snippet: unknown) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      rows.push({ url, title: clip(title, 200) || url, snippet: clip(snippet, MAX_SNIPPET) });
    }
  };
  if (provider === 'brave') {
    const results = (body as { web?: { results?: unknown[] } })?.web?.results ?? [];
    for (const r of results as Array<Record<string, unknown>>) push(r.url, r.title, r.description);
  } else if (provider === 'tavily') {
    const results = (body as { results?: unknown[] })?.results ?? [];
    for (const r of results as Array<Record<string, unknown>>) push(r.url, r.title, r.content);
  } else {
    const results = (body as { organic?: unknown[] })?.organic ?? [];
    for (const r of results as Array<Record<string, unknown>>) push(r.link, r.title, r.snippet);
  }
  return rows.slice(0, count);
}

async function runSearch(
  deps: SearchToolDeps,
  query: string,
  count: number,
  signal: AbortSignal,
): Promise<SearchResult[]> {
  const doFetch = deps.fetchImpl ?? fetch;
  let response: Response;
  if (deps.provider === 'brave') {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
    response = await doFetch(url, {
      headers: { Accept: 'application/json', 'X-Subscription-Token': deps.apiKey },
      signal,
    });
  } else if (deps.provider === 'tavily') {
    response = await doFetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: deps.apiKey, query, max_results: count }),
      signal,
    });
  } else {
    response = await doFetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': deps.apiKey },
      body: JSON.stringify({ q: query, num: count }),
      signal,
    });
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `web.search ${deps.provider} failed: HTTP ${response.status} ${detail.slice(0, 200)}`,
    );
  }
  const json = await response.json();
  return normalizeResults(deps.provider, json, count);
}

function register<S extends z.ZodType, Out>(
  registry: ToolRegistry,
  tool: AssistantTool<S, Out>,
  flags: ToolFlags = {},
) {
  registry.register(tool as unknown as AssistantTool, flags);
}

/**
 * Register web.search. This is the discovery entry point the browse ladder was
 * missing: web.fetch/browser.execute both need a starting URL, and search
 * engines answer datacenter traffic with CAPTCHA walls, so without this the
 * planner had to guess URLs. Flags mirror web.fetch — networkEgress routes it to
 * owner approval inside a tainted session, and results are untrusted content.
 */
export function registerSearchTools(registry: ToolRegistry, deps: SearchToolDeps): ToolRegistry {
  const schema = z.object({
    query: z.string().min(2).max(256),
    count: z.number().int().min(1).max(10).default(5),
  });
  register(
    registry,
    {
      name: 'web.search',
      description:
        'Search the web and return ranked results (url, title, snippet). Use this to find a starting URL when you do not already know one, then read the best result with web.fetch or plan a browse.',
      inputSchema: schema,
      risk: 'autonomous',
      acceptsUntrustedInput: true,
      approvalSummary: (args) => `Search the web for "${(args as z.infer<typeof schema>).query}"`,
      cacheTtlSeconds: 900,
      execute: async (args, ctx) => {
        const { query, count } = args as z.infer<typeof schema>;
        const results = await runSearch(
          deps,
          query,
          count,
          AbortSignal.any([ctx.signal, AbortSignal.timeout(15000)]),
        );
        // Fractions of a cent — record after the fact, no pre-flight reservation.
        await recordCostEvent(ctx.db, {
          source: 'external_api',
          usd: PROVIDER_COST_USD[deps.provider],
          taskId: ctx.taskId,
          toolCallId: ctx.execution?.dbToolCallId ?? null,
          quantity: 1,
          unit: 'search',
          unitPriceUsd: PROVIDER_COST_USD[deps.provider],
          description: `web.search (${deps.provider})`,
          addToTaskSpend: true,
        }).catch((err) => console.error('web.search cost record failed', err));
        return { query, results };
      },
    },
    {
      returnsUntrustedContent: true,
      networkEgress: true,
      blanketAllowIneligible: true,
    },
  );
  return registry;
}
