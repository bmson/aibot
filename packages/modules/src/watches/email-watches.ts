import { persistMessage } from '@assistant/core';
import { type Db, type WatchRow, watches, watchFires } from '@assistant/db';
import { emailWatchMatches } from '@assistant/tools';
import { and, eq, gt, lte, sql } from 'drizzle-orm';
import type { InboundEmailEvent, OwnerNotifier } from '../platform.js';

/** What watch matching consumes: the database and the owner-notifier port. */
export interface WatchesDeps {
  db: Db;
  notifyOwner: OwnerNotifier['notifyOwner'];
}

/**
 * The authenticated-inbound-email shape watches match against — structurally
 * the platform's observer event, re-exported under the historical name.
 */
export type EmailWatchInput = InboundEmailEvent;

export interface EmailWatchResult {
  fired: string[];
}

/**
 * Owner-facing heads-up. Deliberately minimal: the watch name, the sender, and
 * a truncated subject — the raw email body never reaches the owner-facing text
 * and never enters a model context. A spoofable sender cannot reach here: only
 * authenticated mail is considered (see below).
 */
function noticeText(watch: WatchRow, input: EmailWatchInput): string {
  const subject = input.subject.trim().slice(0, 140) || '(no subject)';
  return `Heads-up from your "${watch.name}" watch: ${input.from.trim().toLowerCase()} emailed you — "${subject}".`;
}

/**
 * Fire any owner-defined notify watches this authenticated message matches.
 * Side-effect only: it posts a notice and pings the owner, and never returns a
 * value that short-circuits normal email triage — a watched message is still an
 * ordinary email. Idempotent: a (watch, message) firing is recorded once, so
 * Gmail history replays and at-least-once redelivery never double-notify.
 */
export async function matchEmailWatches(
  deps: WatchesDeps,
  input: EmailWatchInput,
): Promise<EmailWatchResult> {
  const fired: string[] = [];
  // A spoofed sender must never trigger a false heads-up; require authentication
  // exactly as the application-confirmation path does.
  if (!input.authenticated) return { fired };
  const now = input.now ?? new Date();
  const from = input.from.trim().toLowerCase();
  if (!from || !input.messageId) return { fired };

  // Lazily expire lapsed watches so a match is never evaluated against a stale
  // window (the sweep reaper is the durable path; this covers the hot path).
  await deps.db
    .update(watches)
    .set({ status: 'expired', updatedAt: now })
    .where(
      and(
        eq(watches.agentId, input.agentId),
        eq(watches.status, 'active'),
        lte(watches.expiresAt, now),
      ),
    );

  const candidates = await deps.db
    .select()
    .from(watches)
    .where(
      and(
        eq(watches.agentId, input.agentId),
        eq(watches.status, 'active'),
        eq(watches.kind, 'email'),
        gt(watches.expiresAt, now),
      ),
    );

  const triggerRef = `gmail:${input.messageId}`;
  for (const watch of candidates) {
    if (!emailWatchMatches(watch.match, input)) continue;

    // Record the firing first. The unique (watch_id, trigger_ref) index makes
    // this the idempotency fence: if the row already exists this message has
    // already fired this watch, so skip without re-notifying or re-counting.
    const [recorded] = await deps.db
      .insert(watchFires)
      .values({
        watchId: watch.id,
        agentId: watch.agentId,
        triggerRef,
        summary: noticeText(watch, input),
      })
      .onConflictDoNothing({ target: [watchFires.watchId, watchFires.triggerRef] })
      .returning({ id: watchFires.id });
    if (!recorded) continue;

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

    const text = noticeText(watch, input);
    if (watch.conversationId) {
      await persistMessage(deps.db, {
        conversationId: watch.conversationId,
        role: 'assistant',
        origin: 'assistant',
        parts: [{ type: 'text', text }],
        text,
        channelMessageId: `watch-fire:${watch.id}:${input.messageId}`,
      }).catch((err) => console.error('watch notice failed', err));
    }
    await deps
      .notifyOwner({ text })
      .catch((err) => console.error('watch owner notification failed', err));
    fired.push(watch.id);
  }
  return { fired };
}

/**
 * Proactively expire watches whose window has closed. Mirrors
 * reapExpiredApplicationWatches; runs from the sweep. Idempotent — the
 * status-guarded UPDATE transitions each row once.
 */
export async function reapExpiredWatches(
  deps: Pick<WatchesDeps, 'db'>,
  now = new Date(),
): Promise<number> {
  const expired = await deps.db
    .update(watches)
    .set({ status: 'expired', updatedAt: now })
    .where(and(eq(watches.status, 'active'), lte(watches.expiresAt, now)))
    .returning({ id: watches.id });
  return expired.length;
}
