import { getChatUpdates, SETTLED_TASK_STATUSES } from './chat.js';

/**
 * Taken from the read this wraps rather than imported from the database
 * package: holding a poll open is a timing concern with no SQL of its own, and
 * this package is being moved off direct database SDK imports.
 */
type ChatDb = Parameters<typeof getChatUpdates>[0];

export type ChatUpdates = NonNullable<Awaited<ReturnType<typeof getChatUpdates>>>;

/**
 * The longest a caller may ask us to hold its poll open.
 *
 * Comfortably inside Cloud Run's request window and inside the default
 * idle timeouts of the proxies in front of it, so a held poll ends because we
 * ended it, not because something in the middle gave up on the connection.
 */
export const MAX_CHAT_WAIT_MS = 25_000;

/**
 * How often a held poll re-reads while it waits.
 *
 * This is the server's own loop — the client spends one request on it rather
 * than one per interval — but the reads are not free, and moving the loop
 * server-side moved the load with it. Each re-read is a handful of queries,
 * so the interval is what decides how much standing database work an open
 * thread costs.
 *
 * The idle figure is deliberately conservative. It replaces a client poll that
 * ran every 12s, so 2s would have been six times the reads for a thread where
 * nothing is happening — and every open tab pays it, for as long as it is
 * open. At 5s an assistant-initiated message still surfaces in less than half
 * the time it used to, for roughly a third of the queries 2s would have cost.
 *
 * A thread with a live task is the opposite case: something is about to land
 * that a person is watching for, and the window is seconds rather than hours,
 * so it is worth checking often for as long as it lasts.
 */
const ACTIVE_RECHECK_MS = 500;
const IDLE_RECHECK_MS = 5_000;

function activityFingerprint(activity: ChatUpdates['activity']): string {
  return activity.map((entry) => `${entry.step}:${entry.toolName}:${entry.status}`).join('|');
}

/**
 * Is this worth waking the client for?
 *
 * `refreshed` is deliberately excluded: those rows come back on every tick by
 * design (the caller asked us to re-read cards it is already showing), so
 * counting them as news would end every hold instantly and turn a long poll
 * back into a fast one.
 */
function hasChatNews(updates: ChatUpdates, baselineActivity: string | undefined): boolean {
  if (updates.messages.length > 0 || updates.superseded.length > 0) return true;
  // A backlog: the client loops immediately on this rather than waiting.
  if (updates.hasMore) return true;
  if (updates.taskStatus && SETTLED_TASK_STATUSES.has(updates.taskStatus)) return true;
  // Tool progress drives the "what is it doing" indicator. Only movement
  // during this hold counts — whatever was already running was in the response
  // that sent the client back here.
  return (
    baselineActivity !== undefined && activityFingerprint(updates.activity) !== baselineActivity
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * `getChatUpdates`, but willing to wait for an answer.
 *
 * Without this every client has to guess an interval, and pays for the guess
 * twice: a reply that is ready sits unseen until the next tick, and every tick
 * that finds nothing still costs a request. That is worst on a phone, where
 * each tick is a radio wake-up, which is why the mobile client's intervals had
 * to be tuned against battery rather than against how fast a person wants
 * their answer.
 *
 * Holding the connection instead lets the server answer the moment there is
 * something to say. `waitMs` of 0 (or absent) preserves the old
 * return-immediately behaviour exactly, so a caller that has not been updated
 * is unaffected.
 */
export async function waitForChatUpdates(
  db: ChatDb,
  input: Parameters<typeof getChatUpdates>[1] & { waitMs?: number; signal?: AbortSignal },
): Promise<ChatUpdates | null> {
  const budget = Math.min(Math.max(input.waitMs ?? 0, 0), MAX_CHAT_WAIT_MS);
  const deadline = Date.now() + budget;
  const recheckMs = input.taskId ? ACTIVE_RECHECK_MS : IDLE_RECHECK_MS;
  let baselineActivity: string | undefined;

  while (true) {
    const updates = await getChatUpdates(db, input);
    if (!updates) return null;
    if (hasChatNews(updates, baselineActivity)) return updates;
    // Everything from here is a quiet tick: remember what "quiet" looked like
    // so the next one can tell that a tool moved.
    baselineActivity = activityFingerprint(updates.activity);
    const remaining = deadline - Date.now();
    if (remaining <= 0 || input.signal?.aborted) return updates;
    await sleep(Math.min(recheckMs, remaining), input.signal);
    if (input.signal?.aborted) return updates;
  }
}
