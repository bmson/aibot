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
});
