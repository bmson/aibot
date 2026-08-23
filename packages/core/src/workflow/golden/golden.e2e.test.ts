import { createDb, type Db, responseChecks, tasks, toolCalls } from '@assistant/db';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { getAgent } from '../../chat.js';
import { type GoldenFixture, runGoldenTask } from './harness.js';

/**
 * Golden tasks: fixtures that pin what the platform DOES with a scripted model
 * — which tools run, in what order, and what text survives the response
 * contract. This is the regression net for prompt, contract, and executor
 * changes: extend it with a fixture whenever a behavior matters enough that a
 * quiet change to it should fail CI.
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

let db: Db;
let dbUp = false;
let agentId: string;
const createdTaskIds: string[] = [];

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    agentId = (await getAgent(db)).id;
    dbUp = true;
  } catch {
    console.warn('golden: database unreachable — skipping');
  }
});

afterAll(async () => {
  if (dbUp && createdTaskIds.length) {
    await db.delete(toolCalls).where(inArray(toolCalls.taskId, createdTaskIds));
    await db.delete(tasks).where(inArray(tasks.id, createdTaskIds));
  }
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

/** The fixture's events must land inside the window the runtime resolves for "today". */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

const workflowPlan = {
  action: 'workflow' as const,
  reasoning: 'look the fact up, then answer',
  steps: ['look up the fact', 'answer'],
  missingInfo: [],
};

