import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Db } from './client.js';
import { createDb } from './client.js';
import { createPostgresPrivacyExportRepository } from './privacy-export-repository.js';
import {
  knowledgeGraphEntities,
  knowledgeGraphRelations,
  memories,
  memoryTombstones,
} from './schema.js';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://assistant@127.0.0.1:55432/assistant_test';

describe('PostgreSQL privacy export repository', () => {
  it('projects owner-visible memory fields without embeddings or internal hashes', async () => {
    const db = createDb(DATABASE_URL);
    try {
      await expect(
        db.transaction(async (tx) => {
          const configured = await tx.query.agents.findMany({ columns: { id: true }, limit: 2 });
          if (configured.length !== 1 || !configured[0])
            throw new Error('Privacy export test requires one seeded agent');
          const id = randomUUID();
          const forgottenId = randomUUID();
          const forgottenHash = randomUUID();
          await tx.insert(memories).values({
            id,
            agentId: configured[0].id,
            category: 'knowledge',
            kind: 'fact',
            content: 'Owner-visible privacy export test fact',
            contentHash: randomUUID(),
            embedding: Array.from({ length: 1536 }, () => 0.25),
          });
          await tx.insert(memories).values({
            id: forgottenId,
            agentId: configured[0].id,
            category: 'knowledge',
            kind: 'fact',
            content: 'Forgotten privacy export test fact',
            contentHash: forgottenHash,
          });
          await tx.insert(memoryTombstones).values({ contentHash: forgottenHash });
          const subjectId = randomUUID();
          const objectId = randomUUID();
          await tx.insert(knowledgeGraphEntities).values([
            {
              id: subjectId,
              agentId: configured[0].id,
              canonicalKey: `topic:${subjectId}`,
              label: 'Subject',
              kind: 'topic',
            },
            {
              id: objectId,
              agentId: configured[0].id,
              canonicalKey: `topic:${objectId}`,
              label: 'Object',
              kind: 'topic',
            },
          ]);
          await tx.insert(knowledgeGraphRelations).values([
            {
              agentId: configured[0].id,
              subjectEntityId: subjectId,
              predicate: 'knows',
              objectEntityId: objectId,
              sourceMemoryId: id,
              sourceFingerprint: randomUUID(),
              ordinal: 0,
            },
            {
              agentId: configured[0].id,
              subjectEntityId: subjectId,
              predicate: 'knows',
              objectEntityId: objectId,
              sourceMemoryId: forgottenId,
              sourceFingerprint: randomUUID(),
              ordinal: 0,
            },
          ]);
          const result = await createPostgresPrivacyExportRepository(
            tx as unknown as Db,
          ).exportOwnerData();
          const row = result.memories.find((candidate) => candidate.id === id);
          expect(row).toEqual({
            id,
            category: 'knowledge',
            kind: 'fact',
            content: 'Owner-visible privacy export test fact',
            importance: 3,
            confidence: '0.70',
            originTrust: 'owner',
            quarantined: false,
            domain: null,
            ownerConfirmed: false,
            pinned: false,
            source: null,
            createdAt: expect.any(Date),
            expiresAt: null,
          });
          expect(row).not.toHaveProperty('embedding');
          expect(row).not.toHaveProperty('contentHash');
          expect(result.memories.map((candidate) => candidate.id)).not.toContain(forgottenId);
          expect(result.knowledgeGraph.relations).toHaveLength(1);
          expect(result.knowledgeGraph.relations[0]?.sourceMemoryId).toBe(id);
          throw new Error('rollback privacy export fixture');
        }),
      ).rejects.toThrow('rollback privacy export fixture');
    } finally {
      await db.$client.end();
    }
  });
});
