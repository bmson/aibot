import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Db } from './client.js';
import { createDb } from './client.js';
import { createPostgresPrivacyExportRepository } from './privacy-export-repository.js';
import { memories } from './schema.js';

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
          await tx.insert(memories).values({
            id,
            agentId: configured[0].id,
            category: 'knowledge',
            kind: 'fact',
            content: 'Owner-visible privacy export test fact',
            contentHash: randomUUID(),
            embedding: Array.from({ length: 1536 }, () => 0.25),
          });
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
          throw new Error('rollback privacy export fixture');
        }),
      ).rejects.toThrow('rollback privacy export fixture');
    } finally {
      await db.$client.end();
    }
  });
});
