import { type WatchRow, watches } from '@assistant/db';
import {
  extractWebText,
  fetchPublicWebPage,
  fingerprintText,
  looksLikeBotChallenge,
  parseWebWatchMatch,
  type WebWatchMatch,
  type WebWatchState,
  webWatchOutcome,
} from '@assistant/tools';
import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import { recordWatchFire, type WatchFireDeps } from './fire.js';

/**
 * Web-watch polling (`watch.poll_web`). Unlike email watches, which are driven
 * by an inbound event, a web watch is *polled*: each sweep claims the watches
 * whose `nextPollAt` is due, fetches each page through the SSRF-guarded
 * `fetchPublicWebPage`, and fires the owner-notifier when the deterministic
 * `webWatchOutcome` says the watched condition transitioned. The raw page text
 * never enters a model context — only a fingerprint/`present` boolean and a
 * spec-derived summary. See docs/anticipation-layer.md.
 */

/** What the poller consumes: the DB and the owner-notifier port. */
export type WebWatchDeps = WatchFireDeps;

/** The extracted result of fetching one watched page (injectable for tests). */
export interface WebFetchResult {
  text: string;
  finalUrl: string;
}

/** Fetch a page and return its extracted text; throws on error or a bot wall. */
export type WebWatchFetch = (url: string) => Promise<WebFetchResult>;

const DEFAULT_BATCH = 10;
const CONCURRENCY = 4;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_CONSECUTIVE_FAILURES = 5;
const DEFAULT_INTERVAL_SECONDS = 3600;

/**
 * Production fetch: SSRF-guarded GET → shared text extraction → bot-challenge
 * guard. A CAPTCHA/verification wall throws so it is never recorded as "the
 * page changed" (exactly as `web.fetch` treats it).
 */
const defaultFetch: WebWatchFetch = async (url) => {
  const fetched = await fetchPublicWebPage(url, AbortSignal.timeout(FETCH_TIMEOUT_MS));
  const text = extractWebText(fetched.contentType, fetched.body);
  if (looksLikeBotChallenge(fetched.status, text)) {
    throw new Error(`bot-challenge wall at ${fetched.finalUrl} (HTTP ${fetched.status})`);
  }
  return { text, finalUrl: fetched.finalUrl };
};

function readState(raw: unknown): WebWatchState {
  return raw && typeof raw === 'object' ? (raw as WebWatchState) : {};
}

function noticeText(watch: WatchRow, match: WebWatchMatch, summary: string): string {
  return `Heads-up from your "${watch.name}" watch: ${summary} — ${match.url}.`;
}

/**
 * Poll every web watch that is due, at most `batch` per run. Returns the number
 * that fired. Each watch is claimed by atomically pushing `nextPollAt` forward
 * by its interval, so a concurrent sweep on another instance claims none and a
 * mid-run crash only delays the next poll by one interval.
 */
export async function pollDueWebWatches(
  deps: WebWatchDeps,
  opts: { now?: Date; fetch?: WebWatchFetch; batch?: number } = {},
): Promise<number> {
  const now = opts.now ?? new Date();
  const fetchPage = opts.fetch ?? defaultFetch;
  const batch = opts.batch ?? DEFAULT_BATCH;

  const dueIds = deps.db
    .select({ id: watches.id })
    .from(watches)
    .where(and(eq(watches.status, 'active'), eq(watches.kind, 'web'), lte(watches.nextPollAt, now)))
    .orderBy(watches.nextPollAt)
    .limit(batch);

  // Claim: bump nextPollAt by the per-row interval. The WHERE re-checks
  // `nextPollAt <= now`, so under READ COMMITTED a second instance whose
  // subselect overlapped re-evaluates against the already-bumped row and skips
  // it — single-claim without an advisory lock.
  const claimed = await deps.db
    .update(watches)
    .set({
      nextPollAt: sql`${now.toISOString()}::timestamptz + make_interval(secs => coalesce(${watches.pollIntervalSeconds}, ${DEFAULT_INTERVAL_SECONDS}))`,
      updatedAt: now,
    })
    .where(
      and(
        inArray(watches.id, dueIds),
        eq(watches.status, 'active'),
        eq(watches.kind, 'web'),
        lte(watches.nextPollAt, now),
      ),
    )
    .returning();

  let fired = 0;
  for (let i = 0; i < claimed.length; i += CONCURRENCY) {
    const chunk = claimed.slice(i, i + CONCURRENCY);
    const results = await Promise.all(chunk.map((watch) => pollOne(deps, watch, fetchPage, now)));
    fired += results.filter(Boolean).length;
  }
  return fired;
}

/** Poll a single claimed watch. Returns true iff it fired the owner-notifier. */
async function pollOne(
  deps: WebWatchDeps,
  watch: WatchRow,
  fetchPage: WebWatchFetch,
  now: Date,
): Promise<boolean> {
  const match = parseWebWatchMatch(watch.match);
  if (!match) {
    console.error(`web watch ${watch.id} has an unreadable match; skipping`);
    return false;
  }
  const prior = readState(watch.state);

  let observed: WebFetchResult;
  try {
    observed = await fetchPage(match.url);
  } catch (err) {
    return handleFetchFailure(deps, watch, match, prior, now, err);
  }

  const outcome = webWatchOutcome(match, observed.text, prior);
  // Persist the new detection state and clear the failure counter regardless of
  // whether it fired — the baseline poll records state without notifying.
  await deps.db
    .update(watches)
    .set({ state: { ...outcome.nextState, failures: 0 }, updatedAt: now })
    .where(eq(watches.id, watch.id));

  if (!outcome.triggered) return false;
  return recordWatchFire(
    deps,
    watch,
    {
      // Idempotency net; the atomic claim already bounds a poll to once per
      // window, and outcome is measured against the persisted prior state.
      triggerRef: `web:${fingerprintText(observed.text)}`,
      text: noticeText(watch, match, outcome.summary),
      channelMessageId: `watch-fire:${watch.id}:${fingerprintText(observed.text).slice(0, 16)}`,
    },
    now,
  );
}

/**
 * A failed fetch (network error or a bot-challenge wall) never fires and never
 * advances the detection baseline. It increments a consecutive-failure counter;
 * once the watch has failed `MAX_CONSECUTIVE_FAILURES` times in a row it is
 * expired with a single owner notice, so a permanently broken URL cannot poll
 * forever in silence.
 */
async function handleFetchFailure(
  deps: WebWatchDeps,
  watch: WatchRow,
  match: WebWatchMatch,
  prior: WebWatchState,
  now: Date,
  err: unknown,
): Promise<boolean> {
  const failures = (prior.failures ?? 0) + 1;
  console.error(`web watch ${watch.id} poll failed (${failures}): ${String(err)}`);
  if (failures >= MAX_CONSECUTIVE_FAILURES) {
    await deps.db
      .update(watches)
      .set({ status: 'expired', state: { ...prior, failures }, updatedAt: now })
      .where(and(eq(watches.id, watch.id), eq(watches.status, 'active')));
    await deps
      .notifyOwner({
        text: `Your "${watch.name}" web watch keeps failing to load ${match.url}, so I've stopped it. Re-create it if you still want it.`,
      })
      .catch((notifyErr) => console.error('web watch failure notice failed', notifyErr));
    return false;
  }
  await deps.db
    .update(watches)
    .set({ state: { ...prior, failures }, updatedAt: now })
    .where(eq(watches.id, watch.id));
  return false;
}
