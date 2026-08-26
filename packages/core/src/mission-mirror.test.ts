import { agents, conversations, createDb, type Db, goals, messages, tasks } from '@assistant/db';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mirrorGoalUpdateToNotifications } from './chat.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

let db: Db;
let dbUp = false;
let agentId: string;
let primaryId: string;
let workId: string;
let goalId: string;
let taskId: string;
const conversationIds: string[] = [];

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    const [agent] = await db
      .insert(agents)
      .values({
        name: 'Mirror Test',
        email: `mirror-${Date.now()}@example.com`,
        workspacePrefix: 'mirror-test',
      })
      .returning();
    agentId = (agent as NonNullable<typeof agent>).id;
    dbUp = true;

    const [primary] = await db
      .insert(conversations)
      .values({ agentId, channel: 'chat', trust: 'owner', title: 'main', isPrimary: true })
      .returning();
    primaryId = (primary as NonNullable<typeof primary>).id;
    const [work] = await db
      .insert(conversations)
      .values({ agentId, channel: 'chat', trust: 'owner', title: 'Work: ship it' })
      .returning();
    workId = (work as NonNullable<typeof work>).id;
    conversationIds.push(primaryId, workId);

    const [goal] = await db
      .insert(goals)
      .values({ agentId, title: 'Ship the thing', mirrorToPrimary: true })
      .returning();
    goalId = (goal as NonNullable<typeof goal>).id;

    const [task] = await db
      .insert(tasks)
      .values({ agentId, type: 'mission', trust: 'owner', goalId, conversationId: workId })
      .returning();
    taskId = (task as NonNullable<typeof task>).id;
  } catch {
    console.warn('mission-mirror.test: database unreachable — skipping');
  }
});

afterAll(async () => {
  if (dbUp) {
    // The Notifications thread is created on demand by the mirror itself.
    const [notifications] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.agentId, agentId), eq(conversations.title, 'Notifications')));
    if (notifications) conversationIds.push(notifications.id);
    await db.delete(messages).where(inArray(messages.conversationId, conversationIds));
    await db.delete(tasks).where(eq(tasks.agentId, agentId));
    await db.delete(goals).where(eq(goals.agentId, agentId));
    await db.delete(conversations).where(eq(conversations.agentId, agentId));
    await db.delete(agents).where(eq(agents.id, agentId));
  }
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

async function primaryMessages() {
  return db.select().from(messages).where(eq(messages.conversationId, primaryId));
}

async function notificationMessages() {
  const [notifications] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.agentId, agentId), eq(conversations.title, 'Notifications')));
  if (!notifications) return [];
  return db.select().from(messages).where(eq(messages.conversationId, notifications.id));
}

describe('mirrorGoalUpdateToNotifications (integration)', () => {
  it('posts a labeled copy into the Notifications thread for an opted-in goal', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await mirrorGoalUpdateToNotifications(
      db,
      { id: taskId, agentId, goalId, conversationId: workId },
      'Booked the venue and emailed the caterer.',
    );
    const rows = await notificationMessages();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toBe(
      'Quick update on your “Ship the thing” goal: Booked the venue and emailed the caterer.',
    );
    expect(rows[0]?.taskId).toBe(taskId);
    // The primary thread stays conversational — nothing mirrored into it.
    expect(await primaryMessages()).toHaveLength(0);
  });

  it('does nothing when the goal has not opted in', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await db.update(goals).set({ mirrorToPrimary: false }).where(eq(goals.id, goalId));
    await mirrorGoalUpdateToNotifications(
      db,
      { id: taskId, agentId, goalId, conversationId: workId },
      'A second update.',
    );
    // Still only the first message from the opted-in run.
    expect(await notificationMessages()).toHaveLength(1);
    await db.update(goals).set({ mirrorToPrimary: true }).where(eq(goals.id, goalId));
  });

  it('still posts for a fresh agent with no primary thread at all', async (ctx) => {
    if (!dbUp) return ctx.skip();
    // The Notifications thread is created on demand, so a mirrored update is
    // never lost just because the owner has not started a main chat yet.
    const [agent] = await db
      .insert(agents)
      .values({
        name: 'No Primary',
        email: `noprimary-${Date.now()}@example.com`,
        workspacePrefix: 'noprimary',
      })
      .returning();
    const noPrimaryAgent = (agent as NonNullable<typeof agent>).id;
    const [goal] = await db
      .insert(goals)
      .values({ agentId: noPrimaryAgent, title: 'orphan', mirrorToPrimary: true })
      .returning();
    const [task] = await db
      .insert(tasks)
      .values({
        agentId: noPrimaryAgent,
        type: 'mission',
        trust: 'owner',
        goalId: (goal as NonNullable<typeof goal>).id,
      })
      .returning();

    await mirrorGoalUpdateToNotifications(
      db,
      {
        id: (task as NonNullable<typeof task>).id,
        agentId: noPrimaryAgent,
        goalId: (goal as NonNullable<typeof goal>).id,
        conversationId: null,
      },
      'still somewhere to go',
    );
    const [notifications] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(eq(conversations.agentId, noPrimaryAgent), eq(conversations.title, 'Notifications')),
      );
    expect(notifications).toBeDefined();
    const rows = notifications
      ? await db.select().from(messages).where(eq(messages.conversationId, notifications.id))
      : [];
    expect(rows).toHaveLength(1);

    if (notifications) {
      await db.delete(messages).where(eq(messages.conversationId, notifications.id));
    }
    await db.delete(tasks).where(eq(tasks.agentId, noPrimaryAgent));
    await db.delete(goals).where(eq(goals.agentId, noPrimaryAgent));
    await db.delete(conversations).where(eq(conversations.agentId, noPrimaryAgent));
    await db.delete(agents).where(eq(agents.id, noPrimaryAgent));
  });
});
