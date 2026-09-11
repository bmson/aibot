import {
  calendarEventSnapshots,
  conversations,
  createDb,
  type Db,
  emailIngest,
  messages,
  notificationPrefs,
  proactiveMoments,
  suggestions,
} from '@assistant/db';
import { eq, like } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getAgent } from '../chat.js';
import type { BriefingCalendarEvent } from '../workflow/briefing.js';
import { attendeeResponseDigest } from './calendar-diff.js';
import type { EventSalience } from './calendar-salience.js';
import { eventLeadMoments, type PulseMoment, runPulse, selectPulseMoment } from './pulse.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';
const MARKER = `xtest-pulse-${Date.now()}`;

const NOW = new Date('2026-03-04T09:00:00Z');

function salient(
  over: Partial<EventSalience['event']> = {},
  reasons: string[] = [],
): EventSalience {
  return {
    event: {
      summary: 'Dentist',
      start: '2026-03-04T09:20:00Z',
      end: '2026-03-04T10:00:00Z',
      calendar: 'Personal',
      allDay: false,
      eventId: 'evt-1',
      ...over,
    },
    score: 5,
    reasons,
  };
}

describe('selectPulseMoment', () => {
  const moment = (over: Partial<PulseMoment>): PulseMoment => ({
    kind: 'commitment-due',
    key: 'k',
    text: 't',
    priority: 1,
    card: {
      kind: 'proactive-alert',
      id: 'k',
      category: 'commitment',
      urgencyLabel: 'Due soon',
      title: 'Test commitment',
    },
    ...over,
  });

  it('says nothing when there is nothing to say', () => {
    expect(selectPulseMoment([])).toBeNull();
  });

  it('delivers exactly one thing, the most urgent', () => {
    const picked = selectPulseMoment([
      moment({ key: 'a', priority: 10 }),
      moment({ key: 'b', priority: 100 }),
      moment({ key: 'c', priority: 50 }),
    ]);
    expect(picked?.key).toBe('b');
  });

  it('breaks ties deterministically, so concurrent sweeps agree', () => {
    const tied = [moment({ key: 'z', priority: 5 }), moment({ key: 'a', priority: 5 })];
    expect(selectPulseMoment(tied)?.key).toBe('a');
    expect(selectPulseMoment([...tied].reverse())?.key).toBe('a');
  });
});

describe('eventLeadMoments', () => {
  it('nudges inside the desk lead time but not before it', () => {
    expect(eventLeadMoments([salient({ start: '2026-03-04T09:10:00Z' })], NOW)).toHaveLength(1);
    expect(eventLeadMoments([salient({ start: '2026-03-04T09:40:00Z' })], NOW)).toHaveLength(0);
  });

  it('names the place once and drops a reason that only repeats it', () => {
    // The headline already carries the address. Salience still needs the
    // `it is at …` marker to pick the travel lead time, but the owner should
    // not read the same street twice in one sentence.
    const travelling = salient({ start: '2026-03-04T09:35:00Z', location: 'Laugavegur 12' }, [
      'it is at Laugavegur 12',
      'it falls outside your usual hours',
    ]);
    const text = eventLeadMoments([travelling], NOW)[0]?.text ?? '';
    expect(text.match(/Laugavegur 12/g)).toHaveLength(1);
    expect(text).not.toContain('it is at');
    expect(text).toContain('it falls outside your usual hours');
  });

  it('leaves no dangling full stop when the place was the only reason', () => {
    const travelling = salient({ start: '2026-03-04T09:35:00Z', location: 'Laugavegur 12' }, [
      'it is at Laugavegur 12',
    ]);
    expect(eventLeadMoments([travelling], NOW)[0]?.text).toBe(
      '"Dentist" starts in 35 minutes at Laugavegur 12.',
    );
  });

  it('allows a longer lead when the event means travelling', () => {
    const travelling = salient({ start: '2026-03-04T09:35:00Z', location: 'Laugavegur 12' }, [
      'it is at Laugavegur 12',
    ]);
    const found = eventLeadMoments([travelling], NOW);
    expect(found).toHaveLength(1);
    expect(found[0]?.text).toContain('Laugavegur 12');
    expect(found[0]?.card).toMatchObject({
      kind: 'proactive-alert',
      category: 'event',
      urgencyLabel: 'Starts in 35 min',
      title: 'Dentist',
      details: [
        { label: 'Location', value: 'Laugavegur 12' },
        { label: 'Calendar', value: 'Personal' },
      ],
    });
  });

  it('ignores all-day entries and anything already started', () => {
    expect(eventLeadMoments([salient({ allDay: true })], NOW)).toHaveLength(0);
    expect(eventLeadMoments([salient({ start: '2026-03-04T08:50:00Z' })], NOW)).toHaveLength(0);
  });

  it('keys on the start time so a moved event earns a fresh nudge', () => {
    const [first] = eventLeadMoments([salient({ start: '2026-03-04T09:10:00Z' })], NOW);
    const [moved] = eventLeadMoments([salient({ start: '2026-03-04T09:12:00Z' })], NOW);
    expect(first?.key).not.toBe(moved?.key);
  });
});

