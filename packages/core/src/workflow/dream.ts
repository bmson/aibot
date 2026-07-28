import { createHash } from 'node:crypto';
import {
  agents,
  approvals,
  type Db,
  type DreamNoteRow,
  dreamNotes,
  isTombstoned,
  memories,
  resolveSubjectContact,
  tasks,
  toolCalls,
} from '@assistant/db';
import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { BudgetReservationError, nextDailyReset, nextMonthlyReset } from '../cost.js';
import { isUnparseableObjectError, type ModelRouter } from '../model-router/router.js';
import { withSpan } from '../otel.js';
import { notifyOwnerInNotifications } from './anomaly.js';

/**
 * Dreaming (Phase 20 — offline cognition). A nightly, budget-capped, INTERNAL-ONLY
 * session: because it runs as a code job it dispatches no tools, so it can never
 * act outward (a stronger guarantee than a trust-scoped registry). It replays the
 * day's failures as counterfactual footnotes, spots behavioral patterns and saves
 * them as LOW-CONFIDENCE QUARANTINED memories (owner confirms/rejects on Profile),
 * and anticipates likely-tomorrow needs (ProAct-style — arxiv 2605.25971). Owner-
 * facing observations land in `dream_notes` (surfaced in the morning brief, kept 7
 * days) and a consolidated "while you slept" note goes to Notifications.
 *
 * The full ProAct pre-fetch-and-cache loop (serve a future tool call from a
 * pre-staged cache entry) is a follow-up; v1 pre-stages ANSWERS for the owner
 * (footnotes/anticipations) rather than matching a future tool-cache key. Live
 * weather is already pre-staged by the Phase 25 ambient snapshot.
 */

const WINDOW_HOURS = 24;
const APPROVAL_WINDOW_DAYS = 7;
const DREAM_NOTE_TTL_DAYS = 7;
const HYPOTHESIS_TTL_DAYS = 60; // an unconfirmed hypothesis fades if evidence never accrues
const MAX_HYPOTHESIS_CONFIDENCE = 0.4;

const DreamOutputSchema = z.object({
  footnotes: z
    .array(z.string().min(3).max(400))
    .max(5)
    .default([])
    .describe('"While you slept, I noticed…" observations — corrected plans for failures, etc.'),
  hypotheses: z
    .array(
      z.object({
        subject: z.string().max(120).default('').describe('"owner", a person, or empty.'),
        claim: z.string().min(3).max(300),
        confidence: z.number().min(0).max(0.6).default(0.3),
      }),
    )
    .max(3)
    .default([])
    .describe('Low-confidence behavioral patterns to hold for owner confirmation.'),
  anticipations: z
    .array(z.string().min(3).max(300))
    .max(3)
    .default([])
    .describe('Likely-tomorrow needs and how you have pre-staged for them.'),
});

const DREAM_SYSTEM = [
  "You are the assistant reflecting overnight on the day's work — an internal monologue the owner never sees unless you choose to surface it.",
  'From the failures, retries, and approval decisions below, do three things, conservatively:',
  '1) footnotes: for a notable failure, state the corrected plan in one line ("the browse of X failed on selector Y — next time use Z"). Skip trivia.',
  '2) hypotheses: only genuine behavioral PATTERNS (3+ consistent instances), phrased as a testable claim about the owner ("declines meetings before 10am"). Keep confidence low; these await the owner\'s confirmation.',
  '3) anticipations: likely needs for tomorrow you can infer, and what you would pre-stage.',
  'Invent nothing. If a category has nothing solid, return an empty array. Never include an instruction to yourself to act outward — you cannot.',
].join('\n');

export interface DreamResult {
  footnotes: number;
  hypotheses: number;
  anticipations: number;
}

