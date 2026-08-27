import { MONTH_ALT, MONTH_NAMES, validMonthDay } from './occasions.js';

/**
 * Canonical identity for a date mentioned in a memory.
 *
 * Date entities used to be whatever wording the extractor produced. Because an
 * entity's identity is a hash of its normalized label, "Friday", "next Friday"
 * and "2026-03-06" became three permanent, unmergeable nodes — and the sidebar
 * read like a transcript of the model's phrasing rather than a set of dates.
 *
 * Everything here is deterministic and offline. Relative wording resolves
 * against the *source memory's* timestamp, not the current time: "Friday" meant
 * a specific day when the fact was recorded, and anchoring on that keeps a
 * re-extraction of the same memory landing on the same node forever.
 */

export interface CanonicalDate {
  /** Stable identity: `2026-03-06`, `2026-03`, `--03-06`, or `2026`. */
  key: string;
  /** Owner-facing wording, formatted in the agent's locale. */
  label: string;
  /** How much of a calendar date is actually known. */
  precision: 'day' | 'month' | 'year' | 'recurring';
}

const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};
const WEEKDAY_ALT = Object.keys(WEEKDAYS).join('|');

const DAY_MS = 86_400_000;
/** Years outside this band are far likelier to be a quantity than a date. */
const MIN_YEAR = 1000;
const MAX_YEAR = 2999;

const ISO_DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_MONTH_RE = /^(\d{4})-(\d{2})$/;
const ISO_RECURRING_RE = /^--(\d{2})-(\d{2})$/;
const YEAR_RE = /^(\d{4})$/;
const MONTH_YEAR_RE = new RegExp(`^(${MONTH_ALT})\\s+(\\d{4})$`);
const DAY_MONTH_YEAR_RE = new RegExp(
  `^(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_ALT})(?:,?\\s+(\\d{4}))?$`,
);
const MONTH_DAY_YEAR_RE = new RegExp(
  `^(${MONTH_ALT})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?$`,
);
const NUMERIC_DAY_RE = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/;
const WEEKDAY_RE = new RegExp(`^(?:(next|last|this|coming|past)\\s+)?(${WEEKDAY_ALT})$`);
const OFFSET_WORD_RE = /^(next|last|this)\s+(week|month|year)$/;

/** The anchor's calendar date in the agent's zone, as a date-only UTC value. */
function zonedDay(anchor: Date, timeZone: string): Date {
  const formatted = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(anchor);
  const [year, month, day] = formatted.split('-').map(Number);
  return new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1));
}

function utcDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

/** Rejects impossible calendar dates ("31 February") rather than rolling them. */
function realDate(year: number, month: number, day: number): Date | null {
  if (!validMonthDay(month, day) || year < MIN_YEAR || year > MAX_YEAR) return null;
  const date = utcDate(year, month, day);
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null;
}

function formatDay(date: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(date);
}

function dayResult(date: Date, locale: string): CanonicalDate {
  return {
    key: date.toISOString().slice(0, 10),
    label: formatDay(date, locale),
    precision: 'day',
  };
}

