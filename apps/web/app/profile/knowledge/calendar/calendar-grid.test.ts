import { describe, expect, it } from 'vitest';
import {
  buildMonthGrid,
  MONTH_KEY_RE,
  monthKeyInTimeZone,
  monthTitle,
  shiftMonth,
  todayKeyInTimeZone,
  weekdayNames,
  weekStartForLocale,
} from '@/app/profile/knowledge/calendar/calendar-grid';

describe('month keys', () => {
  it('asks "what month is it" in the given zone, not the server zone', () => {
    // 2026-08-31 23:30 UTC is already 1 September in Auckland (UTC+12).
    const now = new Date('2026-08-31T23:30:00Z');
    expect(monthKeyInTimeZone(now, 'UTC')).toBe('2026-08');
    expect(monthKeyInTimeZone(now, 'Pacific/Auckland')).toBe('2026-09');
  });

  it('produces today keys on the same terms', () => {
    const now = new Date('2026-08-31T23:30:00Z');
    expect(todayKeyInTimeZone(now, 'UTC')).toBe('2026-08-31');
    expect(todayKeyInTimeZone(now, 'Pacific/Auckland')).toBe('2026-09-01');
  });

  it('shifts months across year boundaries without epoch math', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2025-12', 1)).toBe('2026-01');
    expect(shiftMonth('2026-08', 7)).toBe('2027-03');
    expect(shiftMonth('2026-08', -8)).toBe('2025-12');
  });

  it('titles a month in the owner locale', () => {
    expect(monthTitle('2026-08', 'en')).toBe('August 2026');
    expect(monthTitle('2026-08', 'is')).toContain('2026');
  });
});

describe('buildMonthGrid', () => {
  it('pads to whole weeks and only holds this month', () => {
    // August 2026 starts on a Saturday.
    const weeks = buildMonthGrid('2026-08', 1);
    for (const week of weeks) expect(week).toHaveLength(7);
    const days = weeks.flat().filter((cell) => cell.day !== null);
    expect(days).toHaveLength(31);
    expect(days[0]).toEqual({ day: '01', key: '2026-08-01' });
    expect(days[30]).toEqual({ day: '31', key: '2026-08-31' });
    // Monday-first: Saturday the 1st is the 6th cell of week one.
    expect(weeks[0]?.[5]?.key).toBe('2026-08-01');
  });

  it('honours a Sunday week start', () => {
    const weeks = buildMonthGrid('2026-08', 0);
    expect(weeks[0]?.[6]?.key).toBe('2026-08-01');
  });

  it('handles leap-year February', () => {
    const leap = buildMonthGrid('2024-02', 1);
    expect(leap.flat().filter((cell) => cell.day !== null)).toHaveLength(29);
    const plain = buildMonthGrid('2026-02', 1);
    expect(plain.flat().filter((cell) => cell.day !== null)).toHaveLength(28);
  });
});

describe('weekday presentation', () => {
  it('orders names from the chosen week start', () => {
    expect(weekdayNames('en', 1)[0]).toBe('Mon');
    expect(weekdayNames('en', 0)[0]).toBe('Sun');
    expect(weekdayNames('en', 6)).toHaveLength(7);
  });

  it('reads the locale convention when the runtime knows it', () => {
    // The actual day comes from the runtime's CLDR data, which differs across
    // environments (full-ICU vs small-ICU Node), so only the contract is
    // pinned here: a valid day index for real locales, Monday on garbage.
    for (const locale of ['en-US', 'en-GB', 'is']) {
      expect(weekStartForLocale(locale)).toBeGreaterThanOrEqual(0);
      expect(weekStartForLocale(locale)).toBeLessThanOrEqual(6);
    }
    expect(weekStartForLocale('!!')).toBe(1);
  });
});

describe('MONTH_KEY_RE', () => {
  it('accepts real months only, so it is safe inside a LIKE pattern', () => {
    expect(MONTH_KEY_RE.test('2026-08')).toBe(true);
    expect(MONTH_KEY_RE.test('2026-13')).toBe(false);
    expect(MONTH_KEY_RE.test('2026-00')).toBe(false);
    expect(MONTH_KEY_RE.test('2026-8')).toBe(false);
    expect(MONTH_KEY_RE.test('%')).toBe(false);
    expect(MONTH_KEY_RE.test('')).toBe(false);
  });
});
