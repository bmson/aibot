import { agents, conversations, createDb, type Db } from '@assistant/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getOrCreatePrimaryConversation } from '../chat.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

let db: Db;
let dbUp = false;
let agentId: string;

async function freshAgent(): Promise<string> {
  const [agent] = await db
    .insert(agents)
    .values({
      name: 'Primary Test',
      email: `primary-${Date.now()}-${Math.round(performance.now())}@example.com`,
      workspacePrefix: 'primary-test',
    })
    .returning();
  return (agent as NonNullable<typeof agent>).id;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    agentId = await freshAgent();
    dbUp = true;
  } catch {
    console.warn('primary-conversation.test: database unreachable — skipping');
  }
});

afterAll(async () => {
  if (dbUp) {
    await db.delete(conversations).where(eq(conversations.agentId, agentId));
    await db.delete(agents).where(eq(agents.id, agentId));
  }
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

describe('getOrCreatePrimaryConversation (integration)', () => {
  it('creates a primary thread when none exists, and is sticky', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const first = await getOrCreatePrimaryConversation(db, agentId);
    expect(first.isPrimary).toBe(true);
    expect(first.channel).toBe('chat');
    const second = await getOrCreatePrimaryConversation(db, agentId);
    expect(second.id).toBe(first.id); // same thread, not a duplicate
  });

  it('un-archives the primary instead of creating a new one', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const primary = await getOrCreatePrimaryConversation(db, agentId);
    await db
      .update(conversations)
      .set({ archivedAt: new Date() })
      .where(eq(conversations.id, primary.id));
    const resolved = await getOrCreatePrimaryConversation(db, agentId);
    expect(resolved.id).toBe(primary.id);
    expect(resolved.archivedAt).toBeNull();
  });

  it('promotes the most recent non-goal chat when there is no primary yet', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const promoteAgent = await freshAgent();
    // An older plain chat and a newer goal-work chat.
    const [older] = await db
      .insert(conversations)
      .values({
        agentId: promoteAgent,
        channel: 'chat',
        trust: 'owner',
        title: 'older',
        updatedAt: new Date('2025-01-01T00:00:00.000Z'),
      })
      .returning();
    await db.insert(conversations).values({
      agentId: promoteAgent,
      channel: 'chat',
      trust: 'owner',
      title: 'goal work',
      metadata: { goalId: '11111111-1111-1111-1111-111111111111' },
      updatedAt: new Date('2025-06-01T00:00:00.000Z'),
    });

    const primary = await getOrCreatePrimaryConversation(db, promoteAgent);
    // The goal chat is newer but excluded; the plain chat is promoted.
    expect(primary.id).toBe((older as NonNullable<typeof older>).id);
    expect(primary.isPrimary).toBe(true);

    await db.delete(conversations).where(eq(conversations.agentId, promoteAgent));
    await db.delete(agents).where(eq(agents.id, promoteAgent));
  });
});
