import { type Db, memories, messages, toolCache } from '@assistant/db';
import { and, eq, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { loadConfig } from '../config.js';
import { releaseStaleReservations } from '../cost.js';
import { purgeStaleLocations } from '../memory/location.js';
import type { ModelRouter } from '../model-router/router.js';

/**
 * Backfill embeddings for recent messages that lack them — this is what makes
 * conversations.search semantic instead of ILIKE-fallback. Runs from the
 * sweep; small batches keep cost negligible (~$0.02 per MILLION tokens).
 */
export async function backfillMessageEmbeddings(
  db: Db,
  router: ModelRouter,
  batch = 20,
): Promise<number> {
  const rows = await db
    .select({ id: messages.id, text: messages.text })
    .from(messages)
    .where(
      and(
        isNull(messages.embedding),
        or(eq(messages.role, 'user'), eq(messages.role, 'assistant')),
        sql`length(${messages.text}) > 20`,
      ),
    )
    .orderBy(sql`${messages.createdAt} desc`)
    .limit(batch);
  if (rows.length === 0) return 0;

  const embeddings = await router.embed(rows.map((r) => r.text.slice(0, 4000)));
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const embedding = embeddings[i];
    if (!row || !embedding) continue;
    await db.update(messages).set({ embedding }).where(eq(messages.id, row.id));
  }
  return rows.length;
}

/** Purge expired tool-cache rows and expired memories. */
export async function purgeExpired(
  db: Db,
  batch = 500,
): Promise<{ cache: number; memories: number; reservations: number; locations: number }> {
  const expiredCache = db
    .select({ id: toolCache.cacheKey })
    .from(toolCache)
    .where(lte(toolCache.expiresAt, sql`now()`))
    .limit(batch);
  const expiredMemories = db
    .select({ id: memories.id })
    .from(memories)
    .where(and(isNotNull(memories.expiresAt), lte(memories.expiresAt, sql`now()`)))
    .limit(batch);
  const [cacheRows, memoryRows, reservations, locations] = await Promise.all([
    db
      .delete(toolCache)
      .where(inArray(toolCache.cacheKey, expiredCache))
      .returning({ id: toolCache.cacheKey }),
    db.delete(memories).where(inArray(memories.id, expiredMemories)).returning({ id: memories.id }),
    releaseStaleReservations(db, 120, batch),
    // Phase 15: location pings are transient — purge past the retention window.
    purgeStaleLocations(db, loadConfig().LOCATION_RETENTION_DAYS, batch),
  ]);
  return {
    cache: cacheRows.length,
    memories: memoryRows.length,
    reservations,
    locations,
  };
}
