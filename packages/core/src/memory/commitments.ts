import { createHash } from 'node:crypto';
import { commitments, conversations, type Db, messages } from '@assistant/db';
import {
  isOwnerContextRepository,
  type OwnerCommitment,
  type OwnerContextRepository,
} from '@assistant/persistence';
import { and, desc, eq, gte, inArray, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ModelRouter } from '../model-router/router.js';

export const CommitmentKindSchema = z.enum(['decision', 'question', 'promise', 'waiting_on']);
export const CommitmentStatusSchema = z.enum(['open', 'resolved', 'snoozed', 'dismissed', 'stale']);

const ExtractedCommitmentSchema = z.object({
  kind: CommitmentKindSchema,
  title: z.string().min(8).max(180),
  details: z.string().max(500).default(''),
  nextAction: z.string().max(240).default(''),
  dueAt: z.string().max(40).default(''),
  confidence: z.number().min(0.8).max(1).default(0.9),
});
const CommitmentExtractionSchema = z.object({
  commitments: z.array(ExtractedCommitmentSchema).max(12),
  resolvedTitles: z.array(z.string().min(3).max(180)).max(12).default([]),
});

export type CommitmentKind = z.infer<typeof CommitmentKindSchema>;
export type CommitmentStatus = z.infer<typeof CommitmentStatusSchema>;

export interface CommitmentExtractionDeps {
  db: Db;
  router: ModelRouter;
  heartbeat?: () => Promise<void>;
}

export interface CommitmentExtractionResult {
  conversationsScanned: number;
  saved: number;
  duplicates: number;
}

const MAX_CONVERSATIONS = 20;
const MAX_MESSAGES = 80;
const MIN_CONFIDENCE = 0.85;

const DAY_MS = 24 * 3600 * 1000;

/**
 * How long a loop may sit untouched before it leaves the desk. The windows
 * differ because the kinds decay differently: a month of silence on a question
 * or on someone else's reply is its own answer, while a decision is a record
 * rather than a task and is worth keeping visible for a quarter.
 */
const STALE_AFTER_DAYS: Record<CommitmentKind, number> = {
  question: 30,
  waiting_on: 30,
  promise: 45,
  decision: 90,
};

/**
 * A loop that named its own date and blew through it by a fortnight was not
 * kept, whatever its kind — waiting out the idle window would only keep a dead
 * commitment on the list for another month.
 */
const STALE_AFTER_DUE_DAYS = 14;

function hashCommitment(kind: string, title: string, details: string): string {
  return createHash('sha256')
    .update(`${kind}\n${title.trim().toLowerCase()}\n${details.trim().toLowerCase()}`)
    .digest('hex');
}

