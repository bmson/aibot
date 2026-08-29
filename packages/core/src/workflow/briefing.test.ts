import {
  conversations,
  createDb,
  type Db,
  emailIngest,
  goals,
  messages,
  suggestions,
  watches,
  watchFires,
} from '@assistant/db';
import { eq, inArray, like } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getAgent } from '../chat.js';
import type { ModelRouter } from '../model-router/router.js';
import { briefingHasNews, briefingHeadline, findConflicts, runBriefing } from './briefing.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';
const MARKER = `xtest-briefing-${Date.now()}`;

let db: Db;
let dbUp = false;
let agentId: string;
let conversationId: string;
const ingestIds: string[] = [];
const createdSuggestionIds: string[] = [];
let flightSuggestionId = '';

/** Records what the composer was given, and echoes a fixed digest back. */
function recordingRouter(text = `${MARKER} composed digest`) {
  const prompts: string[] = [];
  const router = {
    async object(_role: string, opts: { prompt?: string }) {
      prompts.push(opts.prompt ?? '');
      return {
        ok: true,
        modelId: 'fake',
        degraded: false,
        object: { text },
      };
    },
  } as unknown as ModelRouter;
  return { router, prompts };
}

async function addMail(input: {
  id: string;
  importance: number;
  category: string;
  subject: string;
  dates?: Array<{ iso: string; what: string }>;
}) {
  const [row] = await db
    .insert(emailIngest)
    .values({
      agentId,
      conversationId,
      channelMessageId: `gmail:${MARKER}-${input.id}`,
      fromEmail: 'bookings@airline.example',
      subject: input.subject,
      contentTrust: 'unknown',
      authenticated: true,
      category: input.category,
      importance: input.importance,
      actionable: true,
      reason: 'test reason',
      dates: input.dates ?? [],
    })
    .returning({ id: emailIngest.id });
  if (row) ingestIds.push(row.id);
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    agentId = (await getAgent(db)).id;
    dbUp = true;
  } catch {
    console.warn('briefing.test: database unreachable — skipping');
    return;
  }
  const [conv] = await db
    .insert(conversations)
    .values({ agentId, channel: 'email', trust: 'unknown', title: `${MARKER} thread` })
    .returning();
  conversationId = (conv as NonNullable<typeof conv>).id;
});

