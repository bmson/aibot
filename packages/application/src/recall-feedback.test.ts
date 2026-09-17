import { randomUUID } from 'node:crypto';
import { agents, conversations, createDb, type Db, messages, recallFeedback } from '@assistant/db';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getRecallFeedbackSummary, RECALL_FEEDBACK_WINDOW_DAYS } from './recall-feedback.js';

/**
 * Reading back the verdicts the owner already gave. The write path is tested
 * through its action; what matters here is that the summary counts the right
 * rows — this agent's, inside the window — because the whole point is to stop
 * asking for feedback that goes nowhere.
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:55432/assistant_test';

const DAY = 24 * 60 * 60_000;
const now = new Date('2026-09-17T12:00:00Z');

describe('getRecallFeedbackSummary', () => {
  const ownerId = randomUUID();
  const foreignOwnerId = randomUUID();
  let db: Db;
  let dbUp = false;
  const created: string[] = [];
  const messageIds: string[] = [];
  const conversationId = randomUUID();
  const foreignConversationId = randomUUID();

  /** `recall_feedback.message_id` is a real foreign key, so each rating gets a real reply. */
  async function rate(input: {
    verdict: 'helpful' | 'not_helpful';
    agentId?: string;
    daysAgo?: number;
  }) {
    const agentId = input.agentId ?? ownerId;
    const [message] = await db
      .insert(messages)
      .values({
        conversationId: agentId === ownerId ? conversationId : foreignConversationId,
        role: 'assistant',
        origin: 'assistant',
        text: 'recalled reply',
      })
      .returning({ id: messages.id });
    const messageId = (message as NonNullable<typeof message>).id;
    messageIds.push(messageId);

    const id = randomUUID();
    await db.insert(recallFeedback).values({
      id,
      agentId,
      messageId,
      verdict: input.verdict,
      sourceCount: 2,
      createdAt: new Date(now.getTime() - (input.daysAgo ?? 1) * DAY),
    });
    created.push(id);
    return id;
  }

  beforeAll(async () => {
    db = createDb(DATABASE_URL);
    try {
      await db.select({ id: agents.id }).from(agents).limit(1);
      dbUp = true;
    } catch {
      console.warn('recall-feedback.test: database unreachable — skipping');
      return;
    }
    await db.insert(agents).values([
      {
        id: ownerId,
        name: 'Feedback owner',
        email: `${ownerId}@test.local`,
        workspacePrefix: `tests/${ownerId}`,
      },
      {
        id: foreignOwnerId,
        name: 'Foreign feedback owner',
        email: `${foreignOwnerId}@test.local`,
        workspacePrefix: `tests/${foreignOwnerId}`,
      },
    ]);
    await db.insert(conversations).values([
      { id: conversationId, agentId: ownerId, channel: 'chat' },
      { id: foreignConversationId, agentId: foreignOwnerId, channel: 'chat' },
    ]);
  });

  afterAll(async () => {
    if (!dbUp) return;
    if (created.length > 0) {
      await db.delete(recallFeedback).where(inArray(recallFeedback.id, created));
    }
    if (messageIds.length > 0) {
      await db.delete(messages).where(inArray(messages.id, messageIds));
    }
    await db
      .delete(conversations)
      .where(inArray(conversations.id, [conversationId, foreignConversationId]));
    await db.delete(agents).where(inArray(agents.id, [ownerId, foreignOwnerId]));
  });

  it('reports nothing rated as nothing rated', async (ctx) => {
    if (!dbUp) return ctx.skip();

    const summary = await getRecallFeedbackSummary(db, ownerId, { now });

    expect(summary.rated).toBe(0);
    expect(summary.helpful).toBe(0);
    expect(summary.notHelpful).toBe(0);
    expect(summary.lastRatedAt).toBeNull();
    expect(summary.windowDays).toBe(RECALL_FEEDBACK_WINDOW_DAYS);
  });

  it('counts each verdict and the most recent rating', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await rate({ verdict: 'helpful', daysAgo: 5 });
    await rate({ verdict: 'helpful', daysAgo: 3 });
    await rate({ verdict: 'not_helpful', daysAgo: 2 });

    const summary = await getRecallFeedbackSummary(db, ownerId, { now });

    expect(summary.rated).toBe(3);
    expect(summary.helpful).toBe(2);
    expect(summary.notHelpful).toBe(1);
    expect(summary.lastRatedAt?.toISOString()).toBe(
      new Date(now.getTime() - 2 * DAY).toISOString(),
    );
  });

  it('leaves a rating older than the window out', async (ctx) => {
    if (!dbUp) return ctx.skip();
    // A verdict from last year does not describe how recall is doing now.
    await rate({ verdict: 'not_helpful', daysAgo: RECALL_FEEDBACK_WINDOW_DAYS + 1 });

    const summary = await getRecallFeedbackSummary(db, ownerId, { now });

    expect(summary.rated).toBe(3);
    expect(summary.notHelpful).toBe(1);
  });

  it('honours a caller-chosen window', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const summary = await getRecallFeedbackSummary(db, ownerId, { now, windowDays: 4 });

    // Only the 3-day and 2-day ratings fall inside four days.
    expect(summary.rated).toBe(2);
    expect(summary.windowDays).toBe(4);
  });

  it("never counts another agent's ratings", async (ctx) => {
    if (!dbUp) return ctx.skip();
    await rate({ verdict: 'helpful', agentId: foreignOwnerId, daysAgo: 1 });

    const summary = await getRecallFeedbackSummary(db, ownerId, { now });

    expect(summary.rated).toBe(3);
    expect(await getRecallFeedbackSummary(db, foreignOwnerId, { now })).toMatchObject({
      rated: 1,
      helpful: 1,
    });
  });
});
