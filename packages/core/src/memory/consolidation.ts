import { contacts, type Db, memories, ownerCard } from '@assistant/db';
import { and, eq, gt, isNull, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ModelRouter } from '../model-router/router.js';
import { withSpan } from '../otel.js';
import { MEMORY_DOMAINS } from './extraction.js';

/**
 * Nightly consolidation (Phase 8): per entity, the model DETECTS duplicate
 * groups and contradiction groups; the CODE decides winners (confidence-
 * weighted, newer-wins, owner-confirmed always wins) and expires losers with
 * supersededById provenance — superseded facts expire, they are never deleted.
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
});
type ConsolidationFindings = z.infer<typeof ConsolidationFindingsSchema>;

interface FactLite {
  id: string;
  content: string;
  confidence: string;
  importance: number;
  domain: string | null;
  ownerConfirmed: boolean;
  createdAt: Date;
  validFrom: Date | null;
  validUntil: Date | null;
}

const MAX_ENTITIES_PER_RUN = 12;
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
  duplicatesExpired: number;
  contradictionsResolved: number;
  domainsAssigned: number;
  cardCompiled: boolean;
}

export async function runMemoryConsolidation(
  deps: { db: Db; router: ModelRouter },
  opts: { taskId?: string } = {},
): Promise<ConsolidationResult> {
  const { db, router } = deps;
  return withSpan('memory.consolidate', {}, async () => {
    const result: ConsolidationResult = {
      entities: 0,
      duplicatesExpired: 0,
      contradictionsResolved: 0,
      domainsAssigned: 0,
      cardCompiled: false,
    };

    const activeFacts = and(
      eq(memories.category, 'knowledge'),
      eq(memories.quarantined, false),
      or(isNull(memories.expiresAt), gt(memories.expiresAt, sql`now()`)),
    );

    const entityRows = await db
      .select({ subjectContactId: memories.subjectContactId, n: sql<number>`count(*)` })
      .from(memories)
      .where(and(activeFacts, sql`${memories.subjectContactId} IS NOT NULL`))
      .groupBy(memories.subjectContactId)
      .having(sql`count(*) >= 2`)
      .orderBy(sql`count(*) desc`)
      .limit(MAX_ENTITIES_PER_RUN);

    for (const entity of entityRows) {
      if (!entity.subjectContactId) continue;
      const facts: FactLite[] = await db
        .select({
          id: memories.id,
          content: memories.content,
          confidence: memories.confidence,
          importance: memories.importance,
          domain: memories.domain,
          ownerConfirmed: memories.ownerConfirmed,
          createdAt: memories.createdAt,
          validFrom: memories.validFrom,
          validUntil: memories.validUntil,
        })
        .from(memories)
        .where(and(activeFacts, eq(memories.subjectContactId, entity.subjectContactId)))
        .orderBy(memories.createdAt)
        .limit(MAX_FACTS_PER_ENTITY);
      if (facts.length < 2) continue;
      result.entities += 1;

      const byId = new Map(facts.map((f) => [f.id, f]));
      const listing = facts
        .map(
          (f) =>
            `id=${f.id} | ${f.createdAt.toISOString().slice(0, 10)} | conf=${f.confidence} | domain=${f.domain ?? '?'} | ${f.content}`,
        )
        .join('\n');

      const outcome = await router.object<ConsolidationFindings>('extract', {
        taskId: opts.taskId,
        schema: ConsolidationFindingsSchema,
        system: [
          "You review one person's memory facts for a personal assistant.",
          'Find exact-or-paraphrase duplicates, direct contradictions, missing/wrong life domains,',
          'and explicitly stated temporal validity. Refer to facts ONLY by their id.',
          'Do NOT invent contradictions — different facts about the same topic are fine unless they cannot both be true.',
        ].join('\n'),
        prompt: listing,
      });
      if (!outcome.ok) continue;

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
    }

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
const CARD_FACTS_PER_DOMAIN = 8;
const CARD_PEOPLE_LIMIT = 10;

/**
 * Deterministic (model-free) owner-card compile: top active facts about the
 * owner grouped by life domain, plus the people the assistant knows.
 * Rebuilt nightly after consolidation and on demand from the Profile page.
 */
export async function compileOwnerCard(db: Db): Promise<string> {
  const [owner] = await db.select().from(contacts).where(eq(contacts.trust, 'owner')).limit(1);

  const lines: string[] = [];
  if (owner) {
    const facts = await db
      .select({
        content: memories.content,
        domain: memories.domain,
        importance: memories.importance,
        confidence: memories.confidence,
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
      const inDomain = facts
        .filter((f) => (f.domain ?? 'other') === domain)
        .slice(0, CARD_FACTS_PER_DOMAIN);
      if (inDomain.length === 0) continue;
      lines.push(`${domain[0]?.toUpperCase()}${domain.slice(1)}:`);
      for (const f of inDomain) {
        const span = f.validFrom
          ? ` (${f.validFrom.toISOString().slice(0, 10)}–${f.validUntil ? f.validUntil.toISOString().slice(0, 10) : 'now'})`
          : '';
        const hedge = Number(f.confidence) < 0.5 ? ' (unconfirmed)' : '';
        lines.push(`- ${f.content}${span}${hedge}`);
      }
    }
  }

  const people = await db
    .select({
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
    .orderBy(sql`count(${memories.id}) desc`)
    .limit(CARD_PEOPLE_LIMIT);

  if (people.length > 0) {
    lines.push('People:');
    for (const p of people) {
      lines.push(
        `- ${p.name}${p.relationship ? ` (${p.relationship})` : ''} — ${p.n} known fact(s)`,
      );
    }
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
