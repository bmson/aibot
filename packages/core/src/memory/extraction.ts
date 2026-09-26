import { createHash } from 'node:crypto';
import {
  contacts,
  conversations,
  type Db,
  isTombstoned,
  memories,
  messages,
  resolveSubjectContact,
} from '@assistant/db';
import type {
  CodeJobLease,
  ExecutionPersistence,
  ExtractedMemoryFact,
  MemoryExtractionRepository,
} from '@assistant/persistence';
import { and, eq, gte, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getAgent } from '../chat.js';
import { BudgetReservationError, nextDailyReset, nextMonthlyReset } from '../cost.js';
import { isUnparseableObjectError, type ModelRouter } from '../model-router/router.js';
import { withSpan } from '../otel.js';
import { saveOccasion } from './occasions.js';

export const MEMORY_DOMAINS = [
  'identity',
  'work',
  'home',
  'relationships',
  'preferences',
  'health',
  'other',
] as const;
export type MemoryDomain = (typeof MEMORY_DOMAINS)[number];

export const ExtractedFactSchema = z.object({
  content: z
    .string()
    .min(10)
    .max(600)
    .describe('A single self-contained fact, stated in third person with names spelled out.'),
  kind: z.enum(['fact', 'preference', 'person', 'project', 'episode']),
  category: z
    .enum(['knowledge', 'experience'])
    .describe('knowledge = durable fact/preference; experience = what happened (expires).'),
  subject: z
    .string()
    .max(120)
    .describe('Who the fact is about: "owner" for the owner, else the person\'s name.'),
  relationship: z
    .string()
    .max(80)
    .default('')
    .describe(
      'If subject is a person other than the owner: their relationship to the owner, if stated.',
    ),
  domain: z.enum(MEMORY_DOMAINS),
  importance: z.number().int().min(1).max(5).default(3),
  confidence: z.number().min(0).max(1).default(0.7),
  validFrom: z
    .string()
    .default('')
    .describe('ISO date when the fact became true, ONLY if explicitly stated (e.g. "since 2019").'),
});

/** Recurring dates for named people (Phase 17) — mined alongside facts. */
export const ExtractedOccasionSchema = z.object({
  subject: z.string().min(1).max(120).describe('The person whose occasion this is (their name).'),
  kind: z.enum(['birthday', 'anniversary', 'custom']),
  label: z.string().max(120).default('').describe('For a custom occasion, what it is.'),
  month: z.number().int().min(1).max(12),
  day: z.number().int().min(1).max(31),
  year: z.number().int().min(1900).max(2200).nullable().default(null),
  notes: z.string().max(500).default('').describe('Gift ideas or context, if mentioned.'),
});

const ExtractionOutputSchema = z.object({
  facts: z.array(ExtractedFactSchema).max(25),
  occasions: z.array(ExtractedOccasionSchema).max(10).default([]),
});

export interface ExtractionDeps {
  db: Db;
  router: ModelRouter;
  heartbeat?: () => Promise<void>;
  persistence?: ExecutionPersistence;
}

export interface ExtractionResult {
  conversationsScanned: number;
  extracted: number;
  saved: number;
  duplicates: number;
  tombstoned: number;
  quarantined: number;
  contactsCreated: number;
  occasionsSaved: number;
}

const WINDOW_HOURS = 26; // nightly run with an hour of overlap slack
const MAX_CONVERSATIONS = 12;
const MAX_CHARS_PER_CONVERSATION = 8000;
const MAX_MESSAGES_PER_CONVERSATION = 100;
const MIN_MESSAGE_CHARS = 6;
const EXPERIENCE_TTL_MS = 90 * 24 * 3600 * 1000;

function extractionSystem(knownNames: string[]): string {
  return [
    "You extract lasting memories from a personal assistant's conversations with and about its owner.",
    'Extract ONLY genuinely useful, lasting information: facts about the owner or named people,',
    'stable preferences, projects, relationships, and notable episodes. Skip pleasantries,',
    'one-off logistics, anything already implied by another fact, and anything about the assistant itself.',
    'Each fact must stand alone without the conversation ("The owner\'s sister Anna lives in Oslo" — not "his sister lives there").',
    'Attribute each fact to its subject. Use subject "owner" for the owner.',
    knownNames.length
      ? `Known people (use these exact names when the fact is about one of them): ${knownNames.join(', ')}.`
      : '',
    'Also capture OCCASIONS in the separate occasions array: recurring dates for named people —',
    'birthdays, anniversaries, and other dated events ("mom\'s birthday is March 3rd" → subject "mom",',
    'kind "birthday", month 3, day 3). Only when a specific month and day are stated; include the year',
    'only if given, and any gift ideas mentioned as notes.',
    'If nothing is worth remembering, return empty facts and occasions arrays.',
  ]
    .filter(Boolean)
    .join('\n');
}

