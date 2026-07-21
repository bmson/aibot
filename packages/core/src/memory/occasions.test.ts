import { contacts, createDb, type Db, occasions } from '@assistant/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAgent } from '../chat.js';
import {
  daysUntilOccurrence,
  listOccasionsForContact,
  nextAnnualOccurrence,
  saveOccasion,
  upcomingOccasions,
} from './occasions.js';

// ── Pure date math ───────────────────────────────────────────────────────────

describe('occasion date math', () => {
  const now = new Date('2026-03-01T12:00:00Z');

  it('nextAnnualOccurrence uses this year when still upcoming, next year when past', () => {
    expect(nextAnnualOccurrence(3, 5, now).toISOString().slice(0, 10)).toBe('2026-03-05');
    // Feb 1 has already passed on Mar 1 → rolls to next year.
    expect(nextAnnualOccurrence(2, 1, now).toISOString().slice(0, 10)).toBe('2027-02-01');
    // Today counts as upcoming (0 days away), not last year.
    expect(nextAnnualOccurrence(3, 1, now).toISOString().slice(0, 10)).toBe('2026-03-01');
  });

  it('daysUntilOccurrence counts whole days to the next annual occurrence', () => {
    expect(daysUntilOccurrence({ month: 3, day: 5, year: null, recurrence: 'annual' }, now)).toBe(
      4,
    );
    expect(daysUntilOccurrence({ month: 3, day: 1, year: null, recurrence: 'annual' }, now)).toBe(
      0,
    );
  });
});

// ── Store (integration) ──────────────────────────────────────────────────────

describe('occasions store (integration)', () => {
  let db: Db;
  let dbUp = false;
  let agentId: string;
  let contactId: string;
  const contactName = `xtest-occasion-person-${Date.now()}`;

  beforeAll(async () => {
    db = createDb(
      process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant',
    );
    try {
      agentId = (await getAgent(db)).id;
      const [contact] = await db
        .insert(contacts)
        .values({ name: contactName, relationship: 'friend', trust: 'known' })
        .returning({ id: contacts.id });
      contactId = contact?.id ?? '';
      dbUp = true;
    } catch {
      console.warn('occasions.test: database unreachable — skipping integration');
    }
  });

  afterAll(async () => {
    if (dbUp) {
      await db.delete(occasions).where(eq(occasions.contactId, contactId));
      await db.delete(contacts).where(eq(contacts.id, contactId));
    }
    await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
  });

  it('saves an occasion, then dedupes on re-save — merging notes and filling the year', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const first = await saveOccasion(db, {
      agentId,
      contactId,
      kind: 'birthday',
      month: 5,
      day: 20,
    });
    expect(first.saved).toBe(true);
    expect(first.occasion.notes).toBe('');

    // Same date again with a note + year → updates the existing row, not a new one.
    const second = await saveOccasion(db, {
      agentId,
      contactId,
      kind: 'birthday',
      month: 5,
      day: 20,
      year: 1990,
      notes: 'likes gardening tools',
    });
    expect(second.saved).toBe(false);
    expect(second.occasion.id).toBe(first.occasion.id);
    expect(second.occasion.year).toBe(1990);
    expect(second.occasion.notes).toBe('likes gardening tools');

    const all = await listOccasionsForContact(db, contactId);
    expect(all).toHaveLength(1);
  });

  it('upcomingOccasions surfaces within the lead window, excludes quarantined, sorts soonest-first', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const now = new Date('2026-06-01T12:00:00Z');
    // Soon (5 days out), lead 7 → surfaces.
    await saveOccasion(db, {
      agentId,
      contactId,
      kind: 'anniversary',
      month: 6,
      day: 6,
      leadDays: 7,
    });
    // Far (whole year away for this contact's birthday May 20 → ~353 days), lead 7 → hidden.
    // (the birthday row from the prior test already exists)
    // Quarantined + soon → still hidden.
    await saveOccasion(db, {
      agentId,
      contactId,
      kind: 'custom',
      label: 'quarantined-soon',
      month: 6,
      day: 3,
      leadDays: 7,
      quarantined: true,
      originTrust: 'unknown',
    });

    const upcoming = await upcomingOccasions(db, agentId, { now });
    const mine = upcoming.filter((o) => o.contactId === contactId);
    expect(mine.map((o) => o.kind)).toEqual(['anniversary']); // birthday too far, custom quarantined
    expect(mine[0]?.daysUntil).toBe(5);

    // A wider explicit window pulls in the birthday too, still soonest-first.
    const wide = (await upcomingOccasions(db, agentId, { now, withinDays: 366 })).filter(
      (o) => o.contactId === contactId,
    );
    expect(wide.map((o) => o.kind)).toEqual(['anniversary', 'birthday']);
    expect(wide.every((o) => o.kind !== 'custom')).toBe(true); // quarantined never surfaces
  });
});
