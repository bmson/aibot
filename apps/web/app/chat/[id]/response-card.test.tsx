import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ResponseCards, rendersAllCards, responseCardPayloads } from './response-card.js';

describe('responseCardPayloads', () => {
  it('collects data-card payloads in order and ignores everything else', () => {
    const parts: unknown[] = [
      { type: 'text', text: 'Your day:' },
      { type: 'data-card', data: { kind: 'weather', id: 'w1', temperature: '11°C' } },
      { type: 'recall', sources: [] },
      { type: 'data-card', data: { kind: 'status', id: 's1', title: 'Email sent' } },
      { type: 'data-card' }, // no data — dropped
      'junk',
      null,
    ];
    expect(responseCardPayloads(parts).map((card) => card.id)).toEqual(['w1', 's1']);
  });

  it('drops zero-result Drive cards so they cannot become an empty out-of-context surface', () => {
    expect(
      responseCardPayloads([
        { type: 'data-card', data: { kind: 'drive-results', id: 'empty', files: [] } },
      ]),
    ).toEqual([]);
    expect(
      responseCardPayloads([
        {
          type: 'data-card',
          data: { kind: 'drive-results', id: 'found', files: [{ id: 'f1', name: 'Real.jpg' }] },
        },
      ]).map((card) => card.id),
    ).toEqual(['found']);
  });
});

describe('rendersAllCards', () => {
  it('accepts the ported kinds and rejects the rest', () => {
    expect(
      rendersAllCards([
        { kind: 'weather' },
        { kind: 'calendar-event' },
        { kind: 'knowledge-graph' },
        { kind: 'calendar-conflicts' },
      ]),
    ).toBe(true);
    expect(rendersAllCards([{ kind: 'weather' }, { kind: 'email-thread' }])).toBe(false);
    expect(rendersAllCards([{ kind: 'something-newer' }])).toBe(false);
  });
});

describe('ResponseCards', () => {
  const render = (card: Record<string, unknown>) =>
    renderToStaticMarkup(<ResponseCards cards={[card]} timeZone="UTC" />);

  it('omits confidence entirely when the payload carries none', () => {
    // NaN in the producer serialises to null, and Number(null) is 0 — a
    // provenance card must not report an unknown confidence as a measured 0%.
    const html = render({
      kind: 'knowledge-graph',
      id: 'k1',
      edges: [{ id: 'e1', fromLabel: 'Owner', toLabel: 'Carnival', label: 'attended' }],
    });
    expect(html).not.toContain('Confidence');
  });

  it('renders a confidence that is present, including one arriving as a string', () => {
    expect(
      render({
        kind: 'knowledge-graph',
        id: 'k2',
        edges: [{ id: 'e1', fromLabel: 'A', toLabel: 'B', label: 'knows', confidence: 0.6 }],
      }),
    ).toContain('Confidence: 60%');
    expect(
      render({
        kind: 'knowledge-graph',
        id: 'k3',
        edges: [{ id: 'e1', fromLabel: 'A', toLabel: 'B', label: 'knows', confidence: '0.85' }],
      }),
    ).toContain('Confidence: 85%');
  });

  it('will not put a non-http scheme in an href', () => {
    // Card URLs come from tool results, so they reach as far as any other
    // model-adjacent input. React only warns on these; the card has to refuse.
    const html = render({
      kind: 'web-search-results',
      id: 'w1',
      results: [
        { url: 'javascript:alert(1)', title: 'Trust me' },
        { url: 'https://example.com/real', title: 'Real result' },
      ],
    });
    expect(html).not.toContain('javascript:');
    expect(html).toContain('Trust me');
    expect(html).toContain('href="https://example.com/real"');
  });

  it('drops an unsafe Drive link but keeps the file name readable', () => {
    const html = render({
      kind: 'drive-results',
      id: 'd1',
      files: [{ id: 'f1', name: 'Photos.zip', url: 'data:text/html,<script>x</script>' }],
    });
    expect(html).not.toContain('data:text/html');
    expect(html).toContain('Photos.zip');
  });
});
