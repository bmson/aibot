import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDb, type Db } from './client.js';
import { createPostgresProfileMemoryHubRepository } from './profile-memory-hub-repository.js';
import {
  agents,
  contacts,
  conversations,
  memories,
  messages,
  ownerCard,
  recallFeedback,
  tasks,
} from './schema.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:55432/assistant_test';

describe('PostgreSQL profile Memory hub', () => {
  it('keeps exact aggregates beyond the review inbox limit', async () => {
    const db = createDb(DATABASE_URL);
    const rollback = new Error('test rollback');
    try {
      await expect(
        db.transaction(async (tx) => {
          const repository = createPostgresProfileMemoryHubRepository(tx as unknown as Db);
          const before = await repository.load();
          const configured = await tx.select({ id: agents.id }).from(agents).limit(2);
          const [owner] = await tx
            .select({ id: contacts.id })
            .from(contacts)
            .where(eq(contacts.trust, 'owner'))
            .limit(1);
          if (!configured[0] || !owner) throw new Error('Test seed is missing agent or owner');
          const agentId = configured[0].id;
          const now = new Date();
          await tx.insert(memories).values([
            {
              id: randomUUID(),
              agentId,
              category: 'knowledge',
              kind: 'fact',
              content: 'Confirmed owner fact',
              contentHash: randomUUID(),
              subjectContactId: owner.id,
              ownerConfirmed: true,
              lastConsolidatedAt: now,
            },
            ...Array.from({ length: 105 }, (_, index) => ({
              id: randomUUID(),
              agentId,
              category: 'knowledge',
              kind: 'fact',
              content: `Review ${index}`,
              contentHash: randomUUID(),
              quarantined: true,
              createdAt: new Date(now.getTime() - index * 1000),
            })),
          ]);
          const [conversation] = await tx
            .insert(conversations)
            .values({ agentId, channel: 'chat' })
            .returning({ id: conversations.id });
          if (!conversation) throw new Error('Conversation insert failed');
          const [message] = await tx
            .insert(messages)
            .values({ conversationId: conversation.id, role: 'assistant', origin: 'assistant' })
            .returning({ id: messages.id });
          if (!message) throw new Error('Message insert failed');
          await tx.insert(recallFeedback).values({
            agentId,
            messageId: message.id,
            verdict: 'helpful',
            createdAt: now,
          });
          const [organizer] = await tx
            .insert(tasks)
            .values({
              agentId,
              type: 'adhoc',
              status: 'running',
              progress: 'Organizing',
              trigger: { payload: { job: 'memory.consolidate' } },
            })
            .returning({ id: tasks.id });
          await tx
            .insert(ownerCard)
            .values({ id: 1, content: '  ', compiledAt: now })
            .onConflictDoUpdate({ target: ownerCard.id, set: { content: '  ', compiledAt: now } });

          const after = await repository.load();
          expect(after.quarantined).toHaveLength(100);
          expect(after.memoryHealth.awaitingReview).toBe(before.memoryHealth.awaitingReview + 105);
          expect(after.memoryHealth.totalUsable).toBe(before.memoryHealth.totalUsable + 1);
          expect(after.memoryHealth.ownerConfirmed).toBe(before.memoryHealth.ownerConfirmed + 1);
          expect(after.ownerFactCount).toBe(before.ownerFactCount + 1);
          expect(after.recallFeedback.rated).toBe(before.recallFeedback.rated + 1);
          expect(after.recallFeedback.helpful).toBe(before.recallFeedback.helpful + 1);
          expect(after.latestOrganizer?.id).toBe(organizer?.id);
          expect(after.card?.empty).toBe(true);
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    } finally {
      await db.$client.end();
    }
  });
});