afterAll(async () => {
  if (dbUp) {
    await db.delete(suggestions).where(like(suggestions.sourceRef, `%${MARKER}%`));
    if (createdSuggestionIds.length) {
      await db.delete(suggestions).where(inArray(suggestions.id, createdSuggestionIds));
    }
    if (ingestIds.length) await db.delete(emailIngest).where(inArray(emailIngest.id, ingestIds));
    await db.delete(messages).where(like(messages.text, `%${MARKER}%`));
    if (conversationId) {
      await db.delete(messages).where(eq(messages.conversationId, conversationId));
      await db.delete(conversations).where(eq(conversations.id, conversationId));
    }
  }
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

describe('runBriefing', () => {
  it('says nothing when there is nothing to say', async (ctx) => {
    if (!dbUp) return ctx.skip();
    // A daily "nothing to report" trains the owner to ignore the thread the
    // real ones arrive in, so silence is the correct output, not a courtesy.
    const { router, prompts } = recordingRouter(`${MARKER} quiet probe`);
    const result = await runBriefing({ db, router });
    if (
      result.highlights === 0 &&
      result.needsAttention === 0 &&
      result.pendingApprovals === 0 &&
      result.calendarConflicts === 0 &&
      result.goalDeltas === 0 &&
      result.watchHits === 0
    ) {
      expect(result.delivered).toBe(false);
      expect(prompts).toHaveLength(0);
    } else {
      // A shared dev database can hold unrelated rows; the assertion above only
      // means anything on a quiet one.
      ctx.skip();
    }
  });

  it('delivers a digest built only from the structured rows', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const soon = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
    await addMail({
      id: 'flight',
      importance: 4,
      category: 'travel',
      subject: `${MARKER} Your itinerary`,
      dates: [{ iso: soon, what: 'flight departs' }],
    });
    await addMail({
      id: 'bulk',
      importance: 1,
      category: 'bulk',
      subject: `${MARKER} Summer sale`,
    });

    const { router, prompts } = recordingRouter();
    const result = await runBriefing({ db, router });

    expect(result.delivered).toBe(true);
    const prompt = prompts[0] ?? '';
    // Everything the model sees is a row we assembled — it is asked to write
    // notes up, never to decide what matters.
    expect(prompt).toContain(`${MARKER} Your itinerary`);
    expect(prompt).toContain('flight departs');
    // Routine mail is counted but not itemised.
    expect(prompt).not.toContain(`${MARKER} Summer sale`);

    const [suggestion] = await db
      .select({
        id: suggestions.id,
        status: suggestions.status,
        acceptedTaskId: suggestions.acceptedTaskId,
      })
      .from(suggestions)
      .where(eq(suggestions.sourceRef, `gmail:${MARKER}-flight:0`));
    expect(suggestion?.status).toBe('pending');
    expect(suggestion?.acceptedTaskId).toBeNull();
    if (!suggestion) throw new Error('flight briefing did not create its suggestion');
    flightSuggestionId = suggestion.id;
    createdSuggestionIds.push(suggestion.id);

    const [posted] = await db
      .select({ parts: messages.parts })
      .from(messages)
      .where(eq(messages.text, `${MARKER} composed digest`));
    const parts = (posted?.parts ?? []) as Array<{ type?: string; suggestionId?: string }>;
    expect(
      parts.some((part) => part.type === 'suggestion' && part.suggestionId === suggestion.id),
    ).toBe(true);
  });

  it('proposes the obvious next step, once, as an inert card', async (ctx) => {
    if (!dbUp) return ctx.skip();
    if (!flightSuggestionId) throw new Error('the preceding fixture did not create a suggestion');
    const [row] = await db.select().from(suggestions).where(eq(suggestions.id, flightSuggestionId));
    expect(row?.status).toBe('pending');
    // Inert: nothing is queued until the owner says yes.
    expect(row?.acceptedTaskId).toBeNull();
    expect(row?.proposedAction).toContain('no attendees');
    // A second run must not re-ask: the source ref is stable per date.
    const { router } = recordingRouter();
    const again = await runBriefing({ db, router });
    expect(again.suggested).toBe(0);
  });

  it('does not propose anything for a date that is only marketing', async (ctx) => {
    if (!dbUp) return ctx.skip();
    // "Sale ends Friday" is a date too. Proposing a calendar entry for it is
    // how a useful surface becomes noise, so the category gates the proposal.
    await addMail({
      id: 'sale',
      importance: 3,
      category: 'bulk',
      subject: `${MARKER} Last chance`,
      dates: [
        { iso: new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString(), what: 'sale ends' },
      ],
    });
    const { router } = recordingRouter();
    const result = await runBriefing({ db, router });
    expect(result.suggested).toBe(0);
  });

  it('still delivers the notes when the composer cannot structure a digest', async (ctx) => {
    if (!dbUp) return ctx.skip();
    // The assembled rows ARE the substance; a composer outage should cost
    // polish, not the briefing. The name matters — isUnparseableObjectError
    // matches the AI SDK's error, and only that one degrades rather than throws.
    const failing = {
      async object() {
        throw Object.assign(new Error('no object generated'), {
          name: 'AI_NoObjectGeneratedError',
        });
      },
    } as unknown as ModelRouter;

    const result = await runBriefing({ db, router: failing });
    expect(result.delivered).toBe(true);

    const posted = await db
      .select({ text: messages.text })
      .from(messages)
      .where(like(messages.text, `%${MARKER} Your itinerary%`));
    // The raw notes went out, carrying the same items the composed version had.
    expect(posted.length).toBeGreaterThanOrEqual(1);
  });
});

describe('runBriefing — richer inputs', () => {
  const watchIds: string[] = [];
  const goalIds: string[] = [];

  afterEach(async () => {
    if (!dbUp) return;
    if (watchIds.length) {
      await db.delete(watchFires).where(inArray(watchFires.watchId, watchIds));
      await db.delete(watches).where(inArray(watches.id, watchIds));
      watchIds.length = 0;
    }
    if (goalIds.length) {
      await db.delete(goals).where(inArray(goals.id, goalIds));
      goalIds.length = 0;
    }
  });

  function calendarReturning(events: Array<Record<string, unknown>>) {
    return (async () => ({
      events: events.map((event) => ({
        summary: '',
        start: '',
        end: '',
        calendar: 'primary',
        allDay: false,
        ...event,
      })),
      complete: true,
    })) as NonNullable<Parameters<typeof runBriefing>[0]['calendarReader']>;
  }

  it('surfaces a calendar conflict even on an otherwise quiet day', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const day = new Date(Date.now() + 24 * 3600 * 1000);
    const at = (h: number) => new Date(day.getTime() + h * 3600 * 1000).toISOString();
    const digest = `${MARKER} conflict digest`;
    const { router, prompts } = recordingRouter(digest);
    const result = await runBriefing({
      db,
      router,
      calendarReader: calendarReturning([
        { summary: `${MARKER} Dentist`, start: at(9), end: at(10) },
        { summary: `${MARKER} Interview`, start: at(9.5), end: at(11) },
      ]),
    });
    expect(result.calendarConflicts).toBe(1);
    expect(result.delivered).toBe(true);
    const prompt = prompts[0] ?? '';
    expect(prompt).toContain(`${MARKER} Dentist`);
    expect(prompt).toContain('overlaps');
    const [posted] = await db
      .select({ parts: messages.parts })
      .from(messages)
      .where(eq(messages.text, digest));
    expect(posted?.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'data-card',
          data: expect.objectContaining({ kind: 'calendar-conflicts' }),
        }),
      ]),
    );
  });

  it('merges duplicate match listings from family and team calendars', () => {
    const conflicts = findConflicts(
      [
        {
          summary: 'Palo Alto v United (12:00)',
          start: '2026-08-29T18:15:00Z',
          end: '2026-08-29T20:30:00Z',
          calendar: 'Family',
          allDay: false,
          location: 'Mayfield Soccer Complex',
        },
        {
          summary: '26/27 U13B Azul @ Palo Alto SC 13/14B Gold',
          start: '2026-08-29T19:00:00Z',
          end: '2026-08-29T20:10:00Z',
          calendar: 'SF United Soccer',
          allDay: false,
          location: 'Mayfield Soccer Complex',
        },
      ],
      'America/Los_Angeles',
    );

    expect(conflicts).toEqual([]);
  });

  it('still reports two instances of one series that collide on the same calendar', () => {
    // A moved instance keeps its series id, so identity by recurringEventId
    // alone would merge a genuine double-booking out of the briefing.
    const conflicts = findConflicts(
      [
        {
          summary: 'Standup',
          start: '2026-08-29T16:00:00Z',
          end: '2026-08-29T16:30:00Z',
          calendar: 'Work',
          calendarId: 'work@example.com',
          recurringEventId: 'series-1',
          allDay: false,
        },
        {
          summary: 'Standup',
          start: '2026-08-29T16:15:00Z',
          end: '2026-08-29T16:45:00Z',
          calendar: 'Work',
          calendarId: 'work@example.com',
          recurringEventId: 'series-1',
          allDay: false,
        },
      ],
      'America/Los_Angeles',
    );

    expect(conflicts).toHaveLength(1);
  });

  it('still merges one series copied onto a second calendar', () => {
    expect(
      findConflicts(
        [
          {
            summary: 'Standup',
            start: '2026-08-29T16:00:00Z',
            end: '2026-08-29T16:30:00Z',
            calendar: 'Work',
            calendarId: 'work@example.com',
            recurringEventId: 'series-1',
            allDay: false,
          },
          {
            summary: 'Standup',
            start: '2026-08-29T16:00:00Z',
            end: '2026-08-29T16:30:00Z',
            calendar: 'Personal',
            calendarId: 'me@example.com',
            recurringEventId: 'series-1',
            allDay: false,
          },
        ],
        'America/Los_Angeles',
      ),
    ).toEqual([]);
  });

  it('counts a routine calendar as context, never as news', () => {
    // The silence rule, pinned without a database: events alone never deliver.
    expect(
      briefingHasNews({
        highlights: 0,
        upcoming: 0,
        needsAttention: 0,
        pendingApprovals: 0,
        calendarConflicts: 0,
        calendarSalient: 0,
        goalDeltas: 0,
        watchHits: 0,
      }),
    ).toBe(false);
    // ...but each genuine signal flips it on its own.
    const quiet = {
      highlights: 0,
      upcoming: 0,
      needsAttention: 0,
      pendingApprovals: 0,
      calendarConflicts: 0,
      calendarSalient: 0,
      goalDeltas: 0,
      watchHits: 0,
    };
    expect(briefingHasNews({ ...quiet, calendarConflicts: 1 })).toBe(true);
    expect(briefingHasNews({ ...quiet, calendarSalient: 1 })).toBe(true);
    expect(briefingHasNews({ ...quiet, goalDeltas: 1 })).toBe(true);
    expect(briefingHasNews({ ...quiet, watchHits: 1 })).toBe(true);
    expect(briefingHasNews({ ...quiet, highlights: 1 })).toBe(true);
  });

  it('pings the phone once, ambient, when the briefing delivers', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await addMail({
      id: 'ping',
      importance: 5,
      category: 'financial',
      subject: `${MARKER} invoice due`,
    });
    const pings: Array<{ text: string; urgency?: string }> = [];
    const result = await runBriefing(
      {
        db,
        router: recordingRouter().router,
        notifyOwner: async (input) => {
          pings.push(input);
        },
      },
      { now: new Date() },
    );
    expect(result.delivered).toBe(true);
    expect(result.pinged).toBe(true);
    // Exactly one buzz, marked ambient so quiet hours and the daily cap govern
    // it — a briefing is something the owner did not just ask for.
    expect(pings).toHaveLength(1);
    expect(pings[0]?.urgency).toBe('ambient');
    expect(pings[0]?.text).toContain('mail highlight');
  });

  it('still delivers the dashboard copy when no phone channel is wired', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await addMail({
      id: 'nophone',
      importance: 5,
      category: 'financial',
      subject: `${MARKER} second invoice`,
    });
    const result = await runBriefing({ db, router: recordingRouter().router }, { now: new Date() });
    expect(result.delivered).toBe(true);
    expect(result.pinged).toBe(false);
  });

  it('builds a push headline only from what the notes actually held', () => {
    const empty = {
      delivered: true,
      pinged: false,
      mailScanned: 40,
      highlights: 0,
      needsAttention: 0,
      pendingApprovals: 0,
      upcoming: 0,
      suggested: 0,
      calendarEvents: 9,
      calendarConflicts: 0,
      calendarSalient: 0,
      goalDeltas: 0,
      watchHits: 0,
    };
    // 40 messages scanned and 9 events seen, but nothing scored: the headline
    // must not manufacture an item out of the volume it looked at.
    expect(briefingHeadline(empty)).toBe('Your briefing is ready.');

    const busy = briefingHeadline({
      ...empty,
      calendarConflicts: 1,
      calendarSalient: 2,
      highlights: 3,
      pendingApprovals: 1,
    });
    expect(busy).toContain('1 calendar conflict');
    expect(busy).toContain('2 events worth a look');
    expect(busy).toContain('3 mail highlights');
    expect(busy).toContain('1 awaiting approval');
  });

  it('treats a salient event as news even with no conflict', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const start = new Date(Date.now() + 3 * 3600_000).toISOString();
    const end = new Date(Date.now() + 4 * 3600_000).toISOString();
    const { router, prompts } = recordingRouter();
    const result = await runBriefing({
      db,
      router,
      // One event, no overlap: before salience this was silence.
      calendarReader: async () => ({
        events: [
          {
            summary: `${MARKER} Consultant`,
            start,
            end,
            calendar: 'Personal',
            allDay: false,
            eventId: 'evt-salient',
            location: 'Skolavorduholt 1',
            organizer: 'clinic@hospital.example',
            attendees: ['bmson@bmson.com (needsAction)'],
          },
        ],
        complete: true,
      }),
    });
    expect(result.calendarConflicts).toBe(0);
    expect(result.calendarSalient).toBe(1);
    expect(result.delivered).toBe(true);
    expect(prompts[0] ?? '').toContain('Events worth a second look');
  });

  it('includes goal deltas, watch hits, and open suggestions in the notes', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [goal] = await db
      .insert(goals)
      .values({ agentId, title: `${MARKER} learn Icelandic`, nextAction: 'book a class' })
      .returning({ id: goals.id });
    if (!goal) throw new Error('goal fixture failed');
    goalIds.push(goal.id);

    const [watch] = await db
      .insert(watches)
      .values({ agentId, name: `${MARKER} watch`, expiresAt: new Date(Date.now() + 86400e3) })
      .returning({ id: watches.id });
    if (!watch) throw new Error('watch fixture failed');
    watchIds.push(watch.id);
    await db.insert(watchFires).values({
      watchId: watch.id,
      agentId,
      triggerRef: `gmail:${MARKER}-fire`,
      summary: `${MARKER} the watched sender wrote in`,
    });

    const [suggestion] = await db
      .insert(suggestions)
      .values({
        agentId,
        conversationId,
        summary: `${MARKER} an earlier proposal`,
        proposedAction: 'do the thing',
        sourceRef: `gmail:${MARKER}-open:0`,
        expiresAt: new Date(Date.now() + 7 * 86400e3),
      })
      .returning({ id: suggestions.id });
    if (!suggestion) throw new Error('suggestion fixture failed');
    createdSuggestionIds.push(suggestion.id);

    const { router, prompts } = recordingRouter();
    const result = await runBriefing({ db, router });
    expect(result.delivered).toBe(true);
    expect(result.goalDeltas).toBeGreaterThanOrEqual(1);
    expect(result.watchHits).toBeGreaterThanOrEqual(1);
    const prompt = prompts[0] ?? '';
    expect(prompt).toContain(`${MARKER} learn Icelandic`);
    expect(prompt).toContain(`${MARKER} the watched sender wrote in`);
    expect(prompt).toContain(`${MARKER} an earlier proposal`);
  });

  it('briefs without a calendar section when no reader is wired', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const { router, prompts } = recordingRouter();
    const result = await runBriefing({ db, router });
    expect(result.calendarEvents).toBe(0);
    expect(result.calendarConflicts).toBe(0);
    if (result.delivered) {
      expect(prompts[0] ?? '').not.toContain('On the calendar');
    }
  });
});
