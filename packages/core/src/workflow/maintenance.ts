import {
  approvals,
  conversationSegments,
  costEvents,
  type Db,
  memories,
  messages,
  modelCalls,
  toolCache,
  toolCalls,
} from '@assistant/db';
import { and, eq, inArray, isNotNull, isNull, lte, notExists, or, sql } from 'drizzle-orm';
import { loadConfig } from '../config.js';
import { releaseStaleReservations } from '../cost.js';
import { purgeStaleLocations } from '../memory/location.js';
import { purgeStaleRecallMetrics } from '../memory/recall-metrics.js';
import type { ModelRouter } from '../model-router/router.js';
import { purgeStaleDreamNotes } from './dream.js';

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
): Promise<{
  cache: number;
  memories: number;
  reservations: number;
  locations: number;
  dreamNotes: number;
  recallMetrics: number;
}> {
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
  const [cacheRows, memoryRows, reservations, locations, dreamNotes, recallMetrics] =
    await Promise.all([
      db
        .delete(toolCache)
        .where(inArray(toolCache.cacheKey, expiredCache))
        .returning({ id: toolCache.cacheKey }),
      db
        .delete(memories)
        .where(inArray(memories.id, expiredMemories))
        .returning({ id: memories.id }),
      releaseStaleReservations(db, 120, batch),
      // Phase 15: location pings are transient — purge past the retention window.
      purgeStaleLocations(db, loadConfig().LOCATION_RETENTION_DAYS, batch),
      // Phase 20: dream notes are kept 7 days for inspection, then purged.
      purgeStaleDreamNotes(db, batch),
      // Operational counters do not need the owner's long-term history policy.
      purgeStaleRecallMetrics(db, 90, batch),
    ]);
  return {
    cache: cacheRows.length,
    memories: memoryRows.length,
    reservations,
    locations,
    dreamNotes,
    recallMetrics,
  };
}

export interface AgedHistoryCounts {
  messages: number;
  toolCalls: number;
  modelCalls: number;
  costEvents: number;
}

/**
 * Age-based retention for the four tables that otherwise grow without bound:
 * messages, tool_calls, model_calls, and cost_events. Ships disabled — both
 * retention knobs default to 0 (keep forever) because pruning the owner's
 * history is their policy call, not the platform's. Batched so a first run
 * against years of backlog drains across sweeps instead of locking tables.
 *
 * What survives its cutoff, and why:
 * - messages anchored by a conversation segment — the segment summary is the
 *   recall unit and references its message range by id.
 * - tool_calls referenced by an approval (the owner's decision record) or by
 *   a still-retained cost event; those become eligible once the cost ledger's
 *   own retention passes.
 */
export async function purgeAgedHistory(
  db: Db,
  overrides?: { historyDays?: number; costDays?: number; batch?: number },
): Promise<AgedHistoryCounts> {
  const config = loadConfig();
  const historyDays = overrides?.historyDays ?? config.HISTORY_RETENTION_DAYS;
  const costDays = overrides?.costDays ?? config.COST_RETENTION_DAYS;
  const batch = overrides?.batch ?? 1000;
  const counts: AgedHistoryCounts = { messages: 0, toolCalls: 0, modelCalls: 0, costEvents: 0 };

  // Cost first: deleting an aged cost event frees its tool_call for the
  // history pass below within the same sweep.
  if (costDays > 0) {
    const costCutoff = sql`now() - make_interval(days => ${costDays})`;
    const agedCostEvents = db
      .select({ id: costEvents.id })
      .from(costEvents)
      .where(lte(costEvents.createdAt, costCutoff))
      .limit(batch);
    const deleted = await db
      .delete(costEvents)
      .where(inArray(costEvents.id, agedCostEvents))
      .returning({ id: costEvents.id });
    counts.costEvents = deleted.length;
  }

  if (historyDays > 0) {
    const cutoff = sql`now() - make_interval(days => ${historyDays})`;
    const agedMessages = db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          lte(messages.createdAt, cutoff),
          notExists(
            db
              .select({ one: sql`1` })
              .from(conversationSegments)
              .where(
                or(
                  eq(conversationSegments.startMessageId, messages.id),
                  eq(conversationSegments.endMessageId, messages.id),
                ),
              ),
          ),
        ),
      )
      .limit(batch);
    const agedToolCalls = db
      .select({ id: toolCalls.id })
      .from(toolCalls)
      .where(
        and(
          lte(toolCalls.createdAt, cutoff),
          notExists(
            db
              .select({ one: sql`1` })
              .from(approvals)
              .where(eq(approvals.toolCallId, toolCalls.id)),
          ),
          notExists(
            db
              .select({ one: sql`1` })
              .from(costEvents)
              .where(eq(costEvents.toolCallId, toolCalls.id)),
          ),
        ),
      )
      .limit(batch);
    const agedModelCalls = db
      .select({ id: modelCalls.id })
      .from(modelCalls)
      .where(lte(modelCalls.createdAt, cutoff))
      .limit(batch);
    const [deletedMessages, deletedToolCalls, deletedModelCalls] = await Promise.all([
      db.delete(messages).where(inArray(messages.id, agedMessages)).returning({ id: messages.id }),
      db
        .delete(toolCalls)
        .where(inArray(toolCalls.id, agedToolCalls))
        .returning({ id: toolCalls.id }),
      db
        .delete(modelCalls)
        .where(inArray(modelCalls.id, agedModelCalls))
        .returning({ id: modelCalls.id }),
    ]);
    counts.messages = deletedMessages.length;
    counts.toolCalls = deletedToolCalls.length;
    counts.modelCalls = deletedModelCalls.length;
  }

  return counts;
}
