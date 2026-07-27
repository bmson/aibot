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
  opts: { taskId?: string; since?: Date } = {},
): Promise<ExtractionResult> {
  const { db, router } = deps;
  const since = opts.since ?? new Date(Date.now() - WINDOW_HOURS * 3600 * 1000);

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
      const transcript = rows
        .map((m) => `${m.role === 'user' ? 'them' : 'assistant'}: ${m.text}`)
        .join('\n')
        .slice(-MAX_CHARS_PER_CONVERSATION);
      if (transcript.length < 40) continue;
      result.conversationsScanned += 1;

      // A single conversation the model can't structure (even on the fallback)
      // must not fail the whole nightly extraction into a dead-letter — skip it
      // and carry on. Budget stops still park; other errors still surface.
      const outcome = await router
        .object<z.infer<typeof ExtractionOutputSchema>>('extract', {
          taskId: opts.taskId,
          schema: ExtractionOutputSchema,
          system: extractionSystem(knownNames),
          prompt: `Conversation (source trust: ${trust}):\n${transcript}`,
        })
        .catch((err) => {
          if (!isUnparseableObjectError(err)) throw err;
          console.error(
            `memory extraction: skipping unstructurable conversation ${conversationId}`,
            err,
          );
          return null;
        });
      if (outcome === null) continue;
      await deps.heartbeat?.();
      if (!outcome.ok) {
        throw new BudgetReservationError(
          outcome.decision.reason,
          outcome.decision.reason.includes('monthly') ? nextMonthlyReset() : nextDailyReset(),
        );
      }

      const facts = outcome.object.facts;
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
      for (const occ of outcome.object.occasions ?? []) {
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
