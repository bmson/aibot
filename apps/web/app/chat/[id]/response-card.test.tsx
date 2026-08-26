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
});

describe('rendersAllCards', () => {
  it('accepts the ported kinds and rejects the rest', () => {
    expect(rendersAllCards([{ kind: 'weather' }, { kind: 'calendar-event' }])).toBe(true);
    expect(rendersAllCards([{ kind: 'weather' }, { kind: 'email-thread' }])).toBe(false);
    expect(rendersAllCards([{ kind: 'something-newer' }])).toBe(false);
  });
});