function extractionTranscript(rows: Array<{ role: string; text: string }>): string {
  return rows
    .map((m) => `${m.role === 'user' ? 'them' : 'assistant'}: ${m.text}`)
    .join('\n')
    .slice(-MAX_CHARS_PER_CONVERSATION);
}

/**
 * One conversation's structured extraction. A conversation the model can't
 * structure (even on the fallback) returns null so it cannot fail the whole
 * nightly run into a dead-letter; budget stops still park, and other errors
 * still surface.
 */
async function extractConversation(
  deps: { router: ModelRouter; heartbeat?: () => Promise<void> },
  input: {
    taskId?: string;
    conversationId: string;
    knownNames: string[];
    trust: string;
    transcript: string;
  },
): Promise<z.infer<typeof ExtractionOutputSchema> | null> {
  const outcome = await deps.router
    .object<z.infer<typeof ExtractionOutputSchema>>('extract', {
      taskId: input.taskId,
      schema: ExtractionOutputSchema,
      system: extractionSystem(input.knownNames),
      prompt: `Conversation (source trust: ${input.trust}):\n${input.transcript}`,
    })
    .catch((err) => {
      if (!isUnparseableObjectError(err)) throw err;
      console.error(
        `memory extraction: skipping unstructurable conversation ${input.conversationId}`,
        err,
      );
      return null;
    });
  if (outcome === null) return null;
  await deps.heartbeat?.();
  if (!outcome.ok) {
    throw new BudgetReservationError(
      outcome.decision.reason,
      outcome.decision.reason.includes('monthly') ? nextMonthlyReset() : nextDailyReset(),
    );
  }
  return outcome.object;
}

