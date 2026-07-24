import { createHash } from 'node:crypto';
import { contacts, type Db, isTombstoned, memories, ownerCard } from '@assistant/db';
import { and, eq, gt, inArray, isNull, ne, notInArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { BudgetReservationError, nextDailyReset, nextMonthlyReset } from '../cost.js';
import { isUnparseableObjectError, type ModelRouter } from '../model-router/router.js';
import { withSpan } from '../otel.js';
import { MEMORY_DOMAINS } from './extraction.js';
import { saveOccasion } from './occasions.js';

/**
 * Nightly consolidation (Phase 8): per entity, the model DETECTS duplicate
 * groups, contradiction groups, and same-topic merge groups; the CODE decides
 * winners (confidence-weighted, newer-wins, owner-confirmed always wins),
 * writes unified facts, and expires losers/members with supersededById
 * provenance — superseded facts expire, they are never deleted.
 * Ends by recompiling the owner card.
 */

const ConsolidationFindingsSchema = z.object({
  duplicateGroups: z
    .array(z.array(z.string()).min(2).max(10))
    .max(20)
    .describe('Groups of fact ids that state the SAME thing (possibly in different words).'),
  contradictionGroups: z
    .array(z.array(z.string()).min(2).max(10))
    .max(20)
    .describe('Groups of fact ids that CANNOT all be true at once.'),
  mergeGroups: z
    .array(
      z.object({
        ids: z.array(z.string()).min(2).max(6),
        unified: z.string().min(10).max(300),
      }),
    )
    .max(15)
    .default([])
    .describe(
      'Groups of facts about the SAME topic/attribute that read better as one crisp sentence, with the unified wording. Faithful to the members — no invention, no dropped specifics. Do NOT merge unrelated facts or facts marked [curated].',
    ),
  domainFixes: z
    .array(z.object({ id: z.string(), domain: z.enum(MEMORY_DOMAINS) }))
    .max(40)
    .describe('Facts whose life domain is missing or wrong.'),
  timeline: z
    .array(
      z.object({
        id: z.string(),
        validFrom: z.string().default(''),
        validUntil: z.string().default(''),
      }),
    )
    .max(40)
    .describe(
      'Temporal validity explicitly stated in a fact ("2019–2023", "since March"). ISO dates; empty string = unknown/open.',
    ),
  occasions: z
    .array(
      z.object({
        kind: z.enum(['birthday', 'anniversary', 'custom']),
        label: z.string().max(120).default('').describe('For a custom occasion, what it is.'),
        month: z.number().int().min(1).max(12),
        day: z.number().int().min(1).max(31),
        year: z.number().int().min(1900).max(2200).nullable().default(null),
        notes: z.string().max(500).default('').describe('Gift ideas or context, if mentioned.'),
      }),
    )
    .max(10)
    .default([])
    .describe(
      'Recurring dates for THIS person stated in the facts — birthdays, anniversaries, and other dated events. Only when a specific month and day are given; include the year only if stated.',
    ),
});
type ConsolidationFindings = z.infer<typeof ConsolidationFindingsSchema>;

interface FactLite {
  id: string;
  agentId: string;
  content: string;
  kind: string;
  confidence: string;
  importance: number;
  domain: string | null;
  ownerConfirmed: boolean;
  pinned: boolean;
  lastConsolidatedAt: Date | null;
  createdAt: Date;
  validFrom: Date | null;
  validUntil: Date | null;
}

const MAX_WINDOWS_PER_RUN = 12;
const MAX_FACTS_PER_ENTITY = 60;

/**
 * Pick the surviving fact of a group. Owner-confirmed beats everything;
 * otherwise confidence-weighted with a newest bonus (newer-wins on ties).
 * Exported for tests.
 */
export function pickWinner(group: FactLite[]): FactLite {
  const newest = group.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
  const score = (f: FactLite) =>
    (f.ownerConfirmed ? 10 : 0) + Number(f.confidence) + (f.id === newest.id ? 0.15 : 0);
  return [...group].sort(
    (a, b) => score(b) - score(a) || b.createdAt.getTime() - a.createdAt.getTime(),
  )[0] as FactLite;
}

function parseIsoDate(value: string): Date | null {
  if (!value) return null;
  const d = new Date(value.length === 4 ? `${value}-01-01` : value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export interface ConsolidationResult {
  entities: number;
  batches: number;
  memoriesReviewed: number;
  standaloneReviewed: number;
  duplicatesExpired: number;
  contradictionsResolved: number;
  factsUnified: number;
  domainsAssigned: number;
  occasionsSaved: number;
  cardCompiled: boolean;
}

export async function runMemoryConsolidation(
  deps: { db: Db; router: ModelRouter; heartbeat?: () => Promise<void> },
  opts: { taskId?: string; agentId?: string } = {},
): Promise<ConsolidationResult> {
  const { db, router } = deps;
  return withSpan('memory.consolidate', {}, async () => {
    const result: ConsolidationResult = {
      entities: 0,
      batches: 0,
      memoriesReviewed: 0,
      standaloneReviewed: 0,
      duplicatesExpired: 0,
      contradictionsResolved: 0,
      factsUnified: 0,
      domainsAssigned: 0,
      occasionsSaved: 0,
      cardCompiled: false,
    };

    const activeFacts = and(
      opts.agentId ? eq(memories.agentId, opts.agentId) : undefined,
      eq(memories.category, 'knowledge'),
      eq(memories.quarantined, false),
      or(isNull(memories.expiresAt), gt(memories.expiresAt, sql`now()`)),
    );

    // A fact with no subject, or the only fact about a person, has nothing it
    // can be compared with. Treat it as organized instead of leaving it in the
    // owner's backlog forever. This is a lifecycle stamp, not a content rewrite.
    const singletonEntities = await db
      .select({ subjectContactId: memories.subjectContactId, n: sql<number>`count(*)` })
      .from(memories)
      .where(and(activeFacts, sql`${memories.subjectContactId} IS NOT NULL`))
      .groupBy(memories.subjectContactId)
      .having(sql`count(*) = 1`);
    const singletonIds = singletonEntities
      .map((row) => row.subjectContactId)
      .filter((id): id is string => Boolean(id));
    const standaloneReviewed = await db
      .update(memories)
      .set({ lastConsolidatedAt: sql`now()` })
      .where(
        and(
          activeFacts,
          isNull(memories.lastConsolidatedAt),
          or(
            isNull(memories.subjectContactId),
            singletonIds.length > 0 ? inArray(memories.subjectContactId, singletonIds) : undefined,
          ),
        ),
      )
      .returning({ id: memories.id });
    result.standaloneReviewed = standaloneReviewed.length;

    // Work in bounded windows rather than taking one window per person. A
    // large owner profile can otherwise take dozens of manual clicks while
    // small profiles consume the rest of the run. Re-querying after each
    // window keeps null (never-reviewed) facts at the front of the queue.
    const processedEntities = new Set<string>();
    const failedEntities = new Set<string>();
    for (let window = 0; window < MAX_WINDOWS_PER_RUN; window += 1) {
      await deps.heartbeat?.();
      const [entity] = await db
        .select({ subjectContactId: memories.subjectContactId })
        .from(memories)
        .where(
          and(
            activeFacts,
            sql`${memories.subjectContactId} IS NOT NULL`,
            failedEntities.size > 0
              ? notInArray(memories.subjectContactId, [...failedEntities])
              : undefined,
          ),
        )
        .groupBy(memories.subjectContactId)
        .having(
          sql`count(*) >= 2 AND count(*) FILTER (WHERE ${memories.lastConsolidatedAt} IS NULL) > 0`,
        )
        .orderBy(
          sql`min(${memories.lastConsolidatedAt}) asc nulls first`,
          sql`count(*) FILTER (WHERE ${memories.lastConsolidatedAt} IS NULL) desc`,
        )
        .limit(1);
      if (!entity) break;
      if (!entity.subjectContactId) continue;
      processedEntities.add(entity.subjectContactId);
      result.entities = processedEntities.size;
      const facts: FactLite[] = await db
        .select({
          id: memories.id,
          agentId: memories.agentId,
          content: memories.content,
          kind: memories.kind,
          confidence: memories.confidence,
          importance: memories.importance,
          domain: memories.domain,
          ownerConfirmed: memories.ownerConfirmed,
          pinned: memories.pinned,
          lastConsolidatedAt: memories.lastConsolidatedAt,
          createdAt: memories.createdAt,
          validFrom: memories.validFrom,
          validUntil: memories.validUntil,
        })
        .from(memories)
        .where(and(activeFacts, eq(memories.subjectContactId, entity.subjectContactId)))
        // rotation: least-recently-reviewed facts first, so an entity with more
        // than MAX_FACTS_PER_ENTITY facts is groomed in full over several runs
        // instead of re-reviewing the same oldest window forever
        .orderBy(sql`${memories.lastConsolidatedAt} asc nulls first`, memories.createdAt)
        .limit(MAX_FACTS_PER_ENTITY);
      if (facts.length < 2) continue;
      result.entities += 1;

      const byId = new Map(facts.map((f) => [f.id, f]));
      const listing = facts
        .map(
          (f) =>
            `id=${f.id} | ${f.createdAt.toISOString().slice(0, 10)} | conf=${f.confidence} | domain=${f.domain ?? '?'}${f.ownerConfirmed || f.pinned ? ' | [curated]' : ''} | ${f.content}`,
        )
        .join('\n');

      // One entity whose facts the model can't structure (even on the fallback)
      // must not fail the whole nightly consolidation into a dead-letter — skip
      // it and carry on. Budget stops still park; other errors still surface.
      const outcome = await router
        .object<ConsolidationFindings>('extract', {
          taskId: opts.taskId,
          schema: ConsolidationFindingsSchema,
          system: [
            "You review one person's memory facts for a personal assistant.",
            'Find exact-or-paraphrase duplicates, direct contradictions, missing/wrong life domains,',
            'explicitly stated temporal validity, and same-topic groups worth merging into one',
            'unified sentence. Refer to facts ONLY by their id.',
            'Do NOT invent contradictions — different facts about the same topic are fine unless they cannot both be true.',
            'Merging: only group fragmented facts about the SAME topic or attribute whose combined',
            'sentence loses nothing ("drinks coffee black" + "prefers espresso after lunch" →',
            '"Drinks coffee black; espresso after lunch"). Keep every specific, invent nothing,',
            'and leave facts marked [curated] alone.',
            'Occasions: if a fact states a recurring date for THIS person (a birthday,',
            'anniversary, or other dated event with a specific month and day), surface it in',
            'the occasions array so it can be reminded at lead time. Include the year only if',
            'stated. Do not guess a date that is not written in a fact.',
          ].join('\n'),
          prompt: listing,
        })
        .catch((err) => {
          if (!isUnparseableObjectError(err)) throw err;
          console.error(
            `memory consolidation: skipping entity ${entity.subjectContactId} the model could not structure`,
            err,
          );
          return null;
        });
      if (outcome === null) {
        failedEntities.add(entity.subjectContactId);
        continue;
      }
      await deps.heartbeat?.();
      if (!outcome.ok) {
        throw new BudgetReservationError(
          outcome.decision.reason,
          outcome.decision.reason.includes('monthly') ? nextMonthlyReset() : nextDailyReset(),
        );
      }

      const expireLosers = async (group: string[], kind: 'duplicate' | 'contradiction') => {
        const members = group.map((id) => byId.get(id)).filter((f): f is FactLite => Boolean(f));
        if (members.length < 2) return;
        const winner = pickWinner(members);
        for (const loser of members) {
          if (loser.id === winner.id) continue;
          // never silently expire an owner-confirmed fact in favor of an unconfirmed one
          if (loser.ownerConfirmed && !winner.ownerConfirmed) continue;
          await db
            .update(memories)
            .set({ expiresAt: sql`now()`, supersededById: winner.id })
            .where(eq(memories.id, loser.id));
          byId.delete(loser.id);
          if (kind === 'duplicate') result.duplicatesExpired += 1;
          else result.contradictionsResolved += 1;
        }
      };

      for (const group of outcome.object.duplicateGroups) await expireLosers(group, 'duplicate');
      for (const group of outcome.object.contradictionGroups)
        await expireLosers(group, 'contradiction');

      const mostCommon = (values: Array<string | null>): string | null => {
        const counts = new Map<string, number>();
        for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
        return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      };

      for (const merge of outcome.object.mergeGroups) {
        const members = merge.ids
          .map((id) => byId.get(id))
          .filter((f): f is FactLite => Boolean(f))
          // owner-curated wording is sacrosanct — never fold it into a rewrite
          .filter((f) => !f.ownerConfirmed && !f.pinned);
        if (members.length < 2) continue;
        const unified = merge.unified.trim();
        const contentHash = createHash('sha256').update(unified).digest('hex');
        if (await isTombstoned(db, contentHash)) continue;
        const [embedding] = await router.embed([unified]);
        await deps.heartbeat?.();
        const [row] = await db
          .insert(memories)
          .values({
            agentId: (members[0] as FactLite).agentId,
            category: 'knowledge',
            kind: mostCommon(members.map((m) => m.kind)) ?? 'fact',
            content: unified,
            contentHash,
            embedding,
            importance: Math.max(...members.map((m) => m.importance)),
            // a unified claim is only as reliable as its shakiest member
            confidence: Math.min(...members.map((m) => Number(m.confidence))).toFixed(2),
            originTrust: 'assistant',
            subjectContactId: entity.subjectContactId,
            domain: mostCommon(members.map((m) => m.domain)),
            sourceTaskId: opts.taskId,
            lastConsolidatedAt: sql`now()`,
          })
          .onConflictDoNothing({ target: memories.contentHash })
          .returning();
        if (!row) continue; // unified wording already stored
        for (const member of members) {
          await db
            .update(memories)
            .set({ expiresAt: sql`now()`, supersededById: row.id })
            .where(eq(memories.id, member.id));
          byId.delete(member.id);
          result.factsUnified += 1;
        }
      }

      for (const fix of outcome.object.domainFixes) {
        const fact = byId.get(fix.id);
        if (!fact || fact.domain === fix.domain) continue;
        await db.update(memories).set({ domain: fix.domain }).where(eq(memories.id, fix.id));
        result.domainsAssigned += 1;
      }

      for (const t of outcome.object.timeline) {
        const fact = byId.get(t.id);
        if (!fact) continue;
        const validFrom = parseIsoDate(t.validFrom);
        const validUntil = parseIsoDate(t.validUntil);
        if (!validFrom && !validUntil) continue;
        await db
          .update(memories)
          .set({
            ...(validFrom ? { validFrom } : {}),
            ...(validUntil ? { validUntil } : {}),
          })
          .where(eq(memories.id, t.id));
      }

      // Backfill occasions from dates already stated in this person's facts, so
      // a birthday captured before occasion-mining existed (or imported as plain
      // text) still populates the Occasions panel and morning brief. Derived
      // from already-vetted active facts → not quarantined; saveOccasion is an
      // idempotent upsert, so re-running never duplicates. A bad date is skipped
      // rather than failing the whole pass.
      for (const occ of outcome.object.occasions ?? []) {
        try {
          const saved = await saveOccasion(db, {
            agentId: (facts[0] as FactLite).agentId,
            contactId: entity.subjectContactId,
            kind: occ.kind,
            label: occ.label,
            month: occ.month,
            day: occ.day,
            year: occ.year,
            notes: occ.notes,
            originTrust: 'assistant',
            quarantined: false,
            source: 'consolidation',
          });
          if (saved.saved) result.occasionsSaved += 1;
        } catch (err) {
          console.error('memory consolidation: skipping unsavable occasion', err);
        }
      }

      // everything reviewed this round goes to the back of the rotation queue
      await db
        .update(memories)
        .set({ lastConsolidatedAt: sql`now()` })
        .where(
          inArray(
            memories.id,
            facts.map((f) => f.id),
          ),
        );
      result.batches += 1;
      result.memoriesReviewed += facts.filter((fact) => fact.lastConsolidatedAt === null).length;
    }

    await deps.heartbeat?.();
    await compileOwnerCard(db);
    result.cardCompiled = true;
    return result;
  });
}

const CARD_DOMAIN_ORDER = [
  'identity',
  'work',
  'home',
  'relationships',
  'preferences',
  'health',
  'other',
] as const;
/** Exported so the Profile page can mark exactly which facts are in the card. */
export const CARD_AUTO_FACTS_PER_DOMAIN = 2;
export const CARD_AUTO_MIN_IMPORTANCE = 4;
const CARD_PEOPLE_LIMIT = 5;
const CARD_PEOPLE_MIN_FACTS = 3;

/**
 * Deterministic (model-free) owner-card compile, kept deliberately small:
 * facts the owner PINNED always make the card; beyond those, only a couple
 * of HIGH-IMPORTANCE facts per life domain are auto-selected — ordinary
 * extracted facts (importance 3) never auto-surface. Everything else stays
 * out of the prompt and is reachable on demand via memory.recall — the
 * card's footer tells the model how much that covers.
 * Rebuilt nightly after consolidation and on demand from the Profile page.
 */
export async function compileOwnerCard(db: Db): Promise<string> {
  const [owner] = await db.select().from(contacts).where(eq(contacts.trust, 'owner')).limit(1);

  const lines: string[] = [];
  let omitted = 0;
  if (owner) {
    const facts = await db
      .select({
        content: memories.content,
        domain: memories.domain,
        importance: memories.importance,
        confidence: memories.confidence,
        pinned: memories.pinned,
        validFrom: memories.validFrom,
        validUntil: memories.validUntil,
      })
      .from(memories)
      .where(
        and(
          eq(memories.subjectContactId, owner.id),
          eq(memories.category, 'knowledge'),
          eq(memories.quarantined, false),
          or(isNull(memories.expiresAt), gt(memories.expiresAt, sql`now()`)),
        ),
      )
      .orderBy(sql`${memories.importance} desc`, sql`${memories.confidence} desc`);

    for (const domain of CARD_DOMAIN_ORDER) {
      const inDomain = facts.filter((f) => (f.domain ?? 'other') === domain);
      const chosen = [
        ...inDomain.filter((f) => f.pinned),
        ...inDomain
          .filter((f) => !f.pinned && f.importance >= CARD_AUTO_MIN_IMPORTANCE)
          .slice(0, CARD_AUTO_FACTS_PER_DOMAIN),
      ];
      omitted += inDomain.length - chosen.length;
      if (chosen.length === 0) continue;
      lines.push(`${domain[0]?.toUpperCase()}${domain.slice(1)}:`);
      for (const f of chosen) {
        const span = f.validFrom
          ? ` (${f.validFrom.toISOString().slice(0, 10)}–${f.validUntil ? f.validUntil.toISOString().slice(0, 10) : 'now'})`
          : '';
        const hedge = Number(f.confidence) < 0.5 ? ' (unconfirmed)' : '';
        lines.push(`- ${f.content}${span}${hedge}`);
      }
    }
  }

  const peopleRows = await db
    .select({
      id: contacts.id,
      name: contacts.name,
      relationship: contacts.relationship,
      n: sql<number>`count(${memories.id})`,
    })
    .from(contacts)
    .leftJoin(
      memories,
      and(
        eq(memories.subjectContactId, contacts.id),
        eq(memories.quarantined, false),
        or(isNull(memories.expiresAt), gt(memories.expiresAt, sql`now()`)),
      ),
    )
    .where(ne(contacts.trust, 'owner'))
    .groupBy(contacts.id, contacts.name, contacts.relationship)
    .having(sql`count(${memories.id}) > 0`)
    .orderBy(sql`count(${memories.id}) desc`);

  // Facts the owner pinned about a specific person belong in the always-on card
  // just like pinned owner facts do — otherwise "Always in profile" is a silent
  // no-op on person pages. Collect them so each person can carry their pins as
  // sub-bullets, and so a pinned-about person is never omitted from the list.
  const pinnedPersonFacts = await db
    .select({ contactId: memories.subjectContactId, content: memories.content })
    .from(memories)
    .innerJoin(contacts, eq(memories.subjectContactId, contacts.id))
    .where(
      and(
        ne(contacts.trust, 'owner'),
        eq(memories.pinned, true),
        eq(memories.category, 'knowledge'),
        eq(memories.quarantined, false),
        or(isNull(memories.expiresAt), gt(memories.expiresAt, sql`now()`)),
      ),
    )
    .orderBy(sql`${memories.importance} desc`, sql`${memories.confidence} desc`);
  const pinnedByContact = new Map<string, string[]>();
  for (const f of pinnedPersonFacts) {
    if (!f.contactId) continue;
    const list = pinnedByContact.get(f.contactId) ?? [];
    list.push(f.content);
    pinnedByContact.set(f.contactId, list);
  }

  // Include a person when they clearly matter (a named relationship or a real
  // body of facts) OR when the owner pinned a fact about them. Pinned-about
  // people sort first so the limit never drops an explicit owner choice.
  const people = peopleRows
    .filter(
      (p) => p.relationship || Number(p.n) >= CARD_PEOPLE_MIN_FACTS || pinnedByContact.has(p.id),
    )
    .sort(
      (a, b) =>
        (pinnedByContact.has(b.id) ? 1 : 0) - (pinnedByContact.has(a.id) ? 1 : 0) ||
        Number(b.n) - Number(a.n),
    )
    .slice(0, CARD_PEOPLE_LIMIT);
  const peopleOmitted = peopleRows.length - people.length;

  if (people.length > 0) {
    lines.push('People:');
    for (const p of people) {
      lines.push(`- ${p.name}${p.relationship ? ` (${p.relationship})` : ''}`);
      for (const fact of pinnedByContact.get(p.id) ?? []) {
        lines.push(`  - ${fact}`);
      }
    }
  }

  const extras: string[] = [];
  if (omitted > 0) extras.push(`${omitted} more owner facts`);
  if (peopleOmitted > 0) extras.push(`${peopleOmitted} more people`);
  if (extras.length > 0) {
    lines.push(`(+${extras.join(' and ')} in memory — use memory.recall to look them up.)`);
  }

  const content = lines.join('\n');
  await db
    .insert(ownerCard)
    .values({ id: 1, content, compiledAt: sql`now()` })
    .onConflictDoUpdate({
      target: ownerCard.id,
      set: { content, compiledAt: sql`now()` },
    });
  return content;
}

/** The compiled card for prompt injection ('' when never compiled). */
export async function getOwnerCard(db: Db): Promise<string> {
  const [row] = await db.select().from(ownerCard).where(eq(ownerCard.id, 1)).limit(1);
  return row?.content ?? '';
}