describe('golden tasks', () => {
  it('runs the scripted tool sequence in order and delivers the final text', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const fixture: GoldenFixture = {
      name: 'lookup-then-answer',
      event: { source: 'chat', trust: 'owner', payload: { text: 'What is our wifi password?' } },
      taskType: 'adhoc',
      plan: workflowPlan,
      script: [
        { toolCalls: [{ toolName: 'facts.lookup', input: { key: 'wifi' } }] },
        { text: 'It is in your workspace notes: hunter2.' },
      ],
      tools: {
        'facts.lookup': {
          schema: z.object({ key: z.string() }),
          execute: async () => ({ value: 'hunter2' }),
        },
      },
    };
    const result = await runGoldenTask(db, agentId, fixture);
    createdTaskIds.push(result.taskId);

    expect(result.toolNames).toEqual(['facts.lookup']);
    expect(result.finalText).toContain('hunter2');
  });

  /**
   * The owner's most common question. What is pinned here is that the ANSWER is
   * the model's — the executor used to render calendar replies from the ledger
   * without ever asking for one, which is why no amount of prompt work ever
   * changed how a schedule answer read.
   */
  it('lets the model write a day agenda once the calendar read is grounded', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const agenda = [
      'Two things today, and the afternoon is the tight one:',
      '- **09:30–10:15** — Linear interview prep — Zoom',
      '- **13:00–14:00** — Dentist — Laugavegur 12',
    ].join('\n');
    const fixture: GoldenFixture = {
      name: 'calendar-day-answer-grounded',
      event: {
        source: 'chat',
        trust: 'owner',
        payload: { text: 'what is happening today?' },
      },
      taskType: 'chat_turn',
      plan: workflowPlan,
      // The required calendar read is dispatched by the runtime, not scripted;
      // this entry is consumed by the answer turn that follows it.
      script: [{ text: agenda }],
      tools: {
        'calendar.list_events': {
          schema: z.object({}).passthrough(),
          execute: async () => ({
            complete: true,
            calendarsSearched: ['Assistant'],
            events: [
              {
                eventId: 'evt-prep',
                calendarId: 'primary',
                calendar: 'Assistant',
                summary: 'Linear interview prep',
                location: 'Zoom',
                start: `${today()}T09:30:00Z`,
                end: `${today()}T10:15:00Z`,
              },
              {
                eventId: 'evt-dentist',
                calendarId: 'primary',
                calendar: 'Assistant',
                summary: 'Dentist',
                location: 'Laugavegur 12',
                start: `${today()}T13:00:00Z`,
                end: `${today()}T14:00:00Z`,
              },
            ],
          }),
        },
      },
    };
    const result = await runGoldenTask(db, agentId, fixture);
    createdTaskIds.push(result.taskId);

    expect(result.toolNames).toEqual(['calendar.list_events']);
    // The agenda goes out as written, not restated as a field dump.
    expect(result.finalText).toBe(agenda);
    expect(result.finalText).not.toContain('Here’s what I found in the connected sources');
    expect(result.finalText).not.toContain('Calendar range searched');

    const [check] = await db
      .select()
      .from(responseChecks)
      .where(eq(responseChecks.taskId, result.taskId));
    expect(check?.blocked).toBe(false);
  });

  it('falls back to the verified list when the agenda invents an event', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const fixture: GoldenFixture = {
      name: 'calendar-day-answer-fabricated',
      event: {
        source: 'chat',
        trust: 'owner',
        payload: { text: 'what is happening today?' },
      },
      taskType: 'chat_turn',
      plan: workflowPlan,
      script: [
        {
          text: [
            'Two things today:',
            '- **09:30–10:15** — Linear interview prep — Zoom',
            '- **19:00–21:00** — Dinner at Zuni Cafe — 1658 Market St',
          ].join('\n'),
        },
      ],
      tools: {
        'calendar.list_events': {
          schema: z.object({}).passthrough(),
          execute: async () => ({
            complete: true,
            calendarsSearched: ['Assistant'],
            events: [
              {
                eventId: 'evt-prep',
                calendarId: 'primary',
                calendar: 'Assistant',
                summary: 'Linear interview prep',
                location: 'Zoom',
                start: `${today()}T09:30:00Z`,
                end: `${today()}T10:15:00Z`,
              },
            ],
          }),
        },
      },
    };
    const result = await runGoldenTask(db, agentId, fixture);
    createdTaskIds.push(result.taskId);

    expect(result.finalText).not.toContain('Zuni Cafe');
    expect(result.finalText).toContain('Linear interview prep');
    // A fallback is not an honesty failure: the owner still gets every fact.
    const [check] = await db
      .select()
      .from(responseChecks)
      .where(eq(responseChecks.taskId, result.taskId));
    expect(check?.blocked).toBe(false);
  });

  it('lets the response contract block an action claim with no tool evidence', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const fixture: GoldenFixture = {
      name: 'fabricated-send-claim',
      event: { source: 'chat', trust: 'owner', payload: { text: 'Email Anna the agenda.' } },
      taskType: 'adhoc',
      // A reply-shaped plan: mustAct would otherwise retry the toolless step
      // and never let this fabricated claim reach the contract at all.
      plan: { ...workflowPlan, action: 'reply' as const },
      // The scripted model claims a send happened; no tool ever ran.
      script: [{ text: "Done — I've sent the email to Anna with the agenda." }],
      tools: {},
    };
    const result = await runGoldenTask(db, agentId, fixture);
    createdTaskIds.push(result.taskId);

    expect(result.toolNames).toEqual([]);
    // The delivered text must not carry the unsupported claim verbatim.
    expect(result.finalText).not.toContain("I've sent the email");

    // The verdict is persisted for aggregation, not only rewritten.
    const [check] = await db
      .select()
      .from(responseChecks)
      .where(eq(responseChecks.taskId, result.taskId));
    expect(check?.blocked).toBe(true);
  });

  it('records a clean response check for an honest answer', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const fixture: GoldenFixture = {
      name: 'honest-answer',
      event: { source: 'chat', trust: 'owner', payload: { text: 'Say hi.' } },
      taskType: 'adhoc',
      plan: { ...workflowPlan, action: 'reply' as const },
      script: [{ text: 'Hi! What can I do for you?' }],
      tools: {},
    };
    const result = await runGoldenTask(db, agentId, fixture);
    createdTaskIds.push(result.taskId);

    const [check] = await db
      .select()
      .from(responseChecks)
      .where(eq(responseChecks.taskId, result.taskId));
    expect(check).toBeDefined();
    expect(check?.blocked).toBe(false);
    expect(check?.mustActRetries).toBe(0);
  });

  it('lets an action claim WITH tool evidence through untouched', async (ctx) => {
    if (!dbUp) return ctx.skip();
    // The inverse of the fabricated-claim fixture: the send actually ran, so
    // the contract must not rewrite the honest confirmation. This pins the
    // false-positive side — a claim-detection tightening that starts blocking
    // real confirmations fails here, not on a user.
    const fixture: GoldenFixture = {
      name: 'evidence-supported-send',
      event: { source: 'chat', trust: 'owner', payload: { text: 'Text me the door code.' } },
      taskType: 'adhoc',
      plan: workflowPlan,
      script: [
        { toolCalls: [{ toolName: 'sms.send', input: { to: 'owner', body: 'Door code: 4821' } }] },
        { text: "Done — I've sent the text with the door code." },
      ],
      tools: {
        'sms.send': {
          schema: z.object({ to: z.string(), body: z.string() }),
          execute: async () => ({ deliveryStatus: 'accepted', sid: 'SM-golden-1' }),
        },
      },
    };
    const result = await runGoldenTask(db, agentId, fixture);
    createdTaskIds.push(result.taskId);

    expect(result.toolNames).toEqual(['sms.send']);
    expect(result.finalText).toContain("I've sent the text");

    const [check] = await db
      .select()
      .from(responseChecks)
      .where(eq(responseChecks.taskId, result.taskId));
    expect(check?.blocked).toBe(false);
    expect(check?.unsupportedCount).toBe(0);
  });

  it('strips a fabricated link but does not block the answer around it', async (ctx) => {
    if (!dbUp) return ctx.skip();
    // The REWRITE verdict path: an unevidenced URL loses its href while the
    // answer survives — distinct from blocking, and the only place the
    // urlCorpus assembly in finalize.ts is exercised end to end.
    const fixture: GoldenFixture = {
      name: 'fabricated-link',
      event: { source: 'chat', trust: 'owner', payload: { text: 'Where do I manage this?' } },
      taskType: 'adhoc',
      plan: { ...workflowPlan, action: 'reply' as const },
      script: [
        {
          text: 'You can manage it at https://acme.example/settings/9f3a2b under Preferences.',
        },
      ],
      tools: {},
    };
    const result = await runGoldenTask(db, agentId, fixture);
    createdTaskIds.push(result.taskId);

    expect(result.finalText).not.toContain('https://acme.example/settings/9f3a2b');
    expect(result.finalText).toMatch(/removed a link/i);

    const [check] = await db
      .select()
      .from(responseChecks)
      .where(eq(responseChecks.taskId, result.taskId));
    expect(check?.blocked).toBe(false);
  });

  it('forces a workflow plan to act, and counts the retry it took', async (ctx) => {
    if (!dbUp) return ctx.skip();
    // A workflow plan whose first step proposes no tool is retried with the
    // forced-action nudge; the retry consumes the next script entry. Closes
    // the carve-out the fabricated-send fixture's comment notes.
    const fixture: GoldenFixture = {
      name: 'must-act-retry',
      event: { source: 'chat', trust: 'owner', payload: { text: 'Look up the wifi password.' } },
      taskType: 'adhoc',
      plan: workflowPlan,
      script: [
        { text: 'I will look that up now.' }, // toolless first step → forced retry
        { toolCalls: [{ toolName: 'facts.lookup', input: { key: 'wifi' } }] },
        { text: 'It is hunter2.' },
      ],
      tools: {
        'facts.lookup': {
          schema: z.object({ key: z.string() }),
          execute: async () => ({ value: 'hunter2' }),
        },
      },
    };
    const result = await runGoldenTask(db, agentId, fixture);
    createdTaskIds.push(result.taskId);

    expect(result.toolNames).toEqual(['facts.lookup']);
    const [check] = await db
      .select()
      .from(responseChecks)
      .where(eq(responseChecks.taskId, result.taskId));
    expect(check?.mustActRetries).toBe(1);
    expect(check?.blocked).toBe(false);
  });
});
