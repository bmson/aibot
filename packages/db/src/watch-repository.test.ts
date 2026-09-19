import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from './client.js';
import { agents, conversations, suggestions, watches, watchFires } from './schema.js';
import { createPostgresWatchRepository } from './watch-repository.js';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://assistant@127.0.0.1:55432/assistant_test';

describe('PostgreSQL watch repository suggestions', () => {
  let db: Db;
  const ownerId = randomUUID();
  const foreignId = randomUUID();

  beforeEach(async () => {
    db = createDb(DATABASE_URL);
    await db.insert(agents).values([
      {
        id: ownerId,
        name: 'Watch owner',
        email: `${ownerId}@example.com`,
        workspacePrefix: `workspace/${ownerId}`,
      },
      {
        id: foreignId,
        name: 'Foreign owner',
        email: `${foreignId}@example.com`,
        workspacePrefix: `workspace/${foreignId}`,
      },
    ]);
  });

  afterEach(async () => {
    await db.delete(suggestions).where(eq(suggestions.agentId, ownerId));
    await db.delete(watchFires).where(eq(watchFires.agentId, ownerId));
    await db.delete(watches).where(eq(watches.agentId, ownerId));
    await db.delete(conversations).where(inArray(conversations.agentId, [ownerId, foreignId]));
    await db.delete(agents).where(inArray(agents.id, [ownerId, foreignId]));
    await db.$client.end();
  });

  it('serializes identical commits and never returns a foreign conversation', async () => {
    const repository = createPostgresWatchRepository(db);
    const now = new Date('2026-09-19T12:00:00Z');
    const watch = await repository.create({
      agentId: ownerId,
      kind: 'email',
      tier: 'suggest',
      name: 'Suggestion race',
      match: {},
      maxFires: null,
      expiresAt: new Date('2026-09-20T12:00:00Z'),
    });
    const [foreign] = await db
      .insert(conversations)
      .values({ agentId: foreignId, channel: 'chat', trust: 'owner', title: 'Foreign' })
      .returning({ id: conversations.id });
    if (!foreign) throw new Error('foreign conversation fixture failed');
    await db.update(watches).set({ conversationId: foreign.id }).where(eq(watches.id, watch.id));
    await repository.recordFire({
      watchId: watch.id,
      agentId: ownerId,
      triggerRef: 'gmail:race',
      summary: 'race',
      excerpt: 'reply requested',
      now,
    });
    const input = {
      agentId: ownerId,
      watchId: watch.id,
      triggerRef: 'gmail:race',
      summary: 'Reply?',
      proposedAction: 'Draft a reply.',
      now,
    };
    const results = await Promise.all([
      repository.commitSuggestion(input),
      repository.commitSuggestion(input),
    ]);

    expect(results[0]?.suggestion.id).toBe(results[1]?.suggestion.id);
    expect(results[0]?.conversationId).not.toBe(foreign.id);
    const [destination] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, results[0]?.conversationId ?? ''));
    expect(destination).toMatchObject({ agentId: ownerId, title: 'Notifications' });
    expect(
      await db.select().from(suggestions).where(eq(suggestions.agentId, ownerId)),
    ).toHaveLength(1);
    expect(await db.select().from(watchFires).where(eq(watchFires.watchId, watch.id))).toHaveLength(
      1,
    );
  });
});
