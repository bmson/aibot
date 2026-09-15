/**
 * Formatting for text the owner reads.
 *
 * These live in persistence — the one package that depends on nothing — because
 * every producer of owner-facing prose needs them: the briefing and the pulse in
 * core, the SMS and push channels in modules. Before this module each of those
 * formatted its own dates and cut its own strings, which is how a single digest
 * came to render half its events in the owner's timezone and half in UTC, and
 * how sentences reached the owner ending mid-word.
 *
 * Nothing here touches a database or a provider. It is pure text.
 */

/** A single glyph, so a truncation mark costs one character on a metered channel. */
const ELLIPSIS = '…';

/**
 * Flatten external text so it cannot break the structure it is spliced into.
 *
 * Calendar locations, mail subjects and model-written sentences all arrive with
 * newlines in them — a Google Calendar location is routinely "Venue\nStreet,
 * City". Interpolated into a markdown bullet, that newline ends the list item
 * and the address renders as its own top-level paragraph, detached from the
 * event it belongs to. Collapsing on the way in keeps a bullet a bullet.
 */
export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

/**
 * Shorten to `max` characters on a word boundary, marking that text was cut.
 *
 * A hard `slice` ends a sentence mid-word with no terminator, which reads as a
 * bug rather than as a summary and hides that anything was dropped at all. Falls
 * back to a hard cut only when a single word is itself longer than the budget.
 */
export function truncateAtBoundary(value: string, max: number): string {
  if (max <= 0) return '';
  const text = collapseWhitespace(value);
  if (text.length <= max) return text;
  const budget = max - ELLIPSIS.length;
  if (budget <= 0) return ELLIPSIS.slice(0, max);
  // One character past the budget, so a space landing exactly on the boundary
  // is still found and the whole preceding word is kept.
  const head = text.slice(0, budget + 1);
  const lastSpace = head.lastIndexOf(' ');
  const cut = lastSpace > 0 ? head.slice(0, lastSpace) : text.slice(0, budget);
  return `${cut.replace(/[\s,;:.–—-]+$/u, '')}${ELLIPSIS}`;
}

function parseInstant(value: string): Date | undefined {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** The calendar day an instant falls on in `timeZone`, as `YYYY-MM-DD`. */
function zonedDay(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/**
 * The day after `day`, computed on the date string rather than by adding 24
 * hours to an instant — a DST transition makes a local day 23 or 25 hours long,
 * and "tomorrow" must not depend on which.
 */
function dayAfter(day: string): string {
  const [year, month, date] = day.split('-').map(Number);
  if (!year || !month || !date) return day;
  const next = new Date(Date.UTC(year, month - 1, date));
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

/** Clock time in the owner's zone, e.g. `6:30 PM`. */
export function ownerTime(value: string, timeZone: string): string {
  const date = parseInstant(value);
  if (!date) return value;
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

/**
 * The day in the owner's zone, relative where that is what a person would say.
 * `Today`, `Tomorrow`, otherwise `Tue, Sep 15`.
 */
export function ownerDate(value: string, timeZone: string, now: Date = new Date()): string {
  const date = parseInstant(value);
  if (!date) return value;
  const day = zonedDay(date, timeZone);
  const today = zonedDay(now, timeZone);
  if (day === today) return 'Today';
  if (day === dayAfter(today)) return 'Tomorrow';
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

/** Day and clock time together, e.g. `Tomorrow 6:30 PM` or `Tue, Sep 15 6:30 PM`. */
export function ownerDateTime(value: string, timeZone: string, now: Date = new Date()): string {
  const date = parseInstant(value);
  if (!date) return value;
  return `${ownerDate(value, timeZone, now)} ${ownerTime(value, timeZone)}`;
}

export interface OwnerEventTime {
  /** RFC3339 instant, or `YYYY-MM-DD` for an all-day event. */
  start: string;
  end?: string;
  allDay?: boolean;
}

/**
 * One event's "when", in the owner's zone.
 *
 * An all-day event carries a bare date that `new Date` reads as midnight UTC, so
 * it is rendered from the date parts directly rather than shifted into a zone
 * that could move it onto the previous day.
 */
export function ownerEventWhen(
  event: OwnerEventTime,
  timeZone: string,
  now: Date = new Date(),
): string {
  if (event.allDay) {
    const day = event.start.slice(0, 10);
    const label = ownerDate(`${day}T12:00:00Z`, timeZone, now);
    return `${label} (all day)`;
  }
  const start = parseInstant(event.start);
  if (!start) return event.start;
  if (!event.end) return ownerDateTime(event.start, timeZone, now);
  const end = parseInstant(event.end);
  if (!end) return ownerDateTime(event.start, timeZone, now);
  // Same local day is the common case; repeating the date on both sides of the
  // dash is noise the owner has to read past.
  if (zonedDay(start, timeZone) === zonedDay(end, timeZone)) {
    return `${ownerDate(event.start, timeZone, now)} ${ownerTime(event.start, timeZone)} – ${ownerTime(event.end, timeZone)}`;
  }
  return `${ownerDateTime(event.start, timeZone, now)} → ${ownerDateTime(event.end, timeZone, now)}`;
}