describe('runPulse', () => {
  let db: Db;
  let dbUp = false;
  let agentId: string;
  let conversationId: string;

  beforeAll(async () => {
    db = createDb(DATABASE_URL);
    try {
      agentId = (await getAgent(db)).id;
      dbUp = true;
    } catch {
      console.warn('pulse.test: database unreachable — skipping');
      return;
    }
    const [conv] = await db
      .insert(conversations)
      .values({ agentId, channel: 'email', trust: 'unknown', title: `${MARKER} thread` })
      .returning();
    conversationId = (conv as NonNullable<typeof conv>).id;
  });

  afterEach(async () => {
    if (!dbUp) return;
    await db.delete(proactiveMoments).where(like(proactiveMoments.momentKey, `%${MARKER}%`));
    await db.delete(suggestions).where(like(suggestions.sourceRef, `%${MARKER}%`));
    await db.delete(emailIngest).where(like(emailIngest.channelMessageId, `%${MARKER}%`));
    await db.delete(messages).where(like(messages.text, `%${MARKER}%`));
    await db
      .delete(calendarEventSnapshots)
      .where(like(calendarEventSnapshots.eventId, `%${MARKER}%`));
  });

  afterAll(async () => {
    if (!dbUp) return;
    await db.delete(conversations).where(eq(conversations.id, conversationId));
  });

  async function addActionableMail(id: string) {
    await db.insert(emailIngest).values({
      agentId,
      conversationId,
      channelMessageId: `gmail:${MARKER}-${id}`,
      fromEmail: 'clinic@hospital.example',
      subject: `${MARKER} your appointment needs confirming`,
      contentTrust: 'unknown',
      authenticated: true,
      category: 'appointment',
      importance: 5,
      actionable: true,
      reason: 'asks you to confirm by Friday',
    });
  }

  it('stays quiet when nothing is live', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const result = await runPulse({ db }, { now: NOW });
    expect(result.delivered).toBeNull();
    expect(result.heldBy).toBe('no-candidates');
  });

  it('surfaces actionable mail with a suggestion and pings once', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await addActionableMail('mail-1');
    const pings: string[] = [];
    const result = await runPulse(
      {
        db,
        notifyOwner: async ({ text, urgency }) => {
          expect(urgency).toBe('ambient');
          pings.push(text);
        },
      },
      { now: NOW },
    );
    expect(result.delivered).toBe('mail-action');
    expect(result.suggested).toBe(true);
    expect(result.pinged).toBe(true);
    expect(pings).toHaveLength(1);

    const posted = await db
      .select({ text: messages.text, parts: messages.parts })
      .from(messages)
      .where(like(messages.text, `%${MARKER}%your appointment%`));
    expect(posted.length).toBeGreaterThan(0);
    expect(posted[0]?.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'data-card',
          data: expect.objectContaining({
            kind: 'proactive-alert',
            category: 'email',
            urgencyLabel: 'Needs a reply',
          }),
        }),
      ]),
    );
  });

  it('never says the same moment twice, and respects the minimum gap', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await addActionableMail('mail-2');
    const first = await runPulse({ db }, { now: NOW });
    expect(first.delivered).toBe('mail-action');

    // Immediately after: the hourly gap holds it, whatever it found.
    const second = await runPulse({ db }, { now: new Date(NOW.getTime() + 60_000) });
    expect(second.delivered).toBeNull();
    expect(second.heldBy).toBe('min-gap');

    // Past the gap, the same moment is already spent — the fence, not the pacing.
    const third = await runPulse({ db }, { now: new Date(NOW.getTime() + 2 * 3600_000) });
    expect(third.delivered).toBeNull();
    expect(third.heldBy).toBe('already-said');
  });

  it('holds everything once the daily ceiling is reached', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await addActionableMail('mail-3');
    const result = await runPulse({ db }, { now: NOW, dailyCap: 0 });
    expect(result.delivered).toBeNull();
    expect(result.heldBy).toBe('daily-cap');
  });

  it('lets the owner tighten the ceiling with the limit they already set', async (ctx) => {
    if (!dbUp) return ctx.skip();
    // The daily ping limit in Settings governs how often the assistant may
    // volunteer something, so a cap of 1 means one nudge and then silence.
    await db
      .insert(notificationPrefs)
      .values({ agentId, ambientDailyCap: 1 })
      .onConflictDoUpdate({
        target: notificationPrefs.agentId,
        set: { ambientDailyCap: 1 },
      });
    try {
      await addActionableMail('cap-1');
      const first = await runPulse({ db }, { now: NOW });
      expect(first.delivered).toBe('mail-action');

      await addActionableMail('cap-2');
      // Past the hourly gap, so only the owner's ceiling can be holding it.
      const second = await runPulse({ db }, { now: new Date(NOW.getTime() + 2 * 3600_000) });
      expect(second.heldBy).toBe('daily-cap');
    } finally {
      await db.delete(notificationPrefs).where(eq(notificationPrefs.agentId, agentId));
    }
  });

  it('delivers the notice even when the phone leg fails', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await addActionableMail('mail-4');
    const result = await runPulse(
      {
        db,
        notifyOwner: async () => {
          throw new Error('APNs down');
        },
      },
      { now: NOW },
    );
    expect(result.delivered).toBe('mail-action');
    expect(result.pinged).toBe(false);
  });

  it('degrades to the mail half when the calendar read fails', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await addActionableMail('mail-5');
    const result = await runPulse(
      {
        db,
        calendarReader: async () => {
          throw new Error('grant expired');
        },
      },
      { now: NOW },
    );
    expect(result.delivered).toBe('mail-action');
  });

  describe('calendar change detection', () => {
    function calEvent(over: Partial<BriefingCalendarEvent> = {}): BriefingCalendarEvent {
      return {
        summary: `${MARKER} standup`,
        start: '2026-03-04T09:30:00Z',
        end: '2026-03-04T10:00:00Z',
        calendar: 'Work',
        calendarId: `${MARKER}-cal`,
        eventId: `${MARKER}-evt-1`,
        allDay: false,
        ...over,
      };
    }

    async function seedSnapshot(over: Partial<typeof calendarEventSnapshots.$inferInsert> = {}) {
      await db.insert(calendarEventSnapshots).values({
        agentId,
        calendarId: `${MARKER}-cal`,
        eventId: `${MARKER}-evt-1`,
        summary: `${MARKER} standup`,
        start: '2026-03-04T09:30:00Z',
        end: '2026-03-04T10:00:00Z',
        ...over,
      });
    }

    it('notices a cancelled event and outranks ordinary mail for it', async (ctx) => {
      if (!dbUp) return ctx.skip();
      await seedSnapshot();
      await addActionableMail('cal-1');
      // The event that was previously snapshotted is simply gone from this read.
      const result = await runPulse(
        { db, calendarReader: async () => ({ events: [], complete: true }) },
        { now: NOW },
      );
      expect(result.delivered).toBe('calendar-cancelled');

      const remaining = await db
        .select({ eventId: calendarEventSnapshots.eventId })
        .from(calendarEventSnapshots)
        .where(eq(calendarEventSnapshots.eventId, `${MARKER}-evt-1`));
      // The cancellation is told once; the row is gone so nothing re-reports it.
      expect(remaining).toHaveLength(0);
    });

    it('notices a moved event', async (ctx) => {
      if (!dbUp) return ctx.skip();
      await seedSnapshot();
      const moved = calEvent({ start: '2026-03-04T14:00:00Z', end: '2026-03-04T14:30:00Z' });
      const result = await runPulse(
        { db, calendarReader: async () => ({ events: [moved], complete: true }) },
        { now: NOW },
      );
      expect(result.delivered).toBe('calendar-moved');

      const [row] = await db
        .select({ start: calendarEventSnapshots.start })
        .from(calendarEventSnapshots)
        .where(eq(calendarEventSnapshots.eventId, `${MARKER}-evt-1`));
      // The snapshot now reflects the new time, so a second read stays quiet.
      expect(row?.start).toBe('2026-03-04T14:00:00Z');
    });

    it('notices an attendee backing out after accepting', async (ctx) => {
      if (!dbUp) return ctx.skip();
      await seedSnapshot({
        attendeeResponseHash: attendeeResponseDigest(['guest@example.com (accepted)']),
      });
      const declined = calEvent({ attendees: ['guest@example.com (declined)'] });
      const result = await runPulse(
        { db, calendarReader: async () => ({ events: [declined], complete: true }) },
        { now: NOW },
      );
      expect(result.delivered).toBe('calendar-declined');
    });

    it('says nothing on a brand-new snapshot — nothing to compare against yet', async (ctx) => {
      if (!dbUp) return ctx.skip();
      // No seeded row: this agent has never had a calendar read before.
      const result = await runPulse(
        { db, calendarReader: async () => ({ events: [calEvent()], complete: true }) },
        { now: NOW },
      );
      expect(result.delivered).toBeNull();
      expect(result.heldBy).toBe('no-candidates');
    });

    it('CRITICAL: a failed calendar read must never be treated as everything being cancelled', async (ctx) => {
      if (!dbUp) return ctx.skip();
      await seedSnapshot();
      await addActionableMail('cal-fail');
      const result = await runPulse(
        {
          db,
          calendarReader: async () => {
            throw new Error('grant expired');
          },
        },
        { now: NOW },
      );
      // Degrades to the mail half, exactly like the plain calendar-failure
      // case above — never announces the seeded event as cancelled.
      expect(result.delivered).toBe('mail-action');

      const [row] = await db
        .select({ eventId: calendarEventSnapshots.eventId })
        .from(calendarEventSnapshots)
        .where(eq(calendarEventSnapshots.eventId, `${MARKER}-evt-1`));
      // The snapshot is untouched — a failed read must not corrupt the baseline
      // the next SUCCESSFUL read will compare against.
      expect(row).toBeDefined();
    });
  });
});
