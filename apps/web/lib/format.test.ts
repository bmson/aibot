import { describe, expect, it } from 'vitest';
import { formatFriendlyDateTime, relativeTime, truncate } from './format';

// A fixed "now": 2026-07-22 21:30 UTC = 2026-07-22 14:30 in Los Angeles.
const NOW = new Date('2026-07-22T21:30:00Z');
const LA = 'America/Los_Angeles';

describe('formatFriendlyDateTime', () => {
  it('renders same-day times as Today', () => {
    expect(formatFriendlyDateTime(new Date('2026-07-22T16:41:00Z'), LA, NOW)).toBe('Today 9:41 AM');
  });

  it('renders the previous calendar day as Yesterday', () => {
    expect(formatFriendlyDateTime(new Date('2026-07-21T23:02:00Z'), LA, NOW)).toBe(
      'Yesterday 4:02 PM',
    );
  });

  it('respects the timezone when bucketing days', () => {
    // 2026-07-22 02:15 UTC is still 2026-07-21 in Los Angeles — Yesterday there,
    // but Today in UTC.
    const lateNight = new Date('2026-07-22T02:15:00Z');
    expect(formatFriendlyDateTime(lateNight, LA, NOW)).toBe('Yesterday 7:15 PM');
    expect(formatFriendlyDateTime(lateNight, 'UTC', NOW)).toBe('Today 2:15 AM');
  });

  it('renders same-year dates without the year', () => {
    expect(formatFriendlyDateTime(new Date('2026-07-15T16:41:00Z'), LA, NOW)).toBe(
      'Jul 15 · 9:41 AM',
    );
  });

  it('includes the year for other years', () => {
    expect(formatFriendlyDateTime(new Date('2025-07-15T16:41:00Z'), LA, NOW)).toBe(
      'Jul 15, 2025 · 9:41 AM',
    );
  });

  it('falls back to UTC without a timezone, matching formatDateTime behavior', () => {
    expect(formatFriendlyDateTime(new Date('2026-01-03T08:05:00Z'), undefined, NOW)).toBe(
      'Jan 3 · 8:05 AM',
    );
  });
});

describe('existing helpers stay stable', () => {
  it('relativeTime rounds to the nearest unit', () => {
    expect(relativeTime(new Date(NOW.getTime() - 3 * 60_000), NOW)).toBe('3m ago');
  });

  it('truncate appends a single ellipsis character', () => {
    expect(truncate('abcdef', 4)).toBe('abc…');
  });
});
