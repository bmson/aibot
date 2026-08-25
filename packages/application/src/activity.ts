import { getAgent } from '@assistant/core/chat';
import { maybeFireWakeBrief } from '@assistant/core/workflow/schedules';
import type { Db } from '@assistant/db';

export type ForegroundActivityResult = { ok: true; wakeBriefFired: boolean };

/**
 * The native app reporting a foreground open. This is the "woke up" signal the
 * wake brief listens for: the first open of the morning (ahead of the brief's
 * cron time) fires the day overview immediately instead of at 07:30. The
 * brief itself is idempotent per day, so this endpoint stays a dumb signal.
 */
export async function recordOwnerForeground(db: Db): Promise<ForegroundActivityResult> {
  const agent = await getAgent(db);
  const fired = await maybeFireWakeBrief(db, agent).catch((err) => {
    console.error('activity: wake brief trigger failed', err);
    return false;
  });
  return { ok: true, wakeBriefFired: fired };
}
