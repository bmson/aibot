import { contacts, type Db, type OccasionRow, occasions } from '@assistant/db';
import { and, asc, eq, sql } from 'drizzle-orm';

/**
 * Occasions (Phase 17): recurring dates tied to a contact (birthdays,
 * anniversaries, custom). Stored as month/day so annual dates recur without a
 * year; the "next occurrence" and lead-time surfacing are computed here.
 */

export type OccasionKind = 'birthday' | 'anniversary' | 'custom';
export type OccasionRecurrence = 'annual' | 'once';

const OCCASION_KINDS: ReadonlySet<string> = new Set(['birthday', 'anniversary', 'custom']);
export function isOccasionKind(value: unknown): value is OccasionKind {
  return typeof value === 'string' && OCCASION_KINDS.has(value);
}

/** Clamp a day to a plausible value; the DB check also enforces 1–31. */
function validMonthDay(month: number, day: number): boolean {
  return (
    Number.isInteger(month) &&
    Number.isInteger(day) &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= 31
  );
}

/** Date-only "today" in UTC — occasions are day-granular, so time-of-day is irrelevant. */
function utcToday(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** The next annual occurrence of month/day on or after today. */
export function nextAnnualOccurrence(month: number, day: number, now: Date): Date {
  const today = utcToday(now);
  let occurrence = new Date(Date.UTC(now.getUTCFullYear(), month - 1, day));
  if (occurrence.getTime() < today.getTime()) {
    occurrence = new Date(Date.UTC(now.getUTCFullYear() + 1, month - 1, day));
  }
  return occurrence;
}

/** Whole days from today until the occasion's next occurrence (negative = past, for 'once'). */
export function daysUntilOccurrence(
  occasion: Pick<OccasionRow, 'month' | 'day' | 'year' | 'recurrence'>,
  now: Date,
): number {
  const today = utcToday(now);
  const next =
    occasion.recurrence === 'once' && occasion.year !== null
      ? new Date(Date.UTC(occasion.year, occasion.month - 1, occasion.day))
      : nextAnnualOccurrence(occasion.month, occasion.day, now);
  return Math.round((next.getTime() - today.getTime()) / 86_400_000);
}

export interface UpcomingOccasion {
  id: string;
  contactId: string;
  contactName: string;
  kind: string;
  label: string;
  month: number;
  day: number;
  year: number | null;
  leadDays: number;
  notes: string;
  daysUntil: number;
  /** ISO date (YYYY-MM-DD) of the next occurrence. */
  nextDate: string;
}

/**
 * Occasions coming up within their lead window (or an explicit `withinDays`),
 * soonest first. Quarantined occasions never surface. Joined to the contact so
 * callers get a name to show without a second query.
 */
export async function upcomingOccasions(
  db: Db,
  agentId: string,
  opts: { withinDays?: number; now?: Date } = {},
): Promise<UpcomingOccasion[]> {
  const now = opts.now ?? new Date();
  const rows = await db
    .select({
      id: occasions.id,
      contactId: occasions.contactId,
      contactName: contacts.name,
      kind: occasions.kind,
      label: occasions.label,
      month: occasions.month,
      day: occasions.day,
      year: occasions.year,
      recurrence: occasions.recurrence,
      leadDays: occasions.leadDays,
      notes: occasions.notes,
    })
    .from(occasions)
    .innerJoin(contacts, eq(contacts.id, occasions.contactId))
    .where(and(eq(occasions.agentId, agentId), eq(occasions.quarantined, false)));

  const upcoming: UpcomingOccasion[] = [];
  for (const row of rows) {
    const daysUntil = daysUntilOccurrence(row, now);
    const window = opts.withinDays ?? row.leadDays;
    if (daysUntil < 0 || daysUntil > window) continue;
    const next =
      row.recurrence === 'once' && row.year !== null
        ? new Date(Date.UTC(row.year, row.month - 1, row.day))
        : nextAnnualOccurrence(row.month, row.day, now);
    upcoming.push({
      id: row.id,
      contactId: row.contactId,
      contactName: row.contactName,
      kind: row.kind,
      label: row.label,
      month: row.month,
      day: row.day,
      year: row.year,
      leadDays: row.leadDays,
      notes: row.notes,
      daysUntil,
      nextDate: next.toISOString().slice(0, 10),
    });
  }
  return upcoming.sort((a, b) => a.daysUntil - b.daysUntil);
}

/** Every occasion for one contact, soonest annual date first (for the Profile page). */
export async function listOccasionsForContact(db: Db, contactId: string): Promise<OccasionRow[]> {
  return db
    .select()
    .from(occasions)
    .where(eq(occasions.contactId, contactId))
    .orderBy(asc(occasions.month), asc(occasions.day));
}

export interface SaveOccasionInput {
  agentId: string;
  contactId: string;
  kind: OccasionKind;
  label?: string;
  month: number;
  day: number;
  year?: number | null;
  recurrence?: OccasionRecurrence;
  leadDays?: number;
  notes?: string;
  originTrust?: string;
  quarantined?: boolean;
  ownerConfirmed?: boolean;
  source?: string;
}

/**
 * Insert an occasion, idempotent on (agent, contact, kind, month, day). A repeat
 * for the same date is a no-op EXCEPT that new notes are merged and a
 * previously-unknown year is filled in — so re-mentioning a birthday to add a
 * gift idea updates the existing row rather than being dropped.
 */
export async function saveOccasion(
  db: Db,
  input: SaveOccasionInput,
): Promise<{ saved: boolean; occasion: OccasionRow }> {
  if (!isOccasionKind(input.kind)) throw new Error(`invalid occasion kind: ${input.kind}`);
  if (!validMonthDay(input.month, input.day)) {
    throw new Error(`invalid occasion date: month ${input.month}, day ${input.day}`);
  }
  const notes = (input.notes ?? '').trim().slice(0, 2000);
  const [row] = await db
    .insert(occasions)
    .values({
      agentId: input.agentId,
      contactId: input.contactId,
      kind: input.kind,
      label: (input.label ?? '').slice(0, 120),
      month: input.month,
      day: input.day,
      year: input.year ?? null,
      recurrence: input.recurrence ?? 'annual',
      leadDays: input.leadDays ?? 7,
      notes,
      originTrust: input.originTrust ?? 'owner',
      quarantined: input.quarantined ?? false,
      ownerConfirmed: input.ownerConfirmed ?? false,
      source: input.source,
    })
    .onConflictDoUpdate({
      target: [
        occasions.agentId,
        occasions.contactId,
        occasions.kind,
        occasions.month,
        occasions.day,
      ],
      set: {
        // Fill a previously-unknown year; append genuinely new notes; never
        // downgrade trust or re-quarantine an already-reviewed occasion.
        year: sql`coalesce(${occasions.year}, excluded.year)`,
        notes: sql`case
          when ${occasions.notes} = '' then excluded.notes
          when excluded.notes = '' or position(excluded.notes in ${occasions.notes}) > 0 then ${occasions.notes}
          else ${occasions.notes} || '; ' || excluded.notes end`,
        updatedAt: sql`now()`,
      },
    })
    .returning();
  if (!row) throw new Error('occasion upsert failed');
  // `saved` is true when this created a new row (createdAt == updatedAt on insert).
  return { saved: row.createdAt.getTime() === row.updatedAt.getTime(), occasion: row };
}
