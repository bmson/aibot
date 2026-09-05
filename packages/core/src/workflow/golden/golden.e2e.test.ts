import {
  conversations,
  createDb,
  type Db,
  messages,
  responseChecks,
  tasks,
  toolCalls,
} from '@assistant/db';
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
const createdConversationIds: string[] = [];

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
    await db.delete(messages).where(inArray(messages.taskId, createdTaskIds));
    await db.delete(toolCalls).where(inArray(toolCalls.taskId, createdTaskIds));
    await db.delete(tasks).where(inArray(tasks.id, createdTaskIds));
    if (createdConversationIds.length)
      await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
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
    expect(result.finalText).not.toContain("Here's what the calendar has");
    expect(result.finalText).not.toContain('organizer:');

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

  it('retries a failed private read once, then delivers an explicit coverage gap', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const fixture: GoldenFixture = {
      name: 'calendar-read-outage-is-honest',
      event: {
        source: 'chat',
        trust: 'owner',
        payload: { text: 'what is happening today?' },
      },
      taskType: 'chat_turn',
      plan: workflowPlan,
      script: [],
      tools: {
        'calendar.list_events': {
          schema: z.object({}).passthrough(),
          execute: async () => {
            throw new Error('calendar provider is temporarily unavailable');
          },
        },
      },
    };
    const result = await runGoldenTask(db, agentId, fixture);
    createdTaskIds.push(result.taskId);

    // The runtime owns private reads, so it retries exactly once without ever
    // letting the scripted model fill the gap with remembered or guessed events.
    expect(result.toolNames).toEqual(['calendar.list_events', 'calendar.list_events']);
    expect(result.finalText).toContain("That's everything I could actually see.");
    expect(result.finalText).toContain('calendar provider is temporarily unavailable');
    expect(result.finalText).not.toContain('Done.');

    const [check] = await db
      .select()
      .from(responseChecks)
      .where(eq(responseChecks.taskId, result.taskId));
    expect(check).toMatchObject({ blocked: true, unsupportedCount: 1 });

    const calls = await db
      .select({ status: toolCalls.status, error: toolCalls.error })
      .from(toolCalls)
      .where(eq(toolCalls.taskId, result.taskId));
    expect(calls).toEqual([
      { status: 'failed', error: 'Error: calendar provider is temporarily unavailable' },
      { status: 'failed', error: 'Error: calendar provider is temporarily unavailable' },
    ]);
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

  it('replaces a completion claim when a proactive action definitively failed', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const fixture: GoldenFixture = {
      name: 'failed-send-cannot-look-complete',
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
          execute: async () => {
            throw new Error('SMS provider rejected the request');
          },
        },
      },
    };
    const result = await runGoldenTask(db, agentId, fixture);
    createdTaskIds.push(result.taskId);

    expect(result.toolNames).toEqual(['sms.send']);
    expect(result.finalText).not.toContain("I've sent the text");
    expect(result.finalText).toContain("I couldn't complete this because");
    expect(result.finalText).toContain('SMS provider rejected the request');

    const [check] = await db
      .select()
      .from(responseChecks)
      .where(eq(responseChecks.taskId, result.taskId));
    expect(check).toMatchObject({ blocked: true, unsupportedCount: 1 });
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

  it('self-reviews a clean draft once, records the revision, and still delivers through the contract', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const fixture: GoldenFixture = {
      name: 'self-reflective-revision',
      event: { source: 'chat', trust: 'owner', payload: { text: 'Say hi.' } },
      taskType: 'adhoc',
      plan: { ...workflowPlan, action: 'reply' as const },
      script: [{ text: 'Hi.' }],
      verification: {
        decision: 'revise',
        revisedText: 'Hi! What can I help with?',
        reasons: ['clarity_or_format'],
      },
      tools: {},
    };
    const result = await runGoldenTask(db, agentId, fixture);
    createdTaskIds.push(result.taskId);

    expect(result.finalText).toBe('Hi! What can I help with?');
    const [check] = await db
      .select()
      .from(responseChecks)
      .where(eq(responseChecks.taskId, result.taskId));
    expect(check).toMatchObject({
      blocked: false,
      outputVerificationAttempted: true,
      outputVerificationRevised: true,
      outputVerificationUnavailable: false,
    });
  });

  it('delivers the checked draft and records a verifier outage without failing the owner response', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const fixture: GoldenFixture = {
      name: 'self-reflective-verifier-unavailable',
      event: { source: 'chat', trust: 'owner', payload: { text: 'Say hi.' } },
      taskType: 'adhoc',
      plan: { ...workflowPlan, action: 'reply' as const },
      script: [{ text: 'Hi! What can I do for you?' }],
      verification: { unavailable: true },
      tools: {},
    };
    const result = await runGoldenTask(db, agentId, fixture);
    createdTaskIds.push(result.taskId);

    expect(result.finalText).toBe('Hi! What can I do for you?');
    expect(result.status).toBe('done');
    const [check] = await db
      .select()
      .from(responseChecks)
      .where(eq(responseChecks.taskId, result.taskId));
    expect(check).toMatchObject({
      blocked: false,
      outputVerificationAttempted: false,
      outputVerificationRevised: false,
      outputVerificationUnavailable: true,
    });
  });

  it('holds a self-review revision to the same evidence contract before delivery', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const fixture: GoldenFixture = {
      name: 'self-reflective-revision-is-contract-checked',
      event: { source: 'chat', trust: 'owner', payload: { text: 'Say hi.' } },
      taskType: 'adhoc',
      plan: { ...workflowPlan, action: 'reply' as const },
      script: [{ text: 'Hi.' }],
      verification: {
        decision: 'revise',
        revisedText: 'Hi — I sent the email to Anna.',
        reasons: ['unsupported_claim'],
      },
      tools: {},
    };
    const result = await runGoldenTask(db, agentId, fixture);
    createdTaskIds.push(result.taskId);

    expect(result.finalText).not.toContain('I sent the email');
    const [check] = await db
      .select()
      .from(responseChecks)
      .where(eq(responseChecks.taskId, result.taskId));
    expect(check).toMatchObject({
      blocked: true,
      outputVerificationAttempted: true,
      outputVerificationRevised: true,
    });
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

  it('answers save-status checks without letting a planner or prose model invent a receipt', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [conversation] = await db
      .insert(conversations)
      .values({ agentId, channel: 'chat', trust: 'owner' })
      .returning();
    if (!conversation) throw new Error('missing test conversation');
    createdConversationIds.push(conversation.id);
    const [previous] = await db
      .insert(tasks)
      .values({
        agentId,
        conversationId: conversation.id,
        type: 'chat_turn',
        status: 'failed',
        trust: 'owner',
        trigger: { source: 'chat', payload: { text: 'Remember our family birthdays' } },
        createdAt: new Date(Date.now() - 60_000),
      })
      .returning();
    if (!previous) throw new Error('missing previous task');
    createdTaskIds.push(previous.id);
    await db.insert(toolCalls).values({
      taskId: previous.id,
      toolName: 'occasions.save',
      step: 1,
      risk: 'autonomous',
      status: 'succeeded',
      args: { kind: 'birthday' },
      result: { saved: true, person: 'Ada', quarantined: false },
    });
    const result = await runGoldenTask(db, agentId, {
      name: 'save-status-without-model',
      event: {
        source: 'chat',
        trust: 'owner',
        conversationId: conversation.id,
        payload: { text: 'Was it save to long term memory' },
      },
      taskType: 'chat_turn',
      tools: {},
      script: [{ text: 'Everything has been saved!' }],
    });
    createdTaskIds.push(result.taskId);
    expect(result.toolNames).toEqual([]);
    expect(result.finalText).toContain('Partly.');
    expect(result.finalText).toContain('1 birthday entry in People: Ada');
    expect(result.finalText).not.toContain('Everything has been saved');
  });

  it('reports saved birthdays when a batch reaches the step cap', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const fixture: GoldenFixture = {
      name: 'birthday-step-cap-receipt',
      event: {
        source: 'chat',
        trust: 'owner',
        payload: { text: 'Remember our family birthdays, update their information.' },
      },
      taskType: 'chat_turn',
      plan: workflowPlan,
      maxSteps: 1,
      script: [
        {
          toolCalls: [
            { toolName: 'occasions.save', input: { subject: 'Ada', kind: 'birthday' } },
            { toolName: 'occasions.save', input: { subject: 'Grace', kind: 'birthday' } },
          ],
        },
      ],
      tools: {
        'occasions.save': {
          schema: z.object({ subject: z.string(), kind: z.string() }),
          execute: async (args) => ({
            saved: true,
            person: z.object({ subject: z.string() }).parse(args).subject,
            quarantined: false,
          }),
        },
      },
    };
    const result = await runGoldenTask(db, agentId, fixture);
    createdTaskIds.push(result.taskId);
    expect(result.status).toBe('failed');
    expect(result.finalText).toContain('2 birthday entries in People: Ada, Grace');
    expect(result.finalText).toContain('remaining work has not been completed');
  });

  it('reports verified progress instead of an opaque failure when proactive work reaches its step cap', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const fixture: GoldenFixture = {
      name: 'step-cap-progress-summary',
      event: {
        source: 'internal',
        trust: 'assistant',
        payload: { instruction: 'Find the wifi password and then send it to me.' },
      },
      taskType: 'adhoc',
      plan: workflowPlan,
      maxSteps: 1,
      script: [
        {
          text: 'I found the wifi password in the workspace notes, but have not sent it yet.',
          toolCalls: [{ toolName: 'facts.lookup', input: { key: 'wifi' } }],
        },
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
    expect(result.status).toBe('failed');
    expect(result.finalText).toContain('stopped after 1 steps without finishing');
    expect(result.finalText).toContain('1 tool call completed (facts.lookup)');
    expect(result.finalText).toContain('remaining work has not been completed');
    // The model's pre-tool narration is not a verified completion summary.
    expect(result.finalText).not.toContain('found the wifi password');
    expect(result.finalText).not.toContain('See task log');
  });
});
