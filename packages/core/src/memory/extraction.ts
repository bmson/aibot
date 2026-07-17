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
import type { ModelRouter } from '../model-router/router.js';
import { withSpan } from '../otel.js';

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

const ExtractionOutputSchema = z.object({
  facts: z.array(ExtractedFactSchema).max(25),
});

export interface ExtractionDeps {
  db: Db;
  router: ModelRouter;
}

export interface ExtractionResult {
  conversationsScanned: number;
  extracted: number;
  saved: number;
  duplicates: number;
  tombstoned: number;
  quarantined: number;
  contactsCreated: number;
}

const WINDOW_HOURS = 26; // nightly run with an hour of overlap slack
const MAX_CONVERSATIONS = 12;
const MAX_CHARS_PER_CONVERSATION = 8000;

function extractionSystem(knownNames: string[]): string {
  return [
    "You extract lasting memories from a personal assistant's conversations with and about its owner.",
    'Extract ONLY genuinely useful, lasting information: facts about the owner or named people,',
    'stable preferences, projects, relationships, and notable episodes. Skip pleasantries,',
    'one-off logistics, anything already implied by another fact, and anything about the assistant itself.',
    'Each fact must stand alone without the conversation ("Baldvin\'s sister Anna lives in Oslo" — not "his sister lives there").',
    'Attribute each fact to its subject. Use subject "owner" for the owner (Baldvin).',
    knownNames.length
      ? `Known people (use these exact names when the fact is about one of them): ${knownNames.join(', ')}.`
      : '',
    'If nothing is worth remembering, return an empty facts array.',
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
    };

    const recent = await db
      .select({
        conversationId: messages.conversationId,
        role: messages.role,
        text: messages.text,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(
        and(
          gte(messages.createdAt, since),
          or(eq(messages.role, 'user'), eq(messages.role, 'assistant')),
          sql`length(${messages.text}) > 5`,
        ),
      )
      .orderBy(messages.conversationId, messages.createdAt);
    if (recent.length === 0) return result;

    const byConversation = new Map<string, typeof recent>();
    for (const row of recent) {
      const bucket = byConversation.get(row.conversationId) ?? [];
      bucket.push(row);
      byConversation.set(row.conversationId, bucket);
    }

    // Cap at the most recently ACTIVE conversations — never an arbitrary
    // (uuid-ordered) sample that could drop tonight's real conversations.
    const conversationIds = [...byConversation.entries()]
      .sort(
        (a, b) => (b[1].at(-1)?.createdAt.getTime() ?? 0) - (a[1].at(-1)?.createdAt.getTime() ?? 0),
      )
      .slice(0, MAX_CONVERSATIONS)
      .map(([id]) => id);
    const convRows = await db
      .select({ id: conversations.id, trust: conversations.trust, title: conversations.title })
      .from(conversations)
      .where(inArray(conversations.id, conversationIds));
    const trustById = new Map(convRows.map((c) => [c.id, c.trust]));

    const knownContacts = await db.select({ name: contacts.name }).from(contacts);
    const knownNames = knownContacts.map((c) => c.name);
    const agentId = (await getAgent(db)).id;

    for (const conversationId of conversationIds) {
      const rows = byConversation.get(conversationId) ?? [];
      const trust = trustById.get(conversationId) ?? 'unknown';
      const transcript = rows
        .map((m) => `${m.role === 'user' ? 'them' : 'assistant'}: ${m.text}`)
        .join('\n')
        .slice(-MAX_CHARS_PER_CONVERSATION);
      if (transcript.length < 40) continue;
      result.conversationsScanned += 1;

      const outcome = await router.object<z.infer<typeof ExtractionOutputSchema>>('extract', {
        taskId: opts.taskId,
        schema: ExtractionOutputSchema,
        system: extractionSystem(knownNames),
        prompt: `Conversation (source trust: ${trust}):\n${transcript}`,
      });
      if (!outcome.ok) continue;

      const facts = outcome.object.facts;
      result.extracted += facts.length;
      if (facts.length === 0) continue;

      const embeddings = await router.embed(
        facts.map((f) => f.content),
        { taskId: opts.taskId },
      );

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
    }

    return result;
  });
}