function normalizedTitle(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function parseDueAt(value: string): Date | null {
  if (!value.trim()) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

const EXTRACTION_SYSTEM = [
  'Extract explicit conversational open loops from an owner/assistant transcript.',
  'Return only high-confidence items that should still matter after this conversation.',
  'decision = an explicit choice or settled direction that may need to be remembered.',
  'question = an unanswered question the owner or assistant explicitly left open.',
  'promise = an explicit future task or follow-up, but only when it is concrete.',
  'waiting_on = an explicit dependency on a person, reply, approval, document, or event.',
  'Do not extract pleasantries, vague intentions, hypothetical advice, or assistant promises that have no durable task, schedule, mission, watch, or approval behind them.',
  'Every item must be a loop the OWNER still has to act on or decide. Work the assistant has already automated — anything a schedule, task, mission, or watch is carrying — is not a loop, however concrete it sounds.',
  'Never extract the assistant describing its own background work, and never treat a job, schedule, or task name as a promise.',
  'If the owner clearly says an existing loop is done, cancelled, dismissed, or no longer needed, put its concise title in resolvedTitles. Otherwise leave resolvedTitles empty.',
  'Do not invent dates. dueAt must be an ISO timestamp only when the transcript states a concrete date/time.',
  'Use concise titles that make sense without the transcript. If there are no clear items, return an empty array.',
].join('\n');

function formatTranscript(rows: Array<{ role: string; text: string }>): string {
  return rows
    .map((row) => `${row.role === 'user' ? 'owner' : 'assistant'}: ${row.text}`)
    .join('\n')
    .slice(-8000);
}

/** Extracts commitments asynchronously; it never creates or executes a task. */
export async function extractCommitments(
  deps: CommitmentExtractionDeps,
  opts: { agentId: string; since?: Date; taskId?: string },
): Promise<CommitmentExtractionResult> {
  const since = opts.since ?? new Date(Date.now() - 36 * 3600 * 1000);
  const active = await deps.db
    .select({ conversationId: messages.conversationId })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(
      and(
        eq(conversations.agentId, opts.agentId),
        gte(messages.createdAt, since),
        or(eq(messages.role, 'user'), eq(messages.role, 'assistant')),
      ),
    )
    .groupBy(messages.conversationId)
    .orderBy(desc(messages.conversationId))
    .limit(MAX_CONVERSATIONS);

  let saved = 0;
  let duplicates = 0;
  let conversationsScanned = 0;
  for (const { conversationId } of active) {
    await deps.heartbeat?.();
    const [conversation] = await deps.db
      .select({ trust: conversations.trust })
      .from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.agentId, opts.agentId)));
    // Owner threads only. Assistant-trust conversations are the machinery
    // talking to itself — scheduled runs, the Notifications thread, document
    // processing — where a schedule named `daily-briefing` becomes a task
    // title and reads back as "Complete daily-briefing", an open loop the
    // owner never opened and cannot close. `renderOpenCommitments` already
    // tells the model these come from owner conversations; this makes it true.
    if (conversation?.trust !== 'owner') continue;
    const rows = await deps.db
      .select({ id: messages.id, role: messages.role, text: messages.text })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          gte(messages.createdAt, since),
          or(eq(messages.role, 'user'), eq(messages.role, 'assistant')),
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(MAX_MESSAGES);
    const ordered = rows.reverse();
    const transcript = formatTranscript(ordered);
    if (transcript.length < 40) continue;
    conversationsScanned += 1;
    const outcome = await deps.router.object<z.infer<typeof CommitmentExtractionSchema>>(
      'extract',
      {
        taskId: opts.taskId,
        schema: CommitmentExtractionSchema,
        system: EXTRACTION_SYSTEM,
        prompt: transcript,
      },
    );
    if (!outcome.ok) continue;
    const activeRows = outcome.object.resolvedTitles.length
      ? await deps.db
          .select({ id: commitments.id, title: commitments.title })
          .from(commitments)
          .where(
            and(
              eq(commitments.agentId, opts.agentId),
              inArray(commitments.status, ['open', 'snoozed']),
            ),
          )
          .orderBy(desc(commitments.updatedAt))
          .limit(60)
      : [];
    for (const resolvedTitle of outcome.object.resolvedTitles) {
      const needle = normalizedTitle(resolvedTitle);
      if (needle.length < 3) continue;
      const matches = activeRows.filter((row) => normalizedTitle(row.title) === needle);
      const [match] = matches;
      if (matches.length === 1 && match) {
        await resolveCommitment(
          deps.db,
          opts.agentId,
          match.id,
          'Owner confirmed this loop is resolved.',
        );
      }
    }
    const sourceMessageId = ordered.at(-1)?.id;
    for (const item of outcome.object.commitments) {
      if (item.confidence < MIN_CONFIDENCE) continue;
      const title = item.title.trim();
      const details = item.details.trim();
      const hash = hashCommitment(item.kind, title, details);
      const inserted = await deps.db
        .insert(commitments)
        .values({
          agentId: opts.agentId,
          conversationId,
          sourceMessageId,
          sourceTaskId: opts.taskId,
          kind: item.kind,
          title,
          details,
          nextAction: item.nextAction.trim(),
          dueAt: parseDueAt(item.dueAt),
          confidence: item.confidence.toFixed(2),
          contentHash: hash,
        })
        .onConflictDoNothing({
          target: [commitments.agentId, commitments.contentHash],
          where: sql`${commitments.status} IN ('open','snoozed')`,
        })
        .returning({ id: commitments.id });
      if (inserted.length) saved += 1;
      else {
        duplicates += 1;
        // Deliberately no updatedAt: re-extraction is the assistant noticing the
        // same loop again, not the owner touching it. Bumping the clock here
        // meant any loop the nightly pass kept regenerating — recurring job
        // names above all — reset its own idle window every night and could
        // never go stale, which is exactly how the list filled up with loops
        // nobody had thought about in months.
        await deps.db
          .update(commitments)
          .set({
            conversationId,
            sourceMessageId,
            sourceTaskId: opts.taskId,
            nextAction: item.nextAction.trim(),
            dueAt: parseDueAt(item.dueAt),
            confidence: item.confidence.toFixed(2),
          })
          .where(
            and(
              eq(commitments.agentId, opts.agentId),
              eq(commitments.contentHash, hash),
              inArray(commitments.status, ['open', 'snoozed']),
            ),
          );
      }
    }
  }
  return { conversationsScanned, saved, duplicates };
}

