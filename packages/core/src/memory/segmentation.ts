import type { Db } from '@assistant/db';
import { conversationSegments, conversations, messages } from '@assistant/db';
import { and, asc, eq, gt, inArray, isNotNull, sql } from 'drizzle-orm';
import type { ModelRouter } from '../model-router/router.js';

/**
 * Topic segmentation for the long-running chat (Phase 2 of
 * docs/long-running-chat-memory.md). Walks each owner thread's messages that
 * are newer than the last recorded segment, groups a contiguous run into a
 * segment whenever the topic drifts or a long time gap opens, then summarizes
 * and embeds each settled group. Recall matches those summary embeddings — a
 * far better retrieval unit than lone messages.
 *
 * Runs offline as the `chat.segment` code job. Never on the chat hot path.
 */

/** Only the router surface segmentation needs — keeps the fake in tests small. */
type Summarizer = Pick<ModelRouter, 'embed' | 'generate'>;

export interface SegmentationOptions {
  taskId?: string;
  /** Restrict to one agent's conversations (the code job passes the task's agent). */
  agentId?: string;
  /** Injectable clock — the trailing-group settle test uses it. */
  now?: Date;
  /** A gap larger than this between consecutive messages forces a boundary. */
  gapMs?: number;
  /** Cosine similarity to the running centroid below which the topic is deemed to have shifted. */
  driftSimilarity?: number;
  /** Force-close a segment once it reaches this many messages. */
  maxMessages?: number;
  /** Don't close the trailing group while its last message is newer than this (topic may continue). */
  settleMs?: number;
  /** Ignore groups smaller than this — avoids one-line segments. */
  minMessages?: number;
  /** Conversations to scan per run. */
  maxConversations?: number;
  /** New segments to summarize per run (cost guard). */
  maxSegments?: number;
  /** Messages loaded per conversation per run. */
  perConversationMessageCap?: number;
}

export interface SegmentationResult {
  conversationsScanned: number;
  segmentsCreated: number;
}

const DEFAULTS = {
  gapMs: 6 * 60 * 60 * 1000,
  driftSimilarity: 0.6,
  maxMessages: 24,
  settleMs: 30 * 60 * 1000,
  minMessages: 2,
  maxConversations: 50,
  maxSegments: 40,
  perConversationMessageCap: 400,
} as const;

/** DEFAULTS merged with caller overrides — widened from the literal `as const`. */
type ResolvedOptions = { -readonly [K in keyof typeof DEFAULTS]: number };

interface Msg {
  id: string;
  role: string;
  text: string;
  createdAt: Date;
  embedding: number[];
}

/** pgvector may surface as number[] (drizzle) or the raw '[...]' string. */
function toVector(value: unknown): number[] | null {
  if (Array.isArray(value)) return value as number[];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? (parsed as number[]) : null;
    } catch {
      return null;
    }
  }
  return null;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function roleLabel(role: string): string {
  return role === 'assistant' ? 'assistant' : 'owner';
}

export async function segmentConversations(
  deps: { db: Db; router: Summarizer },
  options: SegmentationOptions = {},
): Promise<SegmentationResult> {
  const opts = { ...DEFAULTS, ...options };
  const now = options.now ?? new Date();
  const { db, router } = deps;

  const convos = await db
    .select({ id: conversations.id, agentId: conversations.agentId })
    .from(conversations)
    .where(
      and(
        inArray(conversations.trust, ['owner', 'assistant']),
        options.agentId ? eq(conversations.agentId, options.agentId) : sql`true`,
      ),
    )
    .orderBy(sql`${conversations.updatedAt} desc`)
    .limit(opts.maxConversations);

  let segmentsCreated = 0;
  let conversationsScanned = 0;
  for (const convo of convos) {
    if (segmentsCreated >= opts.maxSegments) break;
    conversationsScanned += 1;

    const [watermark] = await db
      .select({ endedAt: conversationSegments.endedAt })
      .from(conversationSegments)
      .where(eq(conversationSegments.conversationId, convo.id))
      .orderBy(sql`${conversationSegments.endedAt} desc`)
      .limit(1);

    const rows = await db
      .select({
        id: messages.id,
        role: messages.role,
        text: messages.text,
        createdAt: messages.createdAt,
        embedding: messages.embedding,
      })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, convo.id),
          inArray(messages.role, ['user', 'assistant']),
          isNotNull(messages.embedding),
          sql`length(${messages.text}) > 0`,
          watermark ? gt(messages.createdAt, watermark.endedAt) : sql`true`,
        ),
      )
      .orderBy(asc(messages.createdAt))
      .limit(opts.perConversationMessageCap);

    const msgs: Msg[] = [];
    for (const r of rows) {
      const embedding = toVector(r.embedding);
      if (embedding) {
        msgs.push({ id: r.id, role: r.role, text: r.text, createdAt: r.createdAt, embedding });
      }
    }
    const groups = groupByTopic(msgs, opts, now);

    for (const group of groups) {
      if (segmentsCreated >= opts.maxSegments) break;
      const created = await commitSegment(db, router, convo.agentId, convo.id, group, opts.taskId);
      if (created) segmentsCreated += 1;
    }
  }

  return { conversationsScanned, segmentsCreated };
}

