import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * Web-watch matching: the stored `match` shape for a `kind='web'` watch and the
 * pure, deterministic detector the poller runs. No DB, no model — the untrusted
 * page text is compared, never interpreted, exactly like `emailWatchMatches`.
 */

export const WEB_WATCH_MODES = ['change', 'contains', 'absent'] as const;
export type WebWatchMode = (typeof WEB_WATCH_MODES)[number];

/** The `match` column for a web watch. Parsing is idempotent and total. */
export const webWatchMatchSchema = z
  .object({
    url: z.string().trim().url(),
    mode: z.enum(WEB_WATCH_MODES).default('change'),
    /** Required for contains/absent; the literal substring to look for. */
    pattern: z.string().trim().min(1).max(200).optional(),
  })
  .superRefine((value, ctx) => {
    if ((value.mode === 'contains' || value.mode === 'absent') && !value.pattern) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `web watch mode "${value.mode}" requires a pattern`,
        path: ['pattern'],
      });
    }
  });

export type WebWatchMatch = z.infer<typeof webWatchMatchSchema>;

/**
 * Poller-owned observation state persisted on the watch row between polls.
 * `fingerprint`/`present` are the detection baseline; `failures` counts
 * consecutive fetch failures for backoff. Opaque to everything but this module.
 */
export interface WebWatchState {
  fingerprint?: string;
  present?: boolean;
  failures?: number;
}

export interface WebWatchOutcome {
  triggered: boolean;
  /** Owner-facing reason, derived only from the watch spec — never page text. */
  summary: string;
  /** The detection state to persist (failures is managed by the poller). */
  nextState: WebWatchState;
}

/** Stable content fingerprint for change detection. */
export function fingerprintText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Decide whether a freshly observed page fires the watch, and what detection
 * state to persist. Every mode records a baseline on the first observation and
 * does NOT fire on it, so a watch established against the current state notifies
 * only on a genuine future transition:
 *  - change:   fire when the fingerprint differs from the last one seen.
 *  - contains: fire on the absent → present transition of `pattern`.
 *  - absent:   fire on the present → absent transition of `pattern`.
 */
export function webWatchOutcome(
  match: WebWatchMatch,
  text: string,
  prior: WebWatchState,
): WebWatchOutcome {
  if (match.mode === 'change') {
    const fingerprint = fingerprintText(text);
    const triggered = prior.fingerprint != null && prior.fingerprint !== fingerprint;
    return {
      triggered,
      summary: triggered ? 'the page content changed' : 'no change',
      nextState: { fingerprint },
    };
  }

  const pattern = (match.pattern ?? '').toLowerCase();
  const present = pattern.length > 0 && text.toLowerCase().includes(pattern);
  if (match.mode === 'contains') {
    // Edge-triggered from a recorded baseline: only absent (false) → present.
    const triggered = present && prior.present === false;
    return {
      triggered,
      summary: triggered ? `the page now mentions "${match.pattern}"` : 'no change',
      nextState: { present },
    };
  }
  // absent
  const triggered = !present && prior.present === true;
  return {
    triggered,
    summary: triggered ? `the page no longer mentions "${match.pattern}"` : 'no change',
    nextState: { present },
  };
}

/** One-line description of a web watch for `watch.list` and notices. */
export function describeWebWatch(match: WebWatchMatch): string {
  if (match.mode === 'change') return `${match.url} · change`;
  return `${match.url} · ${match.mode} "${match.pattern}"`;
}

/** Parse a stored web `match`, returning null when the row is not a web watch. */
export function parseWebWatchMatch(match: unknown): WebWatchMatch | null {
  const parsed = webWatchMatchSchema.safeParse(match);
  return parsed.success ? parsed.data : null;
}
