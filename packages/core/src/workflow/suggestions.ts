import { type Db, type SuggestionRow, suggestions, type TaskRow } from '@assistant/db';
import { and, asc, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';
import { getQueueNotifier } from '../queue.js';
import { enqueueTask } from './machine.js';

/**
 * The suggestion surface: how the assistant proposes work without doing it.
 *
 * The anticipation layer's invariant is that untrusted content may inform the
 * owner but never author an outward action. A suggestion honours that literally
 * — it is a row of text. Nothing about it is queued, frozen, or scheduled. When
 * the owner accepts, `acceptSuggestion` enqueues an ordinary task whose
 * instruction is the proposal, and that task runs the full planner and the full
 * approval spine like any other. The suggestion did not act; the owner asked.
 *
 * The accepted task carries `taintedOrigin`, because the proposal was written
 * from a third party's email. Without it the child would start clean and its
 * outward calls would run unapproved — the same laundering hole `task.schedule`
 * closes. Accepting a suggestion therefore buys the owner one decision, not a
 * blanket exemption: a calendar entry on their own calendar goes through, and
 * anything that reaches a person still stops for approval.
 */

const DEFAULT_TTL_DAYS = 7;
const MAX_PENDING = 25;

export interface CreateSuggestionInput {
  agentId: string;
  conversationId?: string;
  summary: string;
  proposedAction: string;
  /** Stable per proposal, so re-running the producer proposes nothing twice. */
  sourceRef: string;
  origin?: string;
  ttlDays?: number;
  now?: Date;
}

/**
 * Record a proposal. Idempotent on `(agentId, sourceRef)`: a producer that runs
 * on a schedule will see the same source again, and the owner should not be
 * asked the same question twice — least of all one they already dismissed.
 * Returns the row when it was newly created, and null when it already existed.
 */
export async function createSuggestion(
  db: Db,
  input: CreateSuggestionInput,
): Promise<SuggestionRow | null> {
  const now = input.now ?? new Date();
  const [row] = await db
    .insert(suggestions)
    .values({
      agentId: input.agentId,
      conversationId: input.conversationId,
      summary: input.summary.slice(0, 500),
      proposedAction: input.proposedAction.slice(0, 2000),
      origin: input.origin ?? 'briefing',
      sourceRef: input.sourceRef,
      expiresAt: new Date(now.getTime() + (input.ttlDays ?? DEFAULT_TTL_DAYS) * 24 * 3600 * 1000),
    })
    .onConflictDoNothing({ target: [suggestions.agentId, suggestions.sourceRef] })
    .returning();
  return row ?? null;
}

export type AcceptOutcome = { ok: true; taskId: string } | { ok: false; reason: string };
type SuggestionAcceptanceCommit = { outcome: AcceptOutcome; notify?: TaskRow };

/**
 * Promote a suggestion into real work.
 *
 * Status-guarded: the update only matches a row still `pending` or `snoozed`,
 * so a double-tap or a racing tab creates one task, not two. The task is only
 * enqueued once that guard has claimed the row.
 */
export async function acceptSuggestion(
  db: Db,
  suggestionId: string,
  opts: { now?: Date } = {},
): Promise<AcceptOutcome> {
  const now = opts.now ?? new Date();
  const committed = await db.transaction(async (tx): Promise<SuggestionAcceptanceCommit> => {
    const txDb = tx as unknown as Db;
    const [claimed] = await txDb
      .update(suggestions)
      .set({ status: 'accepted', updatedAt: now })
      .where(
        and(
          eq(suggestions.id, suggestionId),
          or(eq(suggestions.status, 'pending'), eq(suggestions.status, 'snoozed')),
        ),
      )
      .returning();
    if (!claimed) return { outcome: { ok: false, reason: 'This suggestion is no longer open.' } };
    if (claimed.expiresAt <= now) {
      await txDb
        .update(suggestions)
        .set({ status: 'expired', updatedAt: now })
        .where(eq(suggestions.id, suggestionId));
      return { outcome: { ok: false, reason: 'This suggestion has expired.' } };
    }

    const { task, created } = await enqueueTask(txDb, {
      type: 'adhoc',
      // Queue delivery is deliberately deferred until the transaction commits:
      // a worker must never see a task whose suggestion link later rolls back.
      deferNotification: true,
      event: {
        source: 'internal',
        externalEventId: `suggestion:${claimed.id}`,
        agentId: claimed.agentId,
        conversationId: claimed.conversationId ?? undefined,
        trust: 'owner',
        payload: {
          instruction: claimed.proposedAction,
          // The proposal was written from third-party content, so the work runs
          // tainted and every outward call stays gated. Accepting is one
          // decision, not an exemption.
          taintedOrigin: true,
          suggestionId: claimed.id,
        },
      },
    });

    await txDb
      .update(suggestions)
      .set({ acceptedTaskId: task.id, updatedAt: now })
      .where(eq(suggestions.id, claimed.id));
    return {
      outcome: { ok: true, taskId: task.id } as const,
      notify: created && task.status === 'pending' ? task : undefined,
    };
  });

  if (committed.notify) {
    getQueueNotifier().notify(committed.notify.id, committed.notify.queueGeneration);
  }
  return committed.outcome;
}

/** Close a suggestion the owner does not want. Dismissal is permanent. */
export async function dismissSuggestion(
  db: Db,
  suggestionId: string,
  opts: { now?: Date } = {},
): Promise<boolean> {
  const [row] = await db
    .update(suggestions)
    .set({ status: 'dismissed', updatedAt: opts.now ?? new Date() })
    .where(
      and(
        eq(suggestions.id, suggestionId),
        or(eq(suggestions.status, 'pending'), eq(suggestions.status, 'snoozed')),
      ),
    )
    .returning({ id: suggestions.id });
  return Boolean(row);
}

/** Put a suggestion down for a while without answering it. */
export async function snoozeSuggestion(
  db: Db,
  suggestionId: string,
  until: Date,
  opts: { now?: Date } = {},
): Promise<boolean> {
  const now = opts.now ?? new Date();
  const [row] = await db
    .update(suggestions)
    .set({
      status: 'snoozed',
      snoozedUntil: until,
      // A snooze past the expiry would silently drop it; carry the deadline out
      // with the snooze so "later" means later. The cast is required: a raw
      // template cannot bind a Date, only a typed literal.
      expiresAt: sql`GREATEST(${suggestions.expiresAt}, ${until.toISOString()}::timestamptz)`,
      updatedAt: now,
    })
    .where(and(eq(suggestions.id, suggestionId), eq(suggestions.status, 'pending')))
    .returning({ id: suggestions.id });
  return Boolean(row);
}

/** Suggestions the owner should see now: pending, unexpired, done snoozing. */
export async function listOpenSuggestions(
  db: Db,
  agentId: string,
  opts: { now?: Date; limit?: number } = {},
): Promise<SuggestionRow[]> {
  const now = opts.now ?? new Date();
  return db
    .select()
    .from(suggestions)
    .where(
      and(
        eq(suggestions.agentId, agentId),
        or(eq(suggestions.status, 'pending'), eq(suggestions.status, 'snoozed')),
        gt(suggestions.expiresAt, now),
        or(isNull(suggestions.snoozedUntil), lte(suggestions.snoozedUntil, now)),
      ),
    )
    .orderBy(asc(suggestions.createdAt))
    .limit(opts.limit ?? MAX_PENDING);
}

/**
 * Retire suggestions nobody answered. An unanswered proposal is not a task the
 * owner owes anyone — it goes quiet on its own rather than accumulating into a
 * backlog that has to be cleared.
 */
export async function expireStaleSuggestions(db: Db, now: Date = new Date()): Promise<number> {
  const rows = await db
    .update(suggestions)
    .set({ status: 'expired', updatedAt: now })
    .where(
      and(
        or(eq(suggestions.status, 'pending'), eq(suggestions.status, 'snoozed')),
        lte(suggestions.expiresAt, now),
      ),
    )
    .returning({ id: suggestions.id });
  return rows.length;
}
