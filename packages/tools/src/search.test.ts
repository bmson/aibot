import { describe, expect, it } from 'vitest';
import { ToolRegistry } from './registry.js';
import { normalizeResults, registerSearchTools } from './search.js';

describe('normalizeResults', () => {
  it('maps Brave web.results to {url,title,snippet}', () => {
    const body = {
      web: {
        results: [
          { url: 'https://a.test', title: 'A', description: 'first  result\n' },
          { url: 'https://b.test', title: 'B', description: 'second' },
        ],
      },
    };
    const rows = normalizeResults('brave', body, 5);
    expect(rows).toEqual([
      { url: 'https://a.test', title: 'A', snippet: 'first result' },
      { url: 'https://b.test', title: 'B', snippet: 'second' },
    ]);
  });

  it('maps Tavily results (content → snippet)', () => {
    const rows = normalizeResults(
      'tavily',
      { results: [{ url: 'https://t.test', title: 'T', content: 'body' }] },
      5,
    );
    expect(rows).toEqual([{ url: 'https://t.test', title: 'T', snippet: 'body' }]);
  });

  it('maps Serper organic (link → url, snippet)', () => {
    const rows = normalizeResults(
      'serper',
      { organic: [{ link: 'https://s.test', title: 'S', snippet: 'snip' }] },
      5,
    );
    expect(rows).toEqual([{ url: 'https://s.test', title: 'S', snippet: 'snip' }]);
  });

  it('drops non-http rows, defaults title to url, and honours count', () => {
    const rows = normalizeResults(
      'serper',
      {
        organic: [
          { link: 'ftp://nope.test', title: 'x' },
          { link: 'https://ok.test' },
          { link: 'https://two.test', title: 'Two' },
        ],
      },
      1,
    );
    expect(rows).toEqual([{ url: 'https://ok.test', title: 'https://ok.test', snippet: '' }]);
  });
});

describe('registerSearchTools', () => {
  it('registers web.search with untrusted-content + egress flags', () => {
    const registry = new ToolRegistry();
    registerSearchTools(registry, {
      provider: 'brave',
      apiKey: 'k',
      fetchImpl: (async () =>
        new Response(JSON.stringify({ web: { results: [] } }), { status: 200 })) as typeof fetch,
    });
    const entry = registry.get('web.search');
    expect(entry).toBeTruthy();
    expect(entry?.flags.networkEgress).toBe(true);
    expect(entry?.flags.returnsUntrustedContent).toBe(true);
    expect(entry?.flags.blanketAllowIneligible).toBe(true);
  });
});
