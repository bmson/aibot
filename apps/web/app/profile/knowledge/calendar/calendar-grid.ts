/**
 * Pure calendar math for the knowledge-calendar page. Kept free of server and
 * package imports so it unit-tests without a DOM and could be read by a client
 * component without crossing the architecture boundary.
 *
 * All month arithmetic runs on calendar fields (year, month, day), never on
 * epoch milliseconds: a month is not a fixed number of seconds, and the repo
 * has been bitten by UTC-vs-local rendering before (lib/format.ts).
 */

/** `YYYY-MM`, the only month string the page and query accept. */
export const MONTH_KEY_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** "What month is it?" has to be asked in the assistant's zone, not the server's. */
export function monthKeyInTimeZone(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
  }).format(now);
}

/** Today's full `YYYY-MM-DD` key in the assistant's zone, for cell highlighting. */
export function todayKeyInTimeZone(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** `shiftMonth('2026-01', -1)` → `'2025-12'`. Delta is in whole months. */
export function shiftMonth(month: string, delta: number): string {
  const [year = 1970, monthNumber = 1] = month.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, monthNumber - 1 + delta, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** "August 2026" in the owner's locale. */
export function monthTitle(month: string, locale: string): string {
  const [year = 1970, monthNumber = 1] = month.split('-').map(Number);
  return new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'long',
  }).format(new Date(Date.UTC(year, monthNumber - 1, 1)));
}

/**
 * First column of the grid, 0 = Sunday .. 6 = Saturday. `Intl.Locale.weekInfo`
 * knows the owner's convention (Sunday in the US, Monday in most of Europe).
 * The answer depends on the runtime's CLDR data, so callers must not assume a
 * specific locale maps to a specific day everywhere; Monday is the documented
 * fallback where the runtime predates the API or cannot parse the locale.
 */
export function weekStartForLocale(locale: string): number {
  try {
    const info = new Intl.Locale(locale) as unknown as {
      getWeekInfo?: () => { firstDay: number };
    };
    const firstDay = info.getWeekInfo?.().firstDay;
    // Intl numbers days Monday=1 .. Sunday=7; Date numbers Sunday=0.
    return firstDay === 7 ? 0 : (firstDay ?? 1);
  } catch {
    return 1;
  }
}

/** Narrow weekday headers ordered for the grid, e.g. ['Mon', 'Tue', …]. */
export function weekdayNames(locale: string, weekStart: number): string[] {
  // 2024-01-07 was a Sunday, so adding an index walks the week in order.
  return Array.from({ length: 7 }, (_, index) =>
    new Intl.DateTimeFormat(locale, { timeZone: 'UTC', weekday: 'short' }).format(
      new Date(Date.UTC(2024, 0, 7 + ((weekStart + index) % 7))),
    ),
  );
}

export interface CalendarCell {
  /** Two-digit day of the month, or null for a padding cell. */
  day: string | null;
  /** Full `YYYY-MM-DD` key, or null for a padding cell. */
  key: string | null;
}

/**
 * The month as weeks of seven cells, padded with nulls at both ends. Adjacent
 * months' days are deliberately not filled in: a padded-out day that holds no
 * graph data reads as an empty promise, and clicking through is what prev/next
 * controls are for.
 */
export function buildMonthGrid(month: string, weekStart: number): CalendarCell[][] {
  const [year = 1970, monthNumber = 1] = month.split('-').map(Number);
  // Day 0 of the following month is this month's last day.
  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const firstWeekday = new Date(Date.UTC(year, monthNumber - 1, 1)).getUTCDay();
  const lead = (firstWeekday - weekStart + 7) % 7;

  const cells: CalendarCell[] = [];
  for (let index = 0; index < lead; index += 1) cells.push({ day: null, key: null });
  for (let day = 1; day <= daysInMonth; day += 1) {
    const dayKey = String(day).padStart(2, '0');
    cells.push({ day: dayKey, key: `${month}-${dayKey}` });
  }
  while (cells.length % 7 !== 0) cells.push({ day: null, key: null });

  const weeks: CalendarCell[][] = [];
  for (let index = 0; index < cells.length; index += 7) {
    weeks.push(cells.slice(index, index + 7));
  }
  return weeks;
}
