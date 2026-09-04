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
        { kind: 'proactive-alert' },
        {
          kind: 'generated-card',
          spec: {
            version: 1,
            title: 'Ticket',
            facts: [{ id: 'title', value: 'Show' }],
            blocks: [{ type: 'hero', titleFact: 'title' }],
          },
        },
      ]),
    ).toBe(true);
    expect(rendersAllCards([{ kind: 'weather' }, { kind: 'email-thread' }])).toBe(false);
    expect(rendersAllCards([{ kind: 'something-newer' }])).toBe(false);
  });
});

describe('ResponseCards', () => {
  const render = (card: Record<string, unknown>) =>
    renderToStaticMarkup(<ResponseCards cards={[card]} timeZone="UTC" />);

  it('reformats the historical inline numbered calendar reply as an agenda', () => {
    const cards = responseCardPayloads([
      {
        type: 'text',
        text: 'Tomorrow has two upcoming events: 1) Coffee with Tine at 9:00 AM at Home Coffee Roasters. 2) Technical interviews with Clay from 1:00-2:00 PM.',
      },
    ]);
    expect(cards).toMatchObject([
      {
        kind: 'agenda',
        title: 'Tomorrow',
        items: [
          { time: '9:00 AM', title: 'Coffee with Tine', detail: 'Home Coffee Roasters' },
          { time: '1:00-2:00 PM', title: 'Technical interviews with Clay' },
        ],
      },
    ]);
    const html = renderToStaticMarkup(<ResponseCards cards={cards} timeZone="UTC" />);
    expect(html).toContain('2 upcoming events');
    expect(html).not.toContain('Tomorrow has two');
  });

  it('reformats the historical starts-in notice without exposing salience diagnostics', () => {
    const cards = responseCardPayloads([
      {
        type: 'text',
        text: '"Annual Physical" starts in 30 minutes at One Medical, 559 Clay St. it is at One Medical, 559 Clay St; family@example.com called it.',
      },
    ]);
    expect(cards).toMatchObject([
      {
        kind: 'proactive-alert',
        urgencyLabel: 'Starts in 30 min',
        title: 'Annual Physical',
        details: [{ label: 'Location', value: 'One Medical, 559 Clay St' }],
      },
    ]);
    expect(JSON.stringify(cards)).not.toContain('called it');
  });

  it('keeps ordinary numbered prose as prose', () => {
    expect(
      responseCardPayloads([
        { type: 'text', text: 'Try these: 1) Bring water. 2) Leave a little early.' },
      ]),
    ).toEqual([]);
  });

  it('groups calendar event payloads into one day schedule', () => {
    const html = renderToStaticMarkup(
      <ResponseCards
        timeZone="America/Los_Angeles"
        cards={[
          {
            kind: 'calendar-event',
            id: 'e1',
            start: '2026-09-02T09:00:00-07:00',
            time: '9:00 AM–10:00 AM',
            title: 'Coffee with Tine',
          },
          {
            kind: 'calendar-event',
            id: 'e2',
            start: '2026-09-02T13:00:00-07:00',
            time: '1:00 PM–2:00 PM',
            title: 'Technical interviews',
          },
        ]}
      />,
    );
    expect(html).toContain('Wednesday, Sep 2 · 2 events');
    expect(html.match(/paper/g)?.length).toBe(1);
    expect(html).toContain('data-response-card="true"');
    expect(html).toContain('<header');
    expect(html).toContain('Coffee with Tine');
    expect(html).toContain('Technical interviews');
  });

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

  it('shows three result rows at first glance and discloses the rest', () => {
    const html = render({
      kind: 'web-search-results',
      id: 'search-1',
      results: Array.from({ length: 5 }, (_, index) => ({
        id: `r${index}`,
        title: `Result ${index + 1}`,
        url: `https://example.com/${index}`,
        snippet: `Snippet ${index + 1}`,
      })),
    });
    expect(html).toContain('2 more');
    expect(html.indexOf('Result 3')).toBeLessThan(html.indexOf('2 more'));
    expect(html.indexOf('2 more')).toBeLessThan(html.indexOf('Result 4'));
  });

  it('shows three cards before grouping additional cards', () => {
    const cards = Array.from({ length: 5 }, (_, index) => ({
      kind: 'status',
      id: `status-${index}`,
      title: `Status ${index + 1}`,
      detail: `Detail ${index + 1}`,
    }));
    const html = renderToStaticMarkup(<ResponseCards cards={cards} timeZone="UTC" />);
    expect(html).toContain('2 more results');
    expect(html.indexOf('Status 3')).toBeLessThan(html.indexOf('2 more results'));
    expect(html.indexOf('2 more results')).toBeLessThan(html.indexOf('Status 4'));
  });

  it('renders a generated ticket from native blocks and conceals its bearer code', () => {
    const html = render({
      kind: 'generated-card',
      id: 'ticket-1',
      spec: {
        version: 1,
        title: 'Movie ticket',
        sourceLabel: 'Cinema email',
        icon: 'ticket',
        accent: 'violet',
        accessibilityLabel: 'Movie ticket for Dune',
        facts: [
          { id: 'movie', label: 'Movie', value: 'Dune: Part Two', source: 'mail' },
          {
            id: 'code',
            label: 'Ticket code',
            value: 'MV-4829-AX',
            source: 'mail',
            sensitive: true,
          },
        ],
        blocks: [
          { type: 'hero', titleFact: 'movie' },
          { type: 'code', valueFact: 'code', format: 'text' },
        ],
        actions: [],
      },
    });
    expect(html).toContain('Dune: Part Two');
    expect(html).toContain('Tap to reveal');
    expect(html).not.toContain('MV-4829-AX');
  });

  it('masks a sensitive fact as a named button, one asterisk per character', () => {
    const html = render({
      kind: 'generated-card',
      id: 'hotel-1',
      spec: {
        version: 1,
        title: 'Hotel Kabuki',
        sourceLabel: 'Hotel',
        accessibilityLabel: 'Hotel Kabuki reservation',
        facts: [
          {
            id: 'ref',
            label: 'Booking reference',
            value: '73535845212',
            source: 'mail',
            sensitive: true,
          },
        ],
        blocks: [{ type: 'facts', factIds: ['ref'] }],
        actions: [],
      },
    });
    expect(html).not.toContain('73535845212');
    expect(html).toContain('***********');
    expect(html).toContain('aria-label="Show booking reference"');
    expect(html).toContain('aria-pressed="false"');
    // Same face and character count on both sides of the toggle, so revealing
    // rewrites the line instead of reflowing it.
    expect(html).toContain('font-mono');
  });

  it('folds the work behind an answer card into one closed row', () => {
    const html = render({
      kind: 'generated-card',
      id: 'hotel-2',
      steps: [
        { tool: 'gmail.search', count: '1 result', detail: 'from:Katie hotels.com 73535845212' },
        { tool: 'gmail.read_thread', count: '1 message', detail: 'Fwd: travel confirmation' },
        { tool: 'nowhere.at_all', count: '1 record' },
      ],
      spec: {
        version: 1,
        title: 'Hotel Kabuki',
        sourceLabel: 'Hotel',
        accessibilityLabel: 'Hotel Kabuki reservation',
        facts: [{ id: 'name', label: 'Hotel', value: 'Hotel Kabuki', source: 'mail' }],
        blocks: [{ type: 'hero', titleFact: 'name' }],
        actions: [],
      },
    });
    expect(html).toContain('Found in 3 steps');
    expect(html).toContain('aria-expanded="false"');
    // Closed, and out of the accessibility tree until it is opened.
    expect(/<ul id="[^"]+" hidden/.test(html)).toBe(true);
    // User-facing language, never the dotted call the runtime made.
    expect(html).toContain('Searched email');
    expect(html).toContain('Checked nowhere');
    expect(html).not.toContain('gmail.search');
  });

  it('counts one step as one step and says which of them failed', () => {
    const card = (steps: Array<Record<string, unknown>>) => ({
      kind: 'generated-card',
      id: 'steps',
      steps,
      spec: {
        version: 1,
        title: 'Card',
        sourceLabel: 'Mail',
        accessibilityLabel: 'Card',
        facts: [{ id: 'a', label: 'A', value: 'One', source: 'mail' }],
        blocks: [{ type: 'hero', titleFact: 'a' }],
        actions: [],
      },
    });
    expect(render(card([{ tool: 'gmail.search' }]))).toContain('Found in 1 step');
    const withFailure = render(
      card([
        { tool: 'gmail.search', count: '1 result' },
        { tool: 'gmail.read_thread', count: '1 message' },
        { tool: 'web.fetch', failed: true, error: 'Upstream returned 503' },
      ]),
    );
    expect(withFailure).toContain('Found in 3 steps, 1 failed');
    expect(withFailure).toContain('Upstream returned 503');
  });

  it('offers no steps affordance when the answer took no tool calls', () => {
    const html = render({
      kind: 'generated-card',
      id: 'no-steps',
      steps: [],
      spec: {
        version: 1,
        title: 'Card',
        sourceLabel: 'Mail',
        accessibilityLabel: 'Card',
        facts: [{ id: 'a', label: 'A', value: 'One', source: 'mail' }],
        blocks: [{ type: 'hero', titleFact: 'a' }],
        actions: [],
      },
    });
    expect(html).not.toContain('Found in');
    expect(html).not.toContain('aria-expanded');
  });

  it('keeps prose fallback for an unsupported generated-card schema version', () => {
    expect(
      rendersAllCards([
        { kind: 'generated-card', id: 'future', spec: { version: 2, title: 'Future' } },
      ]),
    ).toBe(false);
  });
});
