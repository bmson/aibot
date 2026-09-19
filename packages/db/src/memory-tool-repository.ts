import {
  type EmbeddingSpace,
  type MemoryRecallResult,
  type MemorySaveInput,
  type MemorySaveResult,
  type MemoryToolRepository,
  validateEmbedding,
  validateSkillEmbedding,
} from '@assistant/persistence';
import { and, eq, gt, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { isTombstoned, resolveSubjectContact } from './entities.js';
import { memories, memoryTombstones } from './schema.js';

const LEXICAL_MATCH_BONUS = 0.06;

function validateVector(space: EmbeddingSpace | undefined, vector: number[]): void {
  if (space) validateEmbedding(space, vector);
  else validateSkillEmbedding(vector);
}

function validateSave(input: MemorySaveInput, space: EmbeddingSpace | undefined): void {
  if (!input.agentId || !input.content || !input.contentHash || !input.originTrust)
    throw new Error('Invalid memory save');
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)
    throw new Error('Invalid memory confidence');
  if (!Number.isInteger(input.importance) || input.importance < 1 || input.importance > 5)
    throw new Error('Invalid memory importance');
  validateVector(space, input.embedding);
  if (input.expiresAt && !Number.isFinite(input.expiresAt.getTime()))
    throw new Error('Invalid memory expiry');
}

function lexicalTerms(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((term) => term.length > 2)
    .slice(0, 5);
}

export function createPostgresMemoryToolRepository(
  db: Db,
  embeddingSpace?: EmbeddingSpace,
): MemoryToolRepository {
  return {
    kind: 'memory-tool-repository',
    embeddingSpace,

    async save(input): Promise<MemorySaveResult> {
      validateSave(input, embeddingSpace);
      if (await isTombstoned(db, input.contentHash)) {
        return { saved: false, duplicate: false, tombstoned: true, quarantined: input.quarantined };
      }
      const subject = input.subject
        ? await resolveSubjectContact(db, {
            subject: input.subject,
            relationship: input.subjectRelationship,
          })
        : null;
      return db.transaction(async (tx) => {
        const [tombstone] = await tx
          .select({ id: memoryTombstones.id })
          .from(memoryTombstones)
          .where(eq(memoryTombstones.contentHash, input.contentHash))
          .limit(1);
        if (tombstone)
          return {
            saved: false,
            duplicate: false,
            tombstoned: true,
            quarantined: input.quarantined,
          };
        const [row] = await tx
          .insert(memories)
          .values({
            agentId: input.agentId,
            category: input.category,
            kind: input.kind,
            content: input.content,
            contentHash: input.contentHash,
            embedding: input.embedding,
            importance: input.importance,
            confidence: input.confidence.toFixed(2),
            originTrust: input.originTrust,
            quarantined: input.quarantined,
            subjectContactId: subject?.contactId,
            domain: input.domain,
            sourceTaskId: input.sourceTaskId,
            expiresAt: input.expiresAt,
          })
          .onConflictDoNothing({ target: memories.contentHash })
          .returning({ id: memories.id });
        return {
          ...(row ? { id: row.id } : {}),
          saved: Boolean(row),
          duplicate: !row,
          tombstoned: false,
          quarantined: input.quarantined,
        };
      });
    },

    async recall(input): Promise<MemoryRecallResult> {
      if (
        !input.agentId ||
        !input.query ||
        !Number.isInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > 20
      )
        throw new Error('Invalid memory recall');
      validateVector(embeddingSpace, input.embedding);
      const now = input.now ?? new Date();
      if (!Number.isFinite(now.getTime())) throw new Error('Invalid memory recall time');
      const vector = JSON.stringify(input.embedding);
      const distance = sql<number>`(${memories.embedding} <=> ${vector}::vector)`;
      const terms = lexicalTerms(input.query);
      const lexicalMatch =
        terms.length > 0
          ? sql<boolean>`${memories.content} ~* ${`\\y(${terms.join('|')})\\y`}`
          : undefined;
      const candidateLimit = Math.min(100, input.limit * 4);
      return db.transaction(async (tx) => {
        const rows = await tx
          .select({
            id: memories.id,
            content: memories.content,
            category: memories.category,
            kind: memories.kind,
            importance: memories.importance,
            confidence: memories.confidence,
            validFrom: memories.validFrom,
            validUntil: memories.validUntil,
            source: memories.source,
            ownerConfirmed: memories.ownerConfirmed,
            createdAt: memories.createdAt,
            expiresAt: memories.expiresAt,
            agentId: memories.agentId,
            sourceTaskId: memories.sourceTaskId,
            contentHash: memories.contentHash,
            goalId: memories.goalId,
            originTrust: memories.originTrust,
            quarantined: memories.quarantined,
            subjectContactId: memories.subjectContactId,
            domain: memories.domain,
            supersededById: memories.supersededById,
            pinned: memories.pinned,
            lastAccessedAt: memories.lastAccessedAt,
            lastConsolidatedAt: memories.lastConsolidatedAt,
            similarity: sql<number>`1 - ${distance}`,
          })
          .from(memories)
          .where(
            and(
              eq(memories.agentId, input.agentId),
              eq(memories.quarantined, false),
              isNull(memories.supersededById),
              isNotNull(memories.embedding),
              or(isNull(memories.expiresAt), gt(memories.expiresAt, now)),
            ),
          )
          .orderBy(
            lexicalMatch
              ? sql`${distance} - CASE WHEN ${lexicalMatch} THEN ${sql.raw(String(LEXICAL_MATCH_BONUS))} ELSE 0 END`
              : distance,
          )
          .limit(candidateLimit);
        const selected = rows.slice(0, input.limit);
        if (selected.length) {
          await tx
            .update(memories)
            .set({ lastAccessedAt: now })
            .where(
              inArray(
                memories.id,
                selected.map((row) => row.id),
              ),
            );
        }
        return {
          memories: selected,
          candidateLimitReached: rows.length === candidateLimit,
        };
      });
    },
  };
}
