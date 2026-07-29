import { type WatchRow, watches } from '@assistant/db';
import { emailWatchMatches } from '@assistant/tools';
import { and, eq, gt, lte } from 'drizzle-orm';
import type { InboundEmailEvent } from '../platform.js';
import { recordWatchFire, type WatchFireDeps } from './fire.js';

/** What watch matching consumes: the database and the owner-notifier port. */
export type WatchesDeps = WatchFireDeps;

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
    // The unique (watch_id, trigger_ref) index is the idempotency fence: a
    // message that already fired this watch returns false without re-notifying.
    const didFire = await recordWatchFire(
      deps,
      watch,
      {
        triggerRef,
        text: noticeText(watch, input),
        channelMessageId: `watch-fire:${watch.id}:${input.messageId}`,
      },
      now,
    );
    if (didFire) fired.push(watch.id);
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