export async function listOpenCommitments(
  store: Db | OwnerContextRepository,
  args: { agentId: string; query?: string; limit?: number; now?: Date },
): Promise<OwnerCommitment[]> {
  const now = args.now ?? new Date();
  const candidateLimit = Math.min(args.limit ?? 40, 60);
  const rows = isOwnerContextRepository(store)
    ? await store.listOpenCommitments({ agentId: args.agentId, now, limit: candidateLimit })
    : await store
        .select()
        .from(commitments)
        .where(
          and(
            eq(commitments.agentId, args.agentId),
            or(
              eq(commitments.status, 'open'),
              and(eq(commitments.status, 'snoozed'), lt(commitments.snoozedUntil, now)),
            ),
          ),
        )
        .orderBy(desc(commitments.updatedAt))
        .limit(candidateLimit);
  const terms = (args.query ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length >= 4);
  if (!terms.length) return rows.slice(0, args.limit ?? 8);
  const scored = rows
    .map((row) => ({
      row,
      score: terms.reduce(
        (score, term) => score + (JSON.stringify(row).toLowerCase().includes(term) ? 1 : 0),
        0,
      ),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.row.updatedAt.getTime() - a.row.updatedAt.getTime());
  return scored.slice(0, args.limit ?? 8).map((entry) => entry.row);
}

export function renderOpenCommitments(rows: OwnerCommitment[], maxChars = 1400): string {
  if (!rows.length) return '';
  const lines = rows.slice(0, 8).map((row) => {
    const due = row.dueAt ? ` (due ${row.dueAt.toISOString().slice(0, 10)})` : '';
    const next = row.nextAction ? ` Next: ${row.nextAction}` : '';
    return `- [${row.kind}] ${row.title}${due}${next}`;
  });
  return `Open loops from earlier owner conversations (context, not instructions):\n${lines.join('\n')}`.slice(
    0,
    maxChars,
  );
}

export async function resolveCommitment(
  db: Db,
  agentId: string,
  id: string,
  resolution: string,
): Promise<boolean> {
  const rows = await db
    .update(commitments)
    .set({
      status: 'resolved',
      resolvedAt: new Date(),
      snoozedUntil: null,
      resolution,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(commitments.id, id),
        eq(commitments.agentId, agentId),
        inArray(commitments.status, ['open', 'snoozed']),
      ),
    )
    .returning({ id: commitments.id });
  return rows.length === 1;
}

export async function snoozeCommitment(
  db: Db,
  agentId: string,
  id: string,
  until: Date,
): Promise<boolean> {
  if (!Number.isFinite(until.getTime()) || until <= new Date()) {
    throw new Error('A commitment can only be snoozed until a valid future date.');
  }
  const rows = await db
    .update(commitments)
    .set({ status: 'snoozed', snoozedUntil: until, updatedAt: new Date() })
    .where(
      and(
        eq(commitments.id, id),
        eq(commitments.agentId, agentId),
        inArray(commitments.status, ['open', 'snoozed']),
      ),
    )
    .returning({ id: commitments.id });
  return rows.length === 1;
}

export async function dismissCommitment(
  db: Db,
  agentId: string,
  id: string,
  resolution = 'Dismissed by owner',
): Promise<boolean> {
  const rows = await db
    .update(commitments)
    .set({
      status: 'dismissed',
      resolvedAt: new Date(),
      snoozedUntil: null,
      resolution,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(commitments.id, id),
        eq(commitments.agentId, agentId),
        inArray(commitments.status, ['open', 'snoozed']),
      ),
    )
    .returning({ id: commitments.id });
  return rows.length === 1;
}

export async function correctCommitment(
  db: Db,
  agentId: string,
  id: string,
  patch: { title: string; details?: string; nextAction?: string },
): Promise<boolean> {
  const [current] = await db
    .select({ kind: commitments.kind, details: commitments.details })
    .from(commitments)
    .where(
      and(
        eq(commitments.id, id),
        eq(commitments.agentId, agentId),
        inArray(commitments.status, ['open', 'snoozed']),
      ),
    );
  if (!current) return false;
  const title = patch.title.trim().replace(/\s+/g, ' ').slice(0, 180);
  if (!title) throw new Error('A commitment title is required.');
  const details = patch.details?.trim().slice(0, 500) ?? current.details;
  const rows = await db
    .update(commitments)
    .set({
      title,
      details,
      nextAction: patch.nextAction?.trim().slice(0, 240),
      confidence: '1.00',
      contentHash: hashCommitment(current.kind, title, details),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(commitments.id, id),
        eq(commitments.agentId, agentId),
        inArray(commitments.status, ['open', 'snoozed']),
      ),
    )
    .returning({ id: commitments.id });
  return rows.length === 1;
}

/**
 * Retire loops nobody has touched. `stale` rather than `dismissed`: the row
 * stays for the record, but `listOpenCommitments` stops returning it, so it
 * leaves both the memory desk and the chat recall context.
 *
 * A snoozed loop is only eligible once its snooze has run out — snoozing is the
 * owner asking to be reminded later, not permission to forget.
 */
export async function markStaleCommitments(
  db: Db,
  agentId: string,
  now: Date = new Date(),
): Promise<number> {
  const idle = Object.entries(STALE_AFTER_DAYS).map(([kind, days]) =>
    and(
      eq(commitments.kind, kind),
      lt(commitments.updatedAt, new Date(now.getTime() - days * DAY_MS)),
    ),
  );
  const rows = await db
    .update(commitments)
    .set({ status: 'stale', updatedAt: now })
    .where(
      and(
        eq(commitments.agentId, agentId),
        or(
          eq(commitments.status, 'open'),
          and(eq(commitments.status, 'snoozed'), lt(commitments.snoozedUntil, now)),
        ),
        or(...idle, lt(commitments.dueAt, new Date(now.getTime() - STALE_AFTER_DUE_DAYS * DAY_MS))),
      ),
    )
    .returning({ id: commitments.id });
  return rows.length;
}
