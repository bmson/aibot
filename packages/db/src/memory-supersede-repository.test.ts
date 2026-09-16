import { createHash, randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from './client.js';
import { createPostgresMemorySupersedeRepository } from './memory-supersede-repository.js';
import { agents, contacts, memories } from './schema.js';

/**
 * The storage half of write-time supersession: which live facts a write is
 * even allowed to consider, and what retiring one records. The decision of
 * which candidate to retire is core's, and is tested there.
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:55432/assistant_test';

/** Unit-length so cosine similarity against `near(1)` is exactly the x term. */
function vector(x: number, y = 0): number[] {
  return [x, y, ...new Array(1534).fill(0)];
}

const NEAR = vector(1);
/** Orthogonal to NEAR: similarity 0, far below the candidate floor. */
const FAR = vector(0, 1);
/** cos ≈ 0.7 — deliberately just under SUPERSEDE_SIMILARITY_FLOOR (0.78). */
const BORDERLINE = vector(0.7, Math.sqrt(1 - 0.7 ** 2));

describe('PostgreSQL memory supersession', () => {
  const ownerId = randomUUID();
  const foreignOwnerId = randomUUID();
  const subjectA = randomUUID();
  const subjectB = randomUUID();
  let db: Db;
  let repository: ReturnType<typeof createPostgresMemorySupersedeRepository>;
  const created: string[] = [];

  async function insertFact(input: {
    content: string;
    agentId?: string;
    embedding?: number[];
    confidence?: string;
    ownerConfirmed?: boolean;
    quarantined?: boolean;
    subjectContactId?: string | null;
    category?: string;
    expiresAt?: Date;
  }): Promise<string> {
    const [row] = await db
      .insert(memories)
      .values({
        agentId: input.agentId ?? ownerId,
        category: input.category ?? 'knowledge',
        kind: 'fact',
        content: input.content,
        contentHash: createHash('sha256').update(input.content).digest('hex'),
        embedding: input.embedding ?? NEAR,
        confidence: input.confidence ?? '0.70',
        originTrust: 'owner',
        quarantined: input.quarantined ?? false,
        ownerConfirmed: input.ownerConfirmed ?? false,
        subjectContactId: input.subjectContactId === undefined ? null : input.subjectContactId,
        ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      })
      .returning({ id: memories.id });
    const id = (row as NonNullable<typeof row>).id;
    created.push(id);
    return id;
  }

  /** The candidate ids one write would be offered, in the order returned. */
  async function candidateIdsFor(newFactId: string, subjectContactId: string | null) {
    const rows = await repository.candidates({
      agentId: ownerId,
      newFactId,
      embedding: NEAR,
      subjectContactId,
    });
    return rows.map((row) => row.id);
  }

  beforeAll(async () => {
    db = createDb(DATABASE_URL);
    repository = createPostgresMemorySupersedeRepository(db);
    await db.insert(agents).values([
      {
        id: ownerId,
        name: 'Supersede owner',
        email: `${ownerId}@test.local`,
        workspacePrefix: `tests/${ownerId}`,
      },
      {
        id: foreignOwnerId,
        name: 'Foreign supersede owner',
        email: `${foreignOwnerId}@test.local`,
        workspacePrefix: `tests/${foreignOwnerId}`,
      },
    ]);
    // `memories.subject_contact_id` is a real foreign key, and subject scoping
    // is the behaviour under test — so these have to be actual contact rows.
    await db.insert(contacts).values([
      { id: subjectA, name: 'Subject A' },
      { id: subjectB, name: 'Subject B' },
    ]);
  });

  afterAll(async () => {
    if (created.length > 0) {
      // Retired rows reference their replacement, so the provenance has to go
      // before the delete or the self-reference blocks it.
      await db.update(memories).set({ supersededById: null }).where(inArray(memories.id, created));
      await db.delete(memories).where(inArray(memories.id, created));
    }
    await db.delete(agents).where(inArray(agents.id, [ownerId, foreignOwnerId]));
    await db.delete(contacts).where(inArray(contacts.id, [subjectA, subjectB]));
  });

  it('reads back the written fact with what its search needs', async () => {
    const id = await insertFact({
      content: 'supersede: written fact',
      subjectContactId: subjectA,
    });

    const written = await repository.writtenFact({ agentId: ownerId, id });

    expect(written?.id).toBe(id);
    expect(written?.subjectContactId).toBe(subjectA);
    expect(written?.embedding).toHaveLength(1536);
    expect(written?.ownerConfirmed).toBe(false);
  });

  it("will not read another agent's fact", async () => {
    const id = await insertFact({
      content: 'supersede: foreign fact',
      agentId: foreignOwnerId,
    });

    expect(await repository.writtenFact({ agentId: ownerId, id })).toBeNull();
  });

  it('offers a near, live fact about the same subject', async () => {
    const stale = await insertFact({
      content: 'supersede: lives in Oslo',
      subjectContactId: subjectA,
    });
    const fresh = await insertFact({
      content: 'supersede: lives in Reykjavik',
      subjectContactId: subjectA,
    });

    expect(await candidateIdsFor(fresh, subjectA)).toContain(stale);
  });

  it('excludes a fact below the similarity floor', async () => {
    const borderline = await insertFact({
      content: 'supersede: barely related',
      subjectContactId: subjectB,
      embedding: BORDERLINE,
    });
    const distant = await insertFact({
      content: 'supersede: unrelated topic',
      subjectContactId: subjectB,
      embedding: FAR,
    });
    const fresh = await insertFact({
      content: 'supersede: subject b write',
      subjectContactId: subjectB,
    });

    const offered = await candidateIdsFor(fresh, subjectB);

    expect(offered).not.toContain(borderline);
    expect(offered).not.toContain(distant);
  });

  it('excludes quarantined, expired, and already-retired facts', async () => {
    const quarantined = await insertFact({
      content: 'supersede: unreviewed claim',
      subjectContactId: subjectA,
      quarantined: true,
    });
    const expired = await insertFact({
      content: 'supersede: already expired',
      subjectContactId: subjectA,
      expiresAt: new Date(Date.now() - 60_000),
    });
    const experience = await insertFact({
      content: 'supersede: an episode, not a claim',
      subjectContactId: subjectA,
      category: 'experience',
    });
    const fresh = await insertFact({
      content: 'supersede: exclusions write',
      subjectContactId: subjectA,
    });

    const offered = await candidateIdsFor(fresh, subjectA);

    expect(offered).not.toContain(quarantined);
    expect(offered).not.toContain(expired);
    expect(offered).not.toContain(experience);
    expect(offered).not.toContain(fresh);
  });

  it('never offers a fact about a different subject', async () => {
    // Same words and the same point in embedding space — separated only by
    // who the fact is about.
    const other = await insertFact({
      content: 'supersede: lives in Oslo (different person)',
      subjectContactId: subjectB,
    });
    const fresh = await insertFact({
      content: 'supersede: subject scoping write',
      subjectContactId: subjectA,
    });

    expect(await candidateIdsFor(fresh, subjectA)).not.toContain(other);
  });

  it('retires a fact and records what replaced it', async () => {
    const stale = await insertFact({ content: 'supersede: retire me', subjectContactId: subjectA });
    const fresh = await insertFact({
      content: 'supersede: the replacement',
      subjectContactId: subjectA,
    });

    const retired = await repository.retire({
      agentId: ownerId,
      replacementId: fresh,
      ids: [stale],
    });

    expect(retired).toEqual([stale]);
    const [row] = await db
      .select({ expiresAt: memories.expiresAt, supersededById: memories.supersededById })
      .from(memories)
      .where(eq(memories.id, stale))
      .limit(1);
    expect(row?.supersededById).toBe(fresh);
    expect(row?.expiresAt).not.toBeNull();
    // The replacement must stay live — it is the answer now.
    const [live] = await db
      .select({ expiresAt: memories.expiresAt })
      .from(memories)
      .where(eq(memories.id, fresh))
      .limit(1);
    expect(live?.expiresAt).toBeNull();
  });

  it('leaves an already-retired fact to its first replacement', async () => {
    const stale = await insertFact({ content: 'supersede: contested', subjectContactId: subjectA });
    const first = await insertFact({
      content: 'supersede: first claim',
      subjectContactId: subjectA,
    });
    const second = await insertFact({
      content: 'supersede: second claim',
      subjectContactId: subjectA,
    });

    await repository.retire({ agentId: ownerId, replacementId: first, ids: [stale] });
    const again = await repository.retire({
      agentId: ownerId,
      replacementId: second,
      ids: [stale],
    });

    expect(again).toEqual([]);
    const [row] = await db
      .select({ supersededById: memories.supersededById })
      .from(memories)
      .where(eq(memories.id, stale))
      .limit(1);
    expect(row?.supersededById).toBe(first);
  });

  it("will not retire another agent's fact", async () => {
    const foreign = await insertFact({
      content: 'supersede: foreign target',
      agentId: foreignOwnerId,
    });
    const fresh = await insertFact({
      content: 'supersede: local write',
      subjectContactId: subjectA,
    });

    expect(
      await repository.retire({ agentId: ownerId, replacementId: fresh, ids: [foreign] }),
    ).toEqual([]);
  });

  it('never retires the replacement itself', async () => {
    const fresh = await insertFact({
      content: 'supersede: self target',
      subjectContactId: subjectA,
    });

    expect(
      await repository.retire({ agentId: ownerId, replacementId: fresh, ids: [fresh] }),
    ).toEqual([]);
  });
});
