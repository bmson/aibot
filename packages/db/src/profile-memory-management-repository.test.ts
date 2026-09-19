import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDb, type Db } from './client.js';
import { createPostgresProfileMemoryManagementRepository } from './profile-memory-management-repository.js';
import { agents, contacts, memories, memoryTombstones } from './schema.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:55432/assistant_test';

function unitVector(): number[] {
  return [1, ...new Array(1535).fill(0)];
}

async function close(db: Db): Promise<void> {
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end();
}

describe('PostgreSQL profile memory management repository', () => {
  it('returns the owned duplicate for card recovery and approves idempotently', async () => {
    const db = createDb(DATABASE_URL);
    const contactId = randomUUID();
    const contentHash = `profile-memory-duplicate-${randomUUID()}`;
    try {
      const configured = await db.select({ id: agents.id }).from(agents).limit(2);
      if (configured.length !== 1 || !configured[0])
        throw new Error('Profile memory test requires the seeded single-agent test database');
      await db.insert(contacts).values({ id: contactId, name: 'Profile memory subject' });
      const repository = createPostgresProfileMemoryManagementRepository(db);
      const input = {
        content: 'A profile memory duplicate',
        contentHash,
        embedding: unitVector(),
        importance: 4,
        pinned: false,
        subjectContactId: contactId,
      };
      const created = await repository.create(input);
      if (created.status !== 'updated') throw new Error('Profile memory was not created');
      expect(await repository.create(input)).toEqual({
        status: 'duplicate',
        memory: created.memory,
      });
      expect(await repository.approveQuarantined(created.memory.id)).toEqual({
        status: 'updated',
        memory: created.memory,
      });
      expect(await repository.approveQuarantined(created.memory.id)).toEqual({
        status: 'updated',
        memory: created.memory,
      });
    } finally {
      await db.delete(memories).where(eq(memories.contentHash, contentHash));
      await db.delete(contacts).where(eq(contacts.id, contactId));
      await close(db);
    }
  });

  it('locks the source row so a stale correction cannot commit a tombstone', async () => {
    const repositoryDb = createDb(DATABASE_URL);
    const legacyDb = createDb(DATABASE_URL);
    const id = randomUUID();
    const originalHash = `profile-memory-original-${randomUUID()}`;
    const legacyHash = `profile-memory-legacy-${randomUUID()}`;
    const correctionHash = `profile-memory-correction-${randomUUID()}`;
    let releaseLegacy!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseLegacy = resolve;
    });
    let locked!: () => void;
    const rowLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });

    try {
      const configured = await repositoryDb.select({ id: agents.id }).from(agents).limit(2);
      if (configured.length !== 1 || !configured[0])
        throw new Error('Profile memory test requires the seeded single-agent test database');
      await repositoryDb.insert(memories).values({
        id,
        agentId: configured[0].id,
        category: 'knowledge',
        kind: 'fact',
        content: 'Original fact',
        contentHash: originalHash,
        embedding: unitVector(),
      });

      const legacyWrite = legacyDb.transaction(async (tx) => {
        await tx
          .update(memories)
          .set({ content: 'Legacy concurrent edit', contentHash: legacyHash })
          .where(eq(memories.id, id));
        locked();
        await release;
      });
      await rowLocked;

      const correction = createPostgresProfileMemoryManagementRepository(repositoryDb).correct({
        memoryId: id,
        expectedContentHash: originalHash,
        content: 'Owner correction',
        contentHash: correctionHash,
        embedding: unitVector(),
      });
      // Give an implementation without FOR UPDATE enough time to read the old
      // committed hash and write its tombstone before blocking on the UPDATE.
      await new Promise((resolve) => setTimeout(resolve, 100));
      releaseLegacy();
      await legacyWrite;

      expect(await correction).toEqual({ status: 'stale' });
      expect(
        await repositoryDb
          .select({ id: memoryTombstones.id })
          .from(memoryTombstones)
          .where(eq(memoryTombstones.contentHash, originalHash)),
      ).toEqual([]);
      const [stored] = await repositoryDb
        .select({ contentHash: memories.contentHash })
        .from(memories)
        .where(eq(memories.id, id));
      expect(stored?.contentHash).toBe(legacyHash);
    } finally {
      releaseLegacy();
      await repositoryDb.delete(memories).where(eq(memories.id, id));
      await repositoryDb
        .delete(memoryTombstones)
        .where(eq(memoryTombstones.contentHash, originalHash));
      await Promise.all([close(repositoryDb), close(legacyDb)]);
    }
  });
});
