import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createDb, type Db } from './client.js';
import { createPostgresProfileOverviewRepository } from './profile-full-overview-repository.js';
import { agents, contacts, memories, ownerCard } from './schema.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:55432/assistant_test';

describe('PostgreSQL full Profile overview', () => {
  it('projects active owner facts and exact people counts through the shared read', async () => {
    const db = createDb(DATABASE_URL);
    const rollback = new Error('test rollback');
    try {
      await expect(
        db.transaction(async (tx) => {
          const repository = createPostgresProfileOverviewRepository(tx as unknown as Db);
          const before = await repository.load();
          const configured = await tx.select({ id: agents.id }).from(agents).limit(2);
          if (!configured[0] || !before.owner) throw new Error('Test seed is incomplete');
          const agentId = configured[0].id;
          const personId = randomUUID();
          await tx.insert(contacts).values({
            id: personId,
            name: 'Profile test person',
            trust: 'known',
            relationship: 'friend',
          });
          const ownerFactId = randomUUID();
          await tx.insert(memories).values([
            {
              id: ownerFactId,
              agentId,
              category: 'knowledge',
              kind: 'fact',
              content: 'Owner fact',
              contentHash: randomUUID(),
              subjectContactId: before.owner.id,
              pinned: true,
              importance: 5,
            },
            {
              id: randomUUID(),
              agentId,
              category: 'knowledge',
              kind: 'fact',
              content: 'Person fact',
              contentHash: randomUUID(),
              subjectContactId: personId,
            },
            {
              id: randomUUID(),
              agentId,
              category: 'knowledge',
              kind: 'fact',
              content: 'Expired person fact',
              contentHash: randomUUID(),
              subjectContactId: personId,
              expiresAt: new Date('2020-01-01T00:00:00Z'),
            },
          ]);
          const compiledAt = new Date('2026-09-22T12:00:00Z');
          await tx
            .insert(ownerCard)
            .values({ id: 1, content: 'Compiled owner card', compiledAt })
            .onConflictDoUpdate({
              target: ownerCard.id,
              set: { content: 'Compiled owner card', compiledAt },
            });
          const after = await repository.load();
          expect(after.people.find((row) => row.contact.id === personId)).toMatchObject({
            factCount: 1,
          });
          expect(after.ownerFacts.some((fact) => fact.id === ownerFactId)).toBe(true);
          expect(after.memoryHealth.totalUsable).toBe(before.memoryHealth.totalUsable + 2);
          expect(after.card).toEqual({ content: 'Compiled owner card', compiledAt });
          expect(after.voiceStats).toEqual(before.voiceStats);
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    } finally {
      await db.$client.end();
    }
  });
});
