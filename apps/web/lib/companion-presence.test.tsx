import { describe, expect, it } from 'vitest';
import { presenceThought } from '@/lib/companion-bus';

describe('presenceThought', () => {
  it('names what the shell is doing', () => {
    expect(presenceThought('working')).toMatchObject({ tone: 'working' });
    expect(presenceThought('attention')).toMatchObject({ tone: 'waiting' });
    expect(presenceThought('idle')).toBeNull();
  });

  /*
   * The regression this pins: the result feeds `live`, which is an effect
   * dependency, and the effect sets state. A fresh object per call made that
   * effect re-run on every render and re-render on every run — an unbounded
   * loop that ran the whole time the shell's presence was working or
   * attention, i.e. on every page, until the renderer stopped responding.
   * Equal values are not enough here; React compares identity.
   */
  it('returns the same object every call, so it is safe in a dependency array', () => {
    expect(presenceThought('working')).toBe(presenceThought('working'));
    expect(presenceThought('attention')).toBe(presenceThought('attention'));
  });
});
