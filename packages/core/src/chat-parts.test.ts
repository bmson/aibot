import { describe, expect, it } from 'vitest';
import { assistantMessageParts } from './chat.js';

describe('assistantMessageParts', () => {
  it('returns only a text part when there is no recall', () => {
    expect(assistantMessageParts('hello')).toEqual([{ type: 'text', text: 'hello' }]);
    expect(assistantMessageParts('hello', [])).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('appends a recall part carrying the provenance sources', () => {
    const sources = [{ date: '2025-01-10', label: 'apartment lease' }];
    expect(assistantMessageParts('hi', sources)).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'recall', sources },
    ]);
  });

  it('appends companion cue parts after text and recall', () => {
    const sources = [{ date: '2025-01-10', label: 'apartment lease' }];
    expect(
      assistantMessageParts('hi', sources, {
        cues: [
          { kind: 'face', state: 'warm_smile' },
          { kind: 'chips', labels: ['Tell me more'] },
        ],
      }),
    ).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'recall', sources },
      { type: 'data-face', data: { state: 'warm_smile' } },
      { type: 'data-chips', data: { labels: ['Tell me more'] } },
    ]);
    expect(assistantMessageParts('hi', undefined, { cues: [] })).toEqual([
      { type: 'text', text: 'hi' },
    ]);
  });
});
