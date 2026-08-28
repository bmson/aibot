import {
  commitments,
  type Db,
  emailIngest,
  notificationPrefs,
  proactiveMoments,
  tasks as taskTable,
} from '@assistant/db';
import { and, count, desc, eq, gte, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { getAgent, postOwnerNotice } from '../chat.js';
import { loadConfig } from '../config.js';
import { withSpan } from '../otel.js';
import type { BriefingCalendarReader } from '../workflow/briefing.js';
import { createSuggestion } from '../workflow/suggestions.js';
import { type EventSalience, salientEvents } from './calendar-salience.js';
import { type ProactiveNotifier, pingOwner } from './notify.js';

/**
 * The pulse: the assistant noticing things during the day.
 *
 * Before this, everything proactive happened at 07:30, 07:45 and 19:30, and
 * each of those was built to stay silent unless something cleared a high bar.
 * The result was an assistant that could go days without a word while an
 * unanswered invitation sat on the calendar and an actionable email sat in the
 * ledger. The briefing is the right primitive for "here is your day"; it is the
 * wrong one for "you need to leave in twenty minutes".
 *
 * So this runs every twenty minutes and asks one question: is there something
 * worth saying *right now*? Almost always the answer is no, and then it says
 * nothing — the same self-silence rule the briefing follows.
 *
 * Three properties keep it from becoming a drip feed, and all three are
 * structural rather than prompt discipline:
 *
 * 1. **One thing at a time.** Candidates are ranked and exactly one is
 *    delivered per firing. A busy morning does not produce four notifications.
 * 2. **Said once.** `proactive_moments.moment_key` is unique per agent, so a
 *    moment survives a re-run, a redelivered task, and a second instance.
 * 3. **Paced.** At most one pulse an hour and a daily ceiling, counted from
 *    that same ledger. On top of it `evaluateOutOfBandPing` still applies the
 *    owner's quiet hours and ambient cap to the phone leg.
 *
 * Like the briefing this is a code job, which is what guarantees it cannot act
 * outward: it holds no tool registry at all. It informs, and it proposes
 * through the ordinary suggestion surface, where accepting runs the full
 * planner and the full approval spine.
 */

/** How often a pulse may speak at all, regardless of how much it noticed. */
const MIN_GAP_MINUTES = 60;
/**
 * The ceiling on top of the gap, so a long day cannot accumulate a dozen.
 *
 * The owner tunes this with the daily limit they already have in Settings →
 * Notifications: `notification_prefs.ambientDailyCap` governs how often routine
 * notices may interrupt, and volunteering something unprompted is exactly that.
 * A second, pulse-specific dial would only be a way to set two numbers that
 * disagree. Whichever is lower wins, so the setting can tighten this default
 * but never widen it past what the pulse considers sane.
 */
const DEFAULT_DAILY_CAP = 6;
/** How far ahead the calendar read reaches — enough for the longest lead time. */
const CALENDAR_WINDOW_HOURS = 6;
/** Lead time for an event the owner has to travel to, versus one at their desk. */
const LEAD_MINUTES_TRAVEL = 45;
const LEAD_MINUTES_DESK = 15;
/** Mail must be recent enough that acting on it is still the obvious next step. */
const MAIL_WINDOW_HOURS = 12;
/** Only genuinely important mail earns an out-of-band nudge of its own. */
const MAIL_MIN_IMPORTANCE = 4;
/** A commitment this close to its deadline is worth one reminder. */
const COMMITMENT_HORIZON_HOURS = 36;
const MAX_SUMMARY_CHARS = 400;

export type PulseMomentKind = 'event-lead' | 'mail-action' | 'commitment-due';

export interface PulseMoment {
  kind: PulseMomentKind;
  /** Stable per occurrence — this is the idempotency fence, not a description. */
  key: string;
  /** What the owner is told. Deterministic: no model composes this. */
  text: string;
  /** Higher wins when several moments are live at once. */
  priority: number;
  /** An optional proposal to attach, promoted only if the owner accepts it. */
  suggestion?: { summary: string; proposedAction: string; sourceRef: string };
}

export interface PulseResult {
  /** Candidates found, before the one-at-a-time rule. */
  candidates: number;
  delivered: PulseMomentKind | null;
  pinged: boolean;
  suggested: boolean;
  /** Why nothing was said, when nothing was. */
  heldBy: 'no-candidates' | 'min-gap' | 'daily-cap' | 'already-said' | null;
}

/**
 * Pick what to say. Pure, so the ranking is testable without a database.
 *
 * Ties break on the key rather than input order: two moments of equal priority
 * must resolve the same way on every run, or the "said once" fence would race
 * itself across concurrent sweeps.
 */
export function selectPulseMoment(candidates: readonly PulseMoment[]): PulseMoment | null {
  if (candidates.length === 0) return null;
  return [...candidates].sort(
    (a, b) => b.priority - a.priority || a.key.localeCompare(b.key),
  )[0] as PulseMoment;
}

/**
 * The owner's ceiling, or ours — whichever is stricter. An absent prefs row is
 * the shipped default (no cap of their own), which leaves the pulse's own.
 */
async function dailyCapFor(db: Db, agentId: string): Promise<number> {
  const [prefs] = await db
    .select({ cap: notificationPrefs.ambientDailyCap })
    .from(notificationPrefs)
    .where(eq(notificationPrefs.agentId, agentId))
    .limit(1);
  const owner = prefs?.cap ?? null;
  return owner == null ? DEFAULT_DAILY_CAP : Math.min(owner, DEFAULT_DAILY_CAP);
}

/** Minutes from now until an ISO timestamp, or null when it is unparseable. */
function minutesUntil(iso: string, now: Date): number | null {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  return (at - now.getTime()) / 60_000;
}

/**
 * The lead-time nudge for a salient event that is about to start.
 *
 * Only salient events qualify (`calendar-salience.ts`): a standing desk
 * meeting the owner has every day is not something to buzz a phone for, and
 * treating it as one is how a proactive assistant becomes a muted one.
 */
export function eventLeadMoments(salient: readonly EventSalience[], now: Date): PulseMoment[] {
  const moments: PulseMoment[] = [];
  for (const scored of salient) {
    if (scored.event.allDay) continue;
    const away = minutesUntil(scored.event.start, now);
    if (away === null || away <= 0) continue;
    const travels = scored.reasons.some((reason) => reason.startsWith('it is at'));
    const lead = travels ? LEAD_MINUTES_TRAVEL : LEAD_MINUTES_DESK;
    if (away > lead) continue;
    const inMinutes = Math.max(1, Math.round(away));
    const where = travels ? ` at ${(scored.event.location ?? '').trim()}` : '';
    moments.push({
      kind: 'event-lead',
      // Keyed on the event and its start so a moved event earns a fresh nudge.
      key: `event-lead:${scored.event.eventId ?? scored.event.summary}:${scored.event.start}`,
      text: `"${scored.event.summary}" starts in ${inMinutes} minute${inMinutes === 1 ? '' : 's'}${where}. ${scored.reasons.join('; ')}.`,
      // Time-boxed and about to expire: nothing else the pulse finds is more
      // urgent than something the owner is about to be late for.
      priority: 100,
    });
  }
  return moments;
}

/**
 * Mail that scored as genuinely important and actionable, and that nothing has
 * picked up.
 *
 * The importance alert already fires once on arrival (`email-sync.ts`). This is
 * the second look: hours later, still unacted, still ahead of its date. It
 * carries a suggestion rather than a bare notice, because "want me to do the
 * obvious thing about this?" is the whole point of the mail half of the ask.
 */
function mailMoment(row: {
  channelMessageId: string;
  fromEmail: string;
  subject: string;
  reason: string;
  importance: number;
}): PulseMoment {
  return {
    kind: 'mail-action',
    key: `mail-action:${row.channelMessageId}`,
    text: `Still unanswered from ${row.fromEmail}: "${row.subject}" — ${row.reason}`,
    priority: 60 + row.importance,
    suggestion: {
      summary: `Deal with "${row.subject}" from ${row.fromEmail}?`,
      proposedAction:
        `Read the email from ${row.fromEmail} with subject "${row.subject}" and take the obvious next step ` +
        "on the owner's behalf — put a date on their own calendar, set a reminder, or draft a reply for them " +
        'to review. Do not send anything to anyone without approval. If nothing is genuinely needed, say so and stop.',
      sourceRef: `pulse:${row.channelMessageId}`,
    },
  };
}

function commitmentMoment(row: {
  id: string;
  title: string;
  nextAction: string;
  dueAt: Date;
}): PulseMoment {
  const when = row.dueAt.toISOString().slice(0, 16).replace('T', ' ');
  return {
    kind: 'commitment-due',
    key: `commitment-due:${row.id}`,
    text: `"${row.title}" is due ${when}${row.nextAction ? ` — next: ${row.nextAction}` : ''}.`,
    priority: 50,
  };
}

export interface PulseDeps {
  db: Db;
  calendarReader?: BriefingCalendarReader;
  notifyOwner?: ProactiveNotifier;
  heartbeat?: () => Promise<void>;
}

export async function runPulse(
  deps: PulseDeps,
  opts: { taskId?: string; now?: Date; dailyCap?: number } = {},
): Promise<PulseResult> {
  const { db } = deps;
  const now = opts.now ?? new Date();

  return withSpan('proactive.pulse', {}, async () => {
    const agent = await getAgent(db);
    const result: PulseResult = {
      candidates: 0,
      delivered: null,
      pinged: false,
      suggested: false,
      heldBy: null,
    };

    // Pacing first: when the pulse may not speak, there is no reason to spend a
    // calendar read finding out what it would have said.
    const gapStart = new Date(now.getTime() - MIN_GAP_MINUTES * 60_000);
    const [recent] = await db
      .select({ value: count() })
      .from(proactiveMoments)
      .where(
        and(eq(proactiveMoments.agentId, agent.id), gte(proactiveMoments.deliveredAt, gapStart)),
      );
    if (Number(recent?.value ?? 0) > 0) {
      result.heldBy = 'min-gap';
      return result;
    }
    const dayStart = new Date(now.getTime() - 24 * 3600_000);
    const [today] = await db
      .select({ value: count() })
      .from(proactiveMoments)
      .where(
        and(eq(proactiveMoments.agentId, agent.id), gte(proactiveMoments.deliveredAt, dayStart)),
      );
    if (Number(today?.value ?? 0) >= (opts.dailyCap ?? (await dailyCapFor(db, agent.id)))) {
      result.heldBy = 'daily-cap';
      return result;
    }

    await deps.heartbeat?.();

    // A calendar failure degrades to "no event moments", exactly as it does in
    // the briefing: a provider outage must not cost the owner the mail half.
    const calendar = deps.calendarReader
      ? await deps
          .calendarReader({
            timeMin: now,
            timeMax: new Date(now.getTime() + CALENDAR_WINDOW_HOURS * 3600_000),
          })
          .catch((err) => {
            console.error('pulse: calendar read failed', err);
            return null;
          })
      : null;

    const salient = calendar
      ? salientEvents(calendar.events, {
          timeZone: agent.timezone,
          selfEmails: [loadConfig().OWNER_EMAIL, agent.email],
        })
      : [];

    const mailSince = new Date(now.getTime() - MAIL_WINDOW_HOURS * 3600_000);
    const mail = await db
      .select({
        channelMessageId: emailIngest.channelMessageId,
        fromEmail: emailIngest.fromEmail,
        subject: emailIngest.subject,
        reason: emailIngest.reason,
        importance: emailIngest.importance,
      })
      .from(emailIngest)
      .where(
        and(
          eq(emailIngest.agentId, agent.id),
          eq(emailIngest.actionable, true),
          gte(emailIngest.importance, MAIL_MIN_IMPORTANCE),
          gte(emailIngest.createdAt, mailSince),
          // Nothing has picked it up: no triage task ran to completion on it.
          sql`NOT EXISTS (
            SELECT 1 FROM ${taskTable}
            WHERE ${taskTable.externalEventId} = ${emailIngest.channelMessageId}
              AND ${taskTable.status} = 'done'
          )`,
        ),
      )
      .orderBy(desc(emailIngest.importance))
      .limit(5);

    const dueCommitments = await db
      .select({
        id: commitments.id,
        title: commitments.title,
        nextAction: commitments.nextAction,
        dueAt: commitments.dueAt,
      })
      .from(commitments)
      .where(
        and(
          eq(commitments.agentId, agent.id),
          eq(commitments.status, 'open'),
          isNotNull(commitments.dueAt),
          gte(commitments.dueAt, now),
          lte(commitments.dueAt, new Date(now.getTime() + COMMITMENT_HORIZON_HOURS * 3600_000)),
          or(isNull(commitments.snoozedUntil), lte(commitments.snoozedUntil, now)),
        ),
      )
      .limit(5);

    const candidates: PulseMoment[] = [
      ...eventLeadMoments(salient, now),
      ...mail.map(mailMoment),
      ...dueCommitments
        .filter((row): row is typeof row & { dueAt: Date } => row.dueAt !== null)
        .map(commitmentMoment),
    ];
    result.candidates = candidates.length;

    const moment = selectPulseMoment(candidates);
    if (!moment) {
      result.heldBy = 'no-candidates';
      return result;
    }

    // Claim the moment BEFORE saying anything. Two instances sweeping at once
    // both find the same candidate; exactly one wins the unique index, and the
    // loser stands down rather than posting a duplicate.
    const [claimed] = await db
      .insert(proactiveMoments)
      .values({
        agentId: agent.id,
        kind: moment.kind,
        momentKey: moment.key,
        summary: moment.text.slice(0, MAX_SUMMARY_CHARS),
        // The evaluation's own clock, not insert time — the same rule the ping
        // ledger follows (`nudge-policy.ts`). A caller pinning `now` (a test, a
        // replayed sweep) must land its row inside the window it judged, or the
        // pacing check reads it back as "just now" and holds forever.
        deliveredAt: now,
      })
      .onConflictDoNothing({
        target: [proactiveMoments.agentId, proactiveMoments.momentKey],
      })
      .returning({ id: proactiveMoments.id });
    if (!claimed) {
      result.heldBy = 'already-said';
      return result;
    }

    // The proposal is created before the message so the card can carry a real
    // id, and returns null when this producer already asked — the same
    // discipline the briefing follows.
    const parts: unknown[] = [];
    if (moment.suggestion) {
      const created = await createSuggestion(db, {
        agentId: agent.id,
        summary: moment.suggestion.summary,
        proposedAction: moment.suggestion.proposedAction,
        sourceRef: moment.suggestion.sourceRef,
        origin: 'pulse',
        now,
      });
      if (created) {
        parts.push({
          type: 'suggestion',
          suggestionId: created.id,
          summary: created.summary,
          proposedAction: created.proposedAction,
        });
        result.suggested = true;
      }
    }

    const { conversationId } = await postOwnerNotice(db, {
      agentId: agent.id,
      text: moment.text,
      ...(opts.taskId ? { taskId: opts.taskId } : {}),
      extraParts: parts,
    });
    result.delivered = moment.kind;
    result.pinged = await pingOwner(deps.notifyOwner, {
      conversationId,
      text: moment.text.slice(0, 200),
      ...(opts.taskId ? { taskId: opts.taskId } : {}),
    });
    await db
      .update(proactiveMoments)
      .set({ pinged: result.pinged })
      .where(eq(proactiveMoments.id, claimed.id));
    return result;
  });
}

/** The job registry's summary line. */
export function pulseSummary(result: PulseResult): string {
  if (!result.delivered) return `pulse: quiet (${result.heldBy ?? 'nothing to say'})`;
  return (
    `pulse: ${result.delivered} delivered${result.pinged ? ' + pinged' : ''}` +
    `${result.suggested ? ' with a suggestion' : ''}, ${result.candidates} candidate(s)`
  );
}