export function parseValidFrom(value: string): Date | null {
  if (!value) return null;
  const d = new Date(value.length === 4 ? `${value}-01-01` : value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Nightly memory extraction (Phase 8): review the day's conversations with a
 * structured extract call, attribute each fact to an entity (auto-creating
 * trust:'unknown' contacts for new people), and save non-duplicate,
 * non-tombstoned facts. Facts from untrusted conversations land quarantined.
 */
export async function runMemoryExtraction(
  deps: ExtractionDeps,
  opts: {
    taskId?: string;
    since?: Date;
    agentId?: string;
    /** The running task's current lease; portable stores commit only under it. */
    lease?: () => CodeJobLease;
  } = {},
): Promise<ExtractionResult> {
  const { db, router } = deps;
  const since = opts.since ?? new Date(Date.now() - WINDOW_HOURS * 3600 * 1000);
  if (deps.persistence?.driver === 'firestore') {
    const repository = deps.persistence.memoryExtraction;
    if (!repository)
      throw new Error('Memory extraction repository is missing from Firestore persistence');
    if (!opts.agentId || !opts.lease)
      throw new Error('Firestore memory extraction requires an agent and a task lease');
    return runPortableMemoryExtraction(repository, deps, {
      agentId: opts.agentId,
      taskId: opts.taskId,
      since,
      lease: opts.lease,
    });
  }

  return withSpan('memory.extract', { since: since.toISOString() }, async () => {
    const result: ExtractionResult = {
      conversationsScanned: 0,
      extracted: 0,
      saved: 0,
      duplicates: 0,
      tombstoned: 0,
      quarantined: 0,
      contactsCreated: 0,
      occasionsSaved: 0,
    };

    const activeConversations = await db
      .select({
        conversationId: messages.conversationId,
        lastMessageAt: sql<Date>`max(${messages.createdAt})`,
      })
      .from(messages)
      .where(
        and(
          gte(messages.createdAt, since),
          or(eq(messages.role, 'user'), eq(messages.role, 'assistant')),
          sql`length(${messages.text}) > 5`,
        ),
      )
      .groupBy(messages.conversationId)
      .orderBy(sql`max(${messages.createdAt}) desc`)
      .limit(MAX_CONVERSATIONS);
    if (activeConversations.length === 0) return result;

    // Bound both selected conversations and rows per conversation at the
    // database. A high-volume thread can no longer make nightly extraction
    // load an unbounded day of messages into memory.
    const conversationIds = activeConversations.map((row) => row.conversationId);
    const boundedRows = await Promise.all(
      conversationIds.map((conversationId) =>
        db
          .select({
            conversationId: messages.conversationId,
            role: messages.role,
            text: messages.text,
            createdAt: messages.createdAt,
          })
          .from(messages)
          .where(
            and(
              eq(messages.conversationId, conversationId),
              gte(messages.createdAt, since),
              or(eq(messages.role, 'user'), eq(messages.role, 'assistant')),
              sql`length(${messages.text}) > 5`,
            ),
          )
          .orderBy(sql`${messages.createdAt} desc`)
          .limit(MAX_MESSAGES_PER_CONVERSATION),
      ),
    );
    const byConversation = new Map(
      boundedRows.map((rows, index) => [conversationIds[index] as string, rows.reverse()]),
    );
    const convRows = await db
      .select({ id: conversations.id, trust: conversations.trust, title: conversations.title })
      .from(conversations)
      .where(inArray(conversations.id, conversationIds));
    const trustById = new Map(convRows.map((c) => [c.id, c.trust]));

    const knownContacts = await db.select({ name: contacts.name }).from(contacts);
    const knownNames = knownContacts.map((c) => c.name);
    const agentId = (await getAgent(db)).id;

    for (const conversationId of conversationIds) {
      await deps.heartbeat?.();
      const rows = byConversation.get(conversationId) ?? [];
      const trust = trustById.get(conversationId) ?? 'unknown';
      const transcript = extractionTranscript(rows);
      if (transcript.length < 40) continue;
      result.conversationsScanned += 1;

      const output = await extractConversation(deps, {
        taskId: opts.taskId,
        conversationId,
        knownNames,
        trust,
        transcript,
      });
      if (output === null) continue;

      const facts = output.facts;
      result.extracted += facts.length;
      if (facts.length === 0) continue;

      const embeddings = await router.embed(
        facts.map((f) => f.content),
        { taskId: opts.taskId },
      );
      await deps.heartbeat?.();

      for (let i = 0; i < facts.length; i++) {
        const fact = facts[i];
        const embedding = embeddings[i];
        if (!fact || !embedding) continue;

        const contentHash = createHash('sha256').update(fact.content).digest('hex');
        if (await isTombstoned(db, contentHash)) {
          result.tombstoned += 1;
          continue;
        }

        const resolved = await resolveSubjectContact(db, {
          subject: fact.subject,
          relationship: fact.relationship,
        });
        if (resolved?.created) result.contactsCreated += 1;

        const quarantined = trust !== 'owner' && trust !== 'assistant';
        const [row] = await db
          .insert(memories)
          .values({
            agentId,
            category: fact.category,
            kind: fact.kind,
            content: fact.content,
            contentHash,
            embedding,
            importance: fact.importance,
            confidence: Math.min(fact.confidence, 0.95).toFixed(2),
            originTrust: trust,
            quarantined,
            subjectContactId: resolved?.contactId,
            domain: fact.domain,
            validFrom: parseValidFrom(fact.validFrom),
            source: 'extraction',
            sourceTaskId: opts.taskId,
            expiresAt:
              fact.category === 'experience'
                ? new Date(Date.now() + 90 * 24 * 3600 * 1000)
                : undefined,
          })
          .onConflictDoNothing({ target: memories.contentHash })
          .returning({ id: memories.id });

        if (!row) result.duplicates += 1;
        else {
          result.saved += 1;
          if (quarantined) result.quarantined += 1;
        }
      }

      // Occasions (Phase 17): recurring dates for named people. Same
      // attribution + quarantine rules as facts; a bad date never fails the run.
      for (const occ of output.occasions ?? []) {
        const resolvedContact = await resolveSubjectContact(db, { subject: occ.subject });
        if (!resolvedContact) continue;
        if (resolvedContact.created) result.contactsCreated += 1;
        try {
          const savedOccasion = await saveOccasion(db, {
            agentId,
            contactId: resolvedContact.contactId,
            kind: occ.kind,
            label: occ.label,
            month: occ.month,
            day: occ.day,
            year: occ.year,
            notes: occ.notes,
            originTrust: trust,
            quarantined: trust !== 'owner' && trust !== 'assistant',
            source: 'extraction',
          });
          if (savedOccasion.saved) result.occasionsSaved += 1;
        } catch (err) {
          console.error('memory extraction: skipping unsavable occasion', err);
        }
      }
    }

    return result;
  });
}

/**
 * The same extraction over a portable store. Each conversation's facts and
 * occasions commit in one transaction with a per-task checkpoint, so a task
 * reclaimed mid-run neither re-pays the model for a finished conversation nor
 * saves a differently worded copy of what it already saved.
 */
async function runPortableMemoryExtraction(
  repository: MemoryExtractionRepository,
  deps: ExtractionDeps,
  opts: { agentId: string; taskId?: string; since: Date; lease: () => CodeJobLease },
): Promise<ExtractionResult> {
  return withSpan('memory.extract', { since: opts.since.toISOString() }, async () => {
    const result: ExtractionResult = {
      conversationsScanned: 0,
      extracted: 0,
      saved: 0,
      duplicates: 0,
      tombstoned: 0,
      quarantined: 0,
      contactsCreated: 0,
      occasionsSaved: 0,
    };
    const conversations = await repository.recentConversations({
      agentId: opts.agentId,
      since: opts.since,
      maxConversations: MAX_CONVERSATIONS,
      maxMessages: MAX_MESSAGES_PER_CONVERSATION,
      minTextLength: MIN_MESSAGE_CHARS,
    });
    if (conversations.length === 0) return result;
    const done = new Set(await repository.completedSteps(opts.agentId, opts.lease()));
    const knownNames = await repository.knownContactNames(opts.agentId);

    for (const conversation of conversations) {
      await deps.heartbeat?.();
      const checkpointKey = `memory:${conversation.conversationId}`;
      if (done.has(checkpointKey)) continue;
      const trust = conversation.trust;
      const transcript = extractionTranscript(conversation.messages);
      if (transcript.length < 40) continue;
      result.conversationsScanned += 1;

      const output = await extractConversation(deps, {
        taskId: opts.taskId,
        conversationId: conversation.conversationId,
        knownNames,
        trust,
        transcript,
      });
      if (output === null) continue;
      result.extracted += output.facts.length;

      const facts: ExtractedMemoryFact[] = [];
      if (output.facts.length > 0) {
        const embeddings = await deps.router.embed(
          output.facts.map((f) => f.content),
          { taskId: opts.taskId },
        );
        await deps.heartbeat?.();
        const now = Date.now();
        output.facts.forEach((fact, index) => {
          const embedding = embeddings[index];
          if (!embedding) return;
          facts.push({
            content: fact.content,
            contentHash: createHash('sha256').update(fact.content).digest('hex'),
            embedding,
            category: fact.category,
            kind: fact.kind,
            importance: fact.importance,
            confidence: Math.min(fact.confidence, 0.95).toFixed(2),
            domain: fact.domain,
            validFrom: parseValidFrom(fact.validFrom),
            expiresAt: fact.category === 'experience' ? new Date(now + EXPERIENCE_TTL_MS) : null,
            subject: fact.subject,
            relationship: fact.relationship,
          });
        });
      }
      // As in PostgreSQL, occasions are only kept from a conversation that also
      // yielded facts. An empty outcome still commits its checkpoint.
      const applied = await repository.applyMemories({
        agentId: opts.agentId,
        lease: opts.lease(),
        checkpointKey,
        originTrust: trust,
        quarantined: trust !== 'owner' && trust !== 'assistant',
        facts,
        occasions: output.facts.length > 0 ? (output.occasions ?? []) : [],
      });
      if (!applied) continue;
      result.saved += applied.saved;
      result.quarantined += applied.quarantined;
      result.duplicates += applied.duplicates;
      result.tombstoned += applied.tombstoned;
      result.contactsCreated += applied.contactsCreated;
      result.occasionsSaved += applied.occasionsSaved;
    }
    return result;
  });
}