/** Contiguous topic groups ready to commit. The trailing group is held back until settled. */
function groupByTopic(msgs: Msg[], opts: ResolvedOptions, now: Date): Msg[][] {
  const first = msgs[0];
  if (!first || msgs.length < opts.minMessages) return [];

  const groups: Msg[][] = [];
  let current: Msg[] = [first];
  let sum = [...first.embedding];
  let prevCreatedAt = first.createdAt;

  for (let i = 1; i < msgs.length; i += 1) {
    const m = msgs[i];
    if (!m) continue;
    const centroid = sum.map((x) => x / current.length);
    const gap = m.createdAt.getTime() - prevCreatedAt.getTime();
    const drifted = cosine(m.embedding, centroid) < opts.driftSimilarity;
    if (gap > opts.gapMs || drifted || current.length >= opts.maxMessages) {
      groups.push(current);
      current = [m];
      sum = [...m.embedding];
    } else {
      current.push(m);
      for (let k = 0; k < sum.length; k += 1) {
        sum[k] = (sum[k] ?? 0) + (m.embedding[k] ?? 0);
      }
    }
    prevCreatedAt = m.createdAt;
  }

  // Only commit the trailing group once the conversation has gone quiet, so an
  // in-progress topic isn't split prematurely.
  const lastMessage = current[current.length - 1];
  if (lastMessage && now.getTime() - lastMessage.createdAt.getTime() > opts.settleMs) {
    groups.push(current);
  }
  return groups.filter((group) => group.length >= opts.minMessages);
}

async function commitSegment(
  db: Db,
  router: Summarizer,
  agentId: string,
  conversationId: string,
  group: Msg[],
  taskId: string | undefined,
): Promise<boolean> {
  const first = group[0];
  const last = group[group.length - 1];
  if (!first || !last) return false;

  const transcript = group
    .map((m) => `${roleLabel(m.role)}: ${m.text.replace(/\s+/g, ' ').trim().slice(0, 500)}`)
    .join('\n')
    .slice(0, 6000);
  const summary = await summarize(router, transcript, taskId);
  const [embedding] = await router.embed([summary], { taskId });

  const [row] = await db
    .insert(conversationSegments)
    .values({
      agentId,
      conversationId,
      startMessageId: first.id,
      endMessageId: last.id,
      summary,
      embedding: embedding ?? null,
      messageCount: group.length,
      startedAt: first.createdAt,
      endedAt: last.createdAt,
    })
    .onConflictDoNothing({
      target: [conversationSegments.conversationId, conversationSegments.startMessageId],
    })
    .returning({ id: conversationSegments.id });
  return Boolean(row);
}

async function summarize(
  router: Summarizer,
  transcript: string,
  taskId: string | undefined,
): Promise<string> {
  try {
    const res = await router.generate('extract', {
      taskId,
      system:
        'Summarize this slice of a chat between the owner and their assistant in one or two sentences. Capture the topic and any decision or outcome so it can be found again later. Output only the summary, with no preamble.',
      prompt: transcript,
      maxOutputTokens: 120,
    });
    if (res.ok && res.text.trim()) return res.text.trim().slice(0, 600);
  } catch (err) {
    console.error('segment summarization failed — using fallback', err);
  }
  // Fallback: the first substantive line, so a segment still forms without the model.
  const firstLine = transcript.split('\n')[0] ?? '';
  return firstLine.slice(0, 200) || 'chat discussion';
}
