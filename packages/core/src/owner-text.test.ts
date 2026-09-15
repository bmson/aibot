import { describe, expect, it } from 'vitest';
import {
  collapseWhitespace,
  ownerDate,
  ownerDateTime,
  ownerEventWhen,
  ownerTime,
  truncateAtBoundary,
} from './owner-text.js';

const PACIFIC = 'America/Los_Angeles';
/** 2026-09-15T10:00 Pacific — the morning the reviewed digest went out. */
const NOW = new Date('2026-09-15T17:00:00Z');

describe('collapseWhitespace', () => {
  it('flattens the newline a calendar location carries', () => {
    expect(collapseWhitespace('Crocker Amazon\n1669 Geneva Avenue, San Francisco, CA 94134')).toBe(
      'Crocker Amazon 1669 Geneva Avenue, San Francisco, CA 94134',
    );
  });

  it('collapses runs and trims the ends', () => {
    expect(collapseWhitespace('  a \t\n  b  ')).toBe('a b');
  });

  it('leaves already-flat text alone', () => {
    expect(collapseWhitespace('Anniversary Lunch')).toBe('Anniversary Lunch');
  });
});

describe('truncateAtBoundary', () => {
  it('returns text that already fits', () => {
    expect(truncateAtBoundary('short enough', 40)).toBe('short enough');
  });

  it('cuts on a word boundary and marks the cut', () => {
    const cut = truncateAtBoundary('a routine reminder with a clear deadline in the future', 30);
    expect(cut).toBe('a routine reminder with a…');
    expect(cut.length).toBeLessThanOrEqual(30);
  });

  it('never ends mid-word, which is what the hard slices used to do', () => {
    const source = 'Payment reminder for a car loan with a specific due date and amount.';
    // Below this budget there is no whole word to keep and the documented hard
    // cut is the only option, so the property does not apply.
    const firstWord = source.slice(0, source.indexOf(' '));
    for (let max = firstWord.length + 2; max <= source.length; max += 1) {
      const cut = truncateAtBoundary(source, max);
      expect(cut.length).toBeLessThanOrEqual(max);
      if (!cut.endsWith('…')) continue;
      const tail = cut.slice(0, -1);
      expect(source.startsWith(tail)).toBe(true);
      // Whatever follows the kept text in the original must not be a word
      // character: that is what distinguishes a whole word from a severed one.
      // It may be a space, or punctuation the cut deliberately stripped.
      expect(source.slice(tail.length, tail.length + 1)).not.toMatch(/[A-Za-z0-9]/);
    }
  });

  it('drops trailing punctuation left dangling by the cut', () => {
    expect(truncateAtBoundary('one, two, three, four', 12)).toBe('one, two…');
  });

  it('falls back to a hard cut when one word exceeds the budget', () => {
    expect(truncateAtBoundary('supercalifragilistic', 10)).toBe('supercali…');
  });

  it('handles a budget too small for the mark', () => {
    expect(truncateAtBoundary('anything', 0)).toBe('');
    expect(truncateAtBoundary('anything', 1)).toBe('…');
  });
});

describe('ownerTime', () => {
  it('renders a UTC instant in the owner zone', () => {
    // The digest showed this as "2026-09-17T00:15:00Z"; it is a Wednesday
    // afternoon swim, not a small-hours one.
    expect(ownerTime('2026-09-17T00:15:00Z', PACIFIC)).toBe('5:15 PM');
  });

  it('renders an offset instant the same way as its UTC equivalent', () => {
    expect(ownerTime('2026-09-15T18:30:00-07:00', PACIFIC)).toBe(
      ownerTime('2026-09-16T01:30:00Z', PACIFIC),
    );
  });

  it('passes an unparseable value through rather than showing Invalid Date', () => {
    expect(ownerTime('not a date', PACIFIC)).toBe('not a date');
  });
});

describe('ownerDate', () => {
  it('says Today for the current local day', () => {
    expect(ownerDate('2026-09-15T18:30:00-07:00', PACIFIC, NOW)).toBe('Today');
  });

  it('says Tomorrow for the next local day', () => {
    expect(ownerDate('2026-09-16T11:45:00-07:00', PACIFIC, NOW)).toBe('Tomorrow');
  });

  it('names the weekday further out', () => {
    expect(ownerDate('2026-09-18T11:45:00-07:00', PACIFIC, NOW)).toBe('Fri, Sep 18');
  });

  it('resolves relative labels in the owner zone, not UTC', () => {
    // 2026-09-16T01:30Z is still the 15th in Pacific: "Today", not "Tomorrow".
    expect(ownerDate('2026-09-16T01:30:00Z', PACIFIC, NOW)).toBe('Today');
  });
});

describe('ownerDateTime', () => {
  it('joins the relative day and the clock time', () => {
    expect(ownerDateTime('2026-09-16T11:45:00-07:00', PACIFIC, NOW)).toBe('Tomorrow 11:45 AM');
  });
});

describe('ownerEventWhen', () => {
  it('renders a same-day range once', () => {
    expect(
      ownerEventWhen(
        { start: '2026-09-15T18:30:00-07:00', end: '2026-09-15T20:00:00-07:00' },
        PACIFIC,
        NOW,
      ),
    ).toBe('Today 6:30 PM – 8:00 PM');
  });

  it('normalizes a UTC-stamped event into the owner zone', () => {
    expect(
      ownerEventWhen({ start: '2026-09-16T22:45:00Z', end: '2026-09-16T23:30:00Z' }, PACIFIC, NOW),
    ).toBe('Tomorrow 3:45 PM – 4:30 PM');
  });

  it('spells out both ends when an event crosses local midnight', () => {
    expect(
      ownerEventWhen(
        { start: '2026-09-16T22:00:00-07:00', end: '2026-09-17T01:00:00-07:00' },
        PACIFIC,
        NOW,
      ),
    ).toBe('Tomorrow 10:00 PM → Thu, Sep 17 1:00 AM');
  });

  it('keeps an all-day event on its own date', () => {
    expect(ownerEventWhen({ start: '2026-09-16', allDay: true }, PACIFIC, NOW)).toBe(
      'Tomorrow (all day)',
    );
  });

  it('renders a start with no end', () => {
    expect(ownerEventWhen({ start: '2026-09-16T19:30:00-07:00' }, PACIFIC, NOW)).toBe(
      'Tomorrow 7:30 PM',
    );
  });

  it('passes an unparseable start through', () => {
    expect(ownerEventWhen({ start: 'sometime' }, PACIFIC, NOW)).toBe('sometime');
  });
});