function monthResult(year: number, month: number, locale: string): CanonicalDate {
  return {
    key: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`,
    label: new Intl.DateTimeFormat(locale, {
      timeZone: 'UTC',
      year: 'numeric',
      month: 'long',
    }).format(utcDate(year, month, 1)),
    precision: 'month',
  };
}

/**
 * A month/day with no year — a birthday, an anniversary, a recurring date.
 *
 * Validated against a real leap-year calendar date rather than the loose 1-31
 * day check: "February 31" passes that check, and formatting it rolls the
 * display into March, producing a key and a label naming different days — which
 * would then never merge with the real March date. 2024 is the reference year
 * because it is the only way 29 February can be legitimate.
 */
function recurringResult(month: number, day: number, locale: string): CanonicalDate | null {
  const reference = realDate(2024, month, day);
  if (!reference) return null;
  return {
    key: `--${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    label: new Intl.DateTimeFormat(locale, {
      timeZone: 'UTC',
      month: 'long',
      day: 'numeric',
    }).format(reference),
    precision: 'recurring',
  };
}

function yearResult(year: number): CanonicalDate {
  return { key: String(year), label: String(year), precision: 'year' };
}

/**
 * Weekday arithmetic. "Friday" and "this Friday" mean the first Friday on or
 * after the anchor day; "next Friday" the first one strictly after it; "last
 * Friday" the most recent one before it. English is genuinely ambiguous about
 * "next Friday" said on a Wednesday, and no reading of it is universally right
 * — this picks the one that never resolves into the past.
 */
function weekdayDate(anchorDay: Date, weekday: number, qualifier: string | undefined): Date {
  const current = anchorDay.getUTCDay();
  if (qualifier === 'last' || qualifier === 'past') {
    const back = ((current - weekday + 7 - 1) % 7) + 1;
    return new Date(anchorDay.getTime() - back * DAY_MS);
  }
  const forwardInclusive = (weekday - current + 7) % 7;
  const strict = qualifier === 'next' || qualifier === 'coming';
  const forward = strict && forwardInclusive === 0 ? 7 : forwardInclusive;
  return new Date(anchorDay.getTime() + forward * DAY_MS);
}

/**
 * Reduce a date label to a canonical identity, or null when the wording does
 * not denote a date this can pin down. Returning null is deliberate: a node
 * called "some point next quarter" is worse than no node, because it is
 * permanent, unmergeable, and indistinguishable from a real date in recall.
 */
export function canonicalizeDateLabel(
  raw: string,
  anchor: Date,
  timeZone = 'UTC',
  locale = 'en',
): CanonicalDate | null {
  const text = raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/[.]+$/, '')
    .replace(/^(?:on|the)\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;

  const iso = ISO_DAY_RE.exec(text);
  if (iso) {
    const date = realDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    return date ? dayResult(date, locale) : null;
  }

  // Unambiguous only with a leading 4-digit year; 03/04/2026 is a different day
  // either side of the Atlantic, so it is left unresolved rather than guessed.
  const numeric = NUMERIC_DAY_RE.exec(text);
  if (numeric) {
    const date = realDate(Number(numeric[1]), Number(numeric[2]), Number(numeric[3]));
    return date ? dayResult(date, locale) : null;
  }

  const isoMonth = ISO_MONTH_RE.exec(text);
  if (isoMonth) {
    const year = Number(isoMonth[1]);
    const month = Number(isoMonth[2]);
    return month >= 1 && month <= 12 && year >= MIN_YEAR && year <= MAX_YEAR
      ? monthResult(year, month, locale)
      : null;
  }

  // Already-canonical recurring keys round-trip, so re-running the backfill over
  // its own output is a no-op rather than a second interpretation.
  const isoRecurring = ISO_RECURRING_RE.exec(text);
  if (isoRecurring) {
    const month = Number(isoRecurring[1]);
    const day = Number(isoRecurring[2]);
    return recurringResult(month, day, locale);
  }

  const year = YEAR_RE.exec(text);
  if (year) {
    const value = Number(year[1]);
    return value >= MIN_YEAR && value <= MAX_YEAR ? yearResult(value) : null;
  }

  // Checked before "month day", so "march 2026" is a month and not the 2026th.
  const monthYear = MONTH_YEAR_RE.exec(text);
  if (monthYear) {
    const month = MONTH_NAMES[monthYear[1] as string];
    const value = Number(monthYear[2]);
    return month && value >= MIN_YEAR && value <= MAX_YEAR
      ? monthResult(value, month, locale)
      : null;
  }

  const dayMonth = DAY_MONTH_YEAR_RE.exec(text);
  if (dayMonth) {
    const month = MONTH_NAMES[dayMonth[2] as string];
    const day = Number(dayMonth[1]);
    if (!month) return null;
    if (dayMonth[3]) {
      const date = realDate(Number(dayMonth[3]), month, day);
      return date ? dayResult(date, locale) : null;
    }
    return recurringResult(month, day, locale);
  }

  const monthDay = MONTH_DAY_YEAR_RE.exec(text);
  if (monthDay) {
    const month = MONTH_NAMES[monthDay[1] as string];
    const day = Number(monthDay[2]);
    if (!month) return null;
    if (monthDay[3]) {
      const date = realDate(Number(monthDay[3]), month, day);
      return date ? dayResult(date, locale) : null;
    }
    return recurringResult(month, day, locale);
  }

  const anchorDay = zonedDay(anchor, timeZone);

  if (text === 'today') return dayResult(anchorDay, locale);
  if (text === 'tomorrow') return dayResult(new Date(anchorDay.getTime() + DAY_MS), locale);
  if (text === 'yesterday') return dayResult(new Date(anchorDay.getTime() - DAY_MS), locale);

  const weekday = WEEKDAY_RE.exec(text);
  if (weekday) {
    const index = WEEKDAYS[weekday[2] as string];
    if (index === undefined) return null;
    return dayResult(weekdayDate(anchorDay, index, weekday[1]), locale);
  }

  const offset = OFFSET_WORD_RE.exec(text);
  if (offset) {
    const direction = offset[1] === 'last' ? -1 : offset[1] === 'next' ? 1 : 0;
    if (offset[2] === 'week') {
      // A week is not a day, but the whole week is anchored by its Monday, which
      // is a date the graph can hold and merge on. That Monday has to be found
      // *inclusively* — asking weekdayDate for "last Monday" on a Monday walks
      // back a full week, which shifted every week offset one week early.
      const backToMonday = (anchorDay.getUTCDay() - 1 + 7) % 7;
      const monday = anchorDay.getTime() - backToMonday * DAY_MS;
      return dayResult(new Date(monday + direction * 7 * DAY_MS), locale);
    }
    if (offset[2] === 'month') {
      const month = anchorDay.getUTCMonth() + direction;
      const shifted = new Date(Date.UTC(anchorDay.getUTCFullYear(), month, 1));
      return monthResult(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, locale);
    }
    return yearResult(anchorDay.getUTCFullYear() + direction);
  }

  return null;
}
