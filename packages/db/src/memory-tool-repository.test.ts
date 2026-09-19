import { createHash, randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { createDb } from './client.js';
import { createPostgresMemoryToolRepository } from './memory-tool-repository.js';
import { agents, contacts, memories, memoryTombstones } from './schema.js';

const vector = Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0));

describe('PostgreSQL memory tool repository', () => {
  const url = process.env.DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith('_test'))
    throw new Error('Requires isolated _test database');
  const db = createDb(url);
  const memoryIds: string[] = [];
  const hashes: string[] = [];
  const contactIds: string[] = [];

  afterEach(async () => {
    if (memoryIds.length)
      await db.delete(memories).where(inArray(memories.id, memoryIds.splice(0)));
    if (contactIds.length)
      await db.delete(contacts).where(inArray(contacts.id, contactIds.splice(0)));
    if (hashes.length)
      await db
        .delete(memoryTombstones)
        .where(inArray(memoryTombstones.contentHash, hashes.splice(0)));
  });

  it('saves idempotently, resolves subjects, and hybrid-ranks safe memories while bumping access', async () => {
    const [agent] = await db.select().from(agents).limit(1);
    if (!agent) throw new Error('Seed the test database');
    const repo = createPostgresMemoryToolRepository(db);
    const now = new Date('2026-09-12T12:00:00Z');
    const save = async (content: string, overrides: Record<string, unknown> = {}) => {
      const contentHash = createHash('sha256').update(`${content}-${randomUUID()}`).digest('hex');
      hashes.push(contentHash);
      const result = await repo.save({
        agentId: agent.id,
        content,
        contentHash,
        embedding: vector,
        category: 'knowledge',
        kind: 'fact',
        importance: 3,
        confidence: 0.9,
        originTrust: 'owner',
        quarantined: false,
        ...overrides,
      });
      if (result.saved) {
        const [row] = await db
          .select({ id: memories.id })
          .from(memories)
          .where(eq(memories.contentHash, contentHash));
        if (row) memoryIds.push(row.id);
      }
      return { contentHash, result };
    };

    const coffee = await save('The owner prefers coffee in the morning.');
    await save('The owner enjoys a quiet morning.');
    await save('A quarantined coffee note.', { quarantined: true, originTrust: 'unknown' });
    await save('An expired coffee note.', { expiresAt: new Date(now.getTime() - 1) });

    expect(
      (
        await repo.save({
          agentId: agent.id,
          content: 'The owner prefers coffee in the morning.',
          contentHash: coffee.contentHash,
          embedding: vector,
          category: 'knowledge',
          kind: 'fact',
          importance: 3,
          confidence: 0.9,
          originTrust: 'owner',
          quarantined: false,
        })
      ).duplicate,
    ).toBe(true);

    const recalled = await repo.recall({
      agentId: agent.id,
      embedding: vector,
      query: 'coffee',
      limit: 2,
      now,
    });
    expect(recalled.memories[0]?.content).toContain('coffee');
    expect(recalled.memories).toHaveLength(2);
    expect(recalled.memories.some((row) => row.content.startsWith('A quarantined'))).toBe(false);
    expect(recalled.memories.some((row) => row.content.startsWith('An expired'))).toBe(false);
    const [accessed] = await db
      .select({ lastAccessedAt: memories.lastAccessedAt })
      .from(memories)
      .where(eq(memories.contentHash, coffee.contentHash));
    expect(accessed?.lastAccessedAt?.getTime()).toBe(now.getTime());
  });

  it('honors tombstones and creates a durable subject contact', async () => {
    const [agent] = await db.select().from(agents).limit(1);
    if (!agent) throw new Error('Seed the test database');
    const repo = createPostgresMemoryToolRepository(db);
    const contentHash = createHash('sha256').update(randomUUID()).digest('hex');
    hashes.push(contentHash);
    await db.insert(memoryTombstones).values({ contentHash, reason: 'test' });
    const forgotten = await repo.save({
      agentId: agent.id,
      content: 'A forgotten fact.',
      contentHash,
      embedding: vector,
      category: 'knowledge',
      kind: 'fact',
      importance: 3,
      confidence: 1,
      originTrust: 'owner',
      quarantined: false,
    });
    expect(forgotten).toMatchObject({ saved: false, duplicate: false, tombstoned: true });

    const subjectHash = createHash('sha256').update(randomUUID()).digest('hex');
    hashes.push(subjectHash);
    const saved = await repo.save({
      agentId: agent.id,
      content: 'Alex likes hiking.',
      contentHash: subjectHash,
      embedding: vector,
      category: 'knowledge',
      kind: 'person',
      importance: 3,
      confidence: 0.8,
      originTrust: 'owner',
      quarantined: false,
      subject: `Alex ${randomUUID().slice(0, 8)}`,
    });
    expect(saved.saved).toBe(true);
    const [row] = await db
      .select({ id: memories.id, subjectContactId: memories.subjectContactId })
      .from(memories)
      .where(eq(memories.contentHash, subjectHash));
    expect(row?.subjectContactId).toBeTruthy();
    if (row?.id) memoryIds.push(row.id);
    if (row?.subjectContactId) contactIds.push(row.subjectContactId);
  });
});
