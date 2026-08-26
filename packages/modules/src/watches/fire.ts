import { persistMessage } from '@assistant/core';
import { type Db, type WatchRow, watches, watchFires } from '@assistant/db';
import { and, eq, sql } from 'drizzle-orm';
import type { OwnerNotifier } from '../platform.js';

/** What recording a watch firing needs: the database and the owner-notifier port. */
export interface WatchFireDeps {
  db: Db;
  notifyOwner: OwnerNotifier['notifyOwner'];
}

/**
 * Record one watch firing idempotently and notify the owner. The unique
 * (watch_id, trigger_ref) index is the fence: a repeated trigger returns false
 * without re-notifying or re-counting. On a genuine fire it bumps fireCount,
 * exhausts a bounded watch once it reaches maxFires, posts the notice to the
 * watch's chat, and pings the owner. Shared by the email matcher and the web
 * poller so both behave identically. The owner-facing text is caller-supplied
 * and must never contain raw watched content — only a spec-derived summary.
 */
export async function recordWatchFire(
  deps: WatchFireDeps,
  watch: WatchRow,
  fire: { triggerRef: string; text: string; channelMessageId: string; excerpt?: string },
  now: Date,
): Promise<boolean> {
  const [recorded] = await deps.db
    .insert(watchFires)
    .values({
      watchId: watch.id,
      agentId: watch.agentId,
      triggerRef: fire.triggerRef,
      summary: fire.text,
      // Bounded trigger text for the suggest tier's compose step — tainted
      // reference data, never owner-facing raw.
      excerpt: (fire.excerpt ?? '').slice(0, 2048),
    })
    .onConflictDoNothing({ target: [watchFires.watchId, watchFires.triggerRef] })
    .returning({ id: watchFires.id });
  if (!recorded) return false;

  const [updated] = await deps.db
    .update(watches)
    .set({ fireCount: sql`${watches.fireCount} + 1`, lastFiredAt: now, updatedAt: now })
    .where(eq(watches.id, watch.id))
    .returning();
  // Exhaust a bounded watch once it has fired its allotted number of times.
  if (updated?.maxFires != null && updated.fireCount >= updated.maxFires) {
    await deps.db
      .update(watches)
      .set({ status: 'fired', updatedAt: now })
      .where(and(eq(watches.id, watch.id), eq(watches.status, 'active')));
  }

  if (watch.conversationId) {
    await persistMessage(deps.db, {
      conversationId: watch.conversationId,
      role: 'assistant',
      origin: 'assistant',
      parts: [{ type: 'text', text: fire.text }],
      text: fire.text,
      channelMessageId: fire.channelMessageId,
    }).catch((err) => console.error('watch notice failed', err));
  }
  // A watch hit is ambient: the owner asked to know, but not necessarily at
  // 3am — quiet hours and the daily cap govern the phone legs.
  await deps
    .notifyOwner({ text: fire.text, urgency: 'ambient' })
    .catch((err) => console.error('watch owner notification failed', err));
  return true;
}
