import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from './client.js';
import { createPostgresNotificationsConversationRepository } from './notifications-conversation-repository.js';
import { agents, conversations } from './schema.js';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://assistant@127.0.0.1:55432/assistant_test';

describe('PostgreSQL Notifications conversation', () => {
  let db: Db;
  const agentId = randomUUID();

  beforeEach(async () => {
    db = createDb(DATABASE_URL);
    await db.insert(agents).values({
      id: agentId,
      name: 'Notifications owner',
      email: `${agentId}@example.com`,
      workspacePrefix: `workspace/${agentId}`,
    });
  });

  afterEach(async () => {
    await db.delete(conversations).where(eq(conversations.agentId, agentId));
    await db.delete(agents).where(eq(agents.id, agentId));
    await db.$client.end();
  });

  it('converges racing first uses on one conversation', async () => {
    const repository = createPostgresNotificationsConversationRepository(db);
    const ids = await Promise.all(Array.from({ length: 6 }, () => repository.getOrCreate(agentId)));

    const rows = await db
      .select({ id: conversations.id, trust: conversations.trust })
      .from(conversations)
      .where(and(eq(conversations.agentId, agentId), eq(conversations.title, 'Notifications')));
    expect(rows).toEqual([{ id: ids[0], trust: 'assistant' }]);
    expect(new Set(ids).size).toBe(1);
    expect(await repository.getOrCreate(agentId)).toBe(ids[0]);
  });
});
