import { describe, expect, it } from 'vitest';
import { rendersAllCards, responseCardPayloads } from './response-card.js';

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