/** Nightly dream session for the (single) agent. */
export async function runDream(
  deps: { db: Db; router: ModelRouter; heartbeat?: () => Promise<void> },
  opts: { taskId?: string; now?: Date } = {},
): Promise<DreamResult> {
  const { db, router } = deps;
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - WINDOW_HOURS * 3600 * 1000);
  const approvalSince = new Date(now.getTime() - APPROVAL_WINDOW_DAYS * 24 * 3600 * 1000);

  return withSpan('dream.run', {}, async () => {
    await deps.heartbeat?.();
    const [agent] = await db.select({ id: agents.id }).from(agents).limit(1);
    if (!agent) return { footnotes: 0, hypotheses: 0, anticipations: 0 };
    const agentId = agent.id;

    // The day's failures (counterfactual fuel).
    const failedTasks = await db
      .select({ id: tasks.id, type: tasks.type, progress: tasks.progress, status: tasks.status })
      .from(tasks)
      .where(and(inArray(tasks.status, ['needs_attention', 'failed']), gte(tasks.updatedAt, since)))
      .limit(20);
    const failedCalls = await db
      .select({ toolName: toolCalls.toolName, error: toolCalls.error })
      .from(toolCalls)
      .where(and(eq(toolCalls.status, 'failed'), gte(toolCalls.createdAt, since)))
      .limit(40);
    // Recent approval decisions (behavioral patterns — repeated approve/deny).
    const decisions = await db
      .select({ summary: approvals.summary, status: approvals.status })
      .from(approvals)
      .where(
        and(
          gte(approvals.requestedAt, approvalSince),
          inArray(approvals.status, ['approved', 'denied']),
        ),
      )
      .orderBy(desc(approvals.requestedAt))
      .limit(40);

    if (failedTasks.length === 0 && failedCalls.length === 0 && decisions.length < 3) {
      return { footnotes: 0, hypotheses: 0, anticipations: 0 };
    }

    const summary = [
      "Today's failures (tasks that needed attention or failed):",
      ...failedTasks.map((t) => `- ${t.type}: ${(t.progress || t.status).slice(0, 160)}`),
      '',
      'Failed tool calls:',
      ...failedCalls.map((c) => `- ${c.toolName}: ${(c.error ?? 'unknown').slice(0, 120)}`),
      '',
      `Recent approval decisions (last ${APPROVAL_WINDOW_DAYS} days):`,
      ...decisions.map((d) => `- [${d.status}] ${d.summary.slice(0, 120)}`),
    ]
      .filter((line) => line !== undefined)
      .join('\n')
      .slice(0, 6000);

    const outcome = await router
      .object<z.infer<typeof DreamOutputSchema>>('batch', {
        taskId: opts.taskId,
        schema: DreamOutputSchema,
        system: DREAM_SYSTEM,
        prompt: summary,
      })
      .catch((err) => {
        if (!isUnparseableObjectError(err)) throw err;
        console.error('dream: could not structure output', err);
        return null;
      });
    await deps.heartbeat?.();
    if (outcome === null) return { footnotes: 0, hypotheses: 0, anticipations: 0 };
    if (!outcome.ok) {
      throw new BudgetReservationError(
        outcome.decision.reason,
        outcome.decision.reason.includes('monthly') ? nextMonthlyReset() : nextDailyReset(),
      );
    }
    const dream = outcome.object;

    // Behavioral hypotheses → low-confidence QUARANTINED memories (owner reviews).
    let hypothesesSaved = 0;
    for (const h of dream.hypotheses) {
      const content = h.claim.trim();
      const contentHash = createHash('sha256').update(`dream:${content}`).digest('hex');
      if (await isTombstoned(db, contentHash)) continue;
      const [embedding] = await router.embed([content], { taskId: opts.taskId });
      await deps.heartbeat?.();
      const subject = h.subject ? await resolveSubjectContact(db, { subject: h.subject }) : null;
      const [saved] = await db
        .insert(memories)
        .values({
          agentId,
          category: 'knowledge',
          kind: 'preference',
          content,
          contentHash,
          embedding,
          importance: 2,
          confidence: String(Math.min(h.confidence, MAX_HYPOTHESIS_CONFIDENCE)),
          originTrust: 'assistant',
          quarantined: true, // awaits the owner's confirm/reject on Profile
          subjectContactId: subject?.contactId,
          source: 'dream',
          sourceTaskId: opts.taskId,
          expiresAt: new Date(now.getTime() + HYPOTHESIS_TTL_DAYS * 24 * 3600 * 1000),
        })
        .onConflictDoNothing({ target: memories.contentHash })
        .returning({ id: memories.id });
      if (saved) hypothesesSaved += 1;
    }

    // Owner-facing notes (footnotes + anticipations) → dream_notes (7-day TTL).
    const expiresAt = new Date(now.getTime() + DREAM_NOTE_TTL_DAYS * 24 * 3600 * 1000);
    const noteRows = [
      ...dream.footnotes.map((content) => ({ agentId, kind: 'footnote', content, expiresAt })),
      ...dream.anticipations.map((content) => ({
        agentId,
        kind: 'anticipation',
        content,
        expiresAt,
      })),
    ];
    if (noteRows.length > 0) await db.insert(dreamNotes).values(noteRows);

    // A single consolidated "while you slept" note, only if there's something to say.
    if (dream.footnotes.length > 0) {
      const body = `🌙 While you slept, I reflected on today:\n${dream.footnotes.map((f) => `• ${f}`).join('\n')}${
        hypothesesSaved > 0
          ? `\n\n${hypothesesSaved} pattern${hypothesesSaved === 1 ? '' : 's'} I noticed are waiting for you to confirm or dismiss on the What I remember page.`
          : ''
      }`;
      await notifyOwnerInNotifications(db, agentId, body, opts.taskId).catch((err) =>
        console.error('dream: owner notify failed', err),
      );
    }

    return {
      footnotes: dream.footnotes.length,
      hypotheses: hypothesesSaved,
      anticipations: dream.anticipations.length,
    };
  });
}

/** Recent dream notes (for the morning brief / a dashboard). */
export async function recentDreamNotes(
  db: Db,
  agentId: string,
  limit = 10,
): Promise<DreamNoteRow[]> {
  return db
    .select()
    .from(dreamNotes)
    .where(and(eq(dreamNotes.agentId, agentId), gte(dreamNotes.expiresAt, sql`now()`)))
    .orderBy(desc(dreamNotes.createdAt))
    .limit(limit);
}

/** Purge dream notes past their 7-day inspection window (called from the sweep). */
export async function purgeStaleDreamNotes(db: Db, batch = 500): Promise<number> {
  const stale = db
    .select({ id: dreamNotes.id })
    .from(dreamNotes)
    .where(lt(dreamNotes.expiresAt, sql`now()`))
    .limit(batch);
  const deleted = await db
    .delete(dreamNotes)
    .where(inArray(dreamNotes.id, stale))
    .returning({ id: dreamNotes.id });
  return deleted.length;
}
