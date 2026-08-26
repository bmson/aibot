import { createHash } from 'node:crypto';
import { type CommitmentRow, commitments, conversations, type Db, messages } from '@assistant/db';
import { and, desc, eq, gte, lt, or } from 'drizzle-orm';
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

function hashCommitment(kind: string, title: string, details: string): string {
  return createHash('sha256')
    .update(`${kind}\n${title.trim().toLowerCase()}\n${details.trim().toLowerCase()}`)
    .digest('hex');
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
    if (!conversation || !['owner', 'assistant'].includes(conversation.trust)) continue;
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
    for (const resolvedTitle of outcome.object.resolvedTitles) {
      const needle = resolvedTitle.trim().toLowerCase();
      if (needle.length < 3) continue;
      const activeRows = await deps.db
        .select({ id: commitments.id, title: commitments.title })
        .from(commitments)
        .where(and(eq(commitments.agentId, opts.agentId), eq(commitments.status, 'open')))
        .limit(60);
      const match = activeRows.find(
        (row) =>
          row.title.toLowerCase().includes(needle) || needle.includes(row.title.toLowerCase()),
      );
      if (match)
        await resolveCommitment(deps.db, match.id, 'Owner confirmed this loop is resolved.');
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
          kind: item.kind,
          title,
          details,
          nextAction: item.nextAction.trim(),
          dueAt: parseDueAt(item.dueAt),
          confidence: item.confidence.toFixed(2),
          contentHash: hash,
        })
        .onConflictDoNothing({ target: [commitments.agentId, commitments.contentHash] })
        .returning({ id: commitments.id });
      if (inserted.length) saved += 1;
      else duplicates += 1;
    }
  }
  return { conversationsScanned, saved, duplicates };
}

export async function listOpenCommitments(
  db: Db,
  args: { agentId: string; query?: string; limit?: number; now?: Date },
): Promise<CommitmentRow[]> {
  const now = args.now ?? new Date();
  const rows = await db
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
    .limit(Math.min(args.limit ?? 40, 60));
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

export function renderOpenCommitments(rows: CommitmentRow[], maxChars = 1400): string {
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

export async function resolveCommitment(db: Db, id: string, resolution: string): Promise<void> {
  await db
    .update(commitments)
    .set({ status: 'resolved', resolvedAt: new Date(), resolution })
    .where(eq(commitments.id, id));
}

export async function snoozeCommitment(db: Db, id: string, until: Date): Promise<void> {
  await db
    .update(commitments)
    .set({ status: 'snoozed', snoozedUntil: until })
    .where(eq(commitments.id, id));
}

export async function dismissCommitment(
  db: Db,
  id: string,
  resolution = 'Dismissed by owner',
): Promise<void> {
  await db
    .update(commitments)
    .set({ status: 'dismissed', resolvedAt: new Date(), resolution })
    .where(eq(commitments.id, id));
}

export async function correctCommitment(
  db: Db,
  id: string,
  patch: { title: string; details?: string; nextAction?: string },
): Promise<void> {
  await db
    .update(commitments)
    .set({
      title: patch.title.trim().slice(0, 180),
      details: patch.details?.trim().slice(0, 500),
      nextAction: patch.nextAction?.trim().slice(0, 240),
      confidence: '1.00',
    })
    .where(eq(commitments.id, id));
}

export async function markStaleCommitments(db: Db, agentId: string, before: Date): Promise<number> {
  const rows = await db
    .update(commitments)
    .set({ status: 'stale' })
    .where(
      and(
        eq(commitments.agentId, agentId),
        eq(commitments.status, 'open'),
        lt(commitments.updatedAt, before),
      ),
    )
    .returning({ id: commitments.id });
  return rows.length;
}
