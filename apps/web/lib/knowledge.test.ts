import { describe, expect, it } from 'vitest';
import { formatCanonicalDateKey } from '@/lib/knowledge';

describe('formatCanonicalDateKey', () => {
  it('renders each canonical precision in the owner locale', () => {
    expect(formatCanonicalDateKey('2026-03-06', 'en')).toBe('March 6, 2026');
    expect(formatCanonicalDateKey('2026-03', 'en')).toBe('March 2026');
    expect(formatCanonicalDateKey('--03-06', 'en')).toBe('March 6');
    expect(formatCanonicalDateKey('2026', 'en')).toBe('2026');
  });

  it('never rolls a day across a timezone boundary', () => {
    // Keys name calendar days, not instants; formatting is pinned to UTC so
    // midnight-ahead zones cannot shift the rendered day back.
    expect(formatCanonicalDateKey('2026-01-01', 'en')).toBe('January 1, 2026');
  });

  it('renders February 29 rather than rolling into March', () => {
    expect(formatCanonicalDateKey('--02-29', 'en')).toBe('February 29');
  });

  it('passes an unrecognized key through rather than dropping it', () => {
    expect(formatCanonicalDateKey('friday', 'en')).toBe('friday');
  });
});
