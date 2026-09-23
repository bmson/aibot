import type { ProfileMemoryHubRepository } from '@assistant/persistence';
import { and, count, desc, eq, gt, gte, isNull, ne, or, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { agents, contacts, memories, ownerCard, recallFeedback, tasks } from './schema.js';

const QUARANTINE_LIMIT = 100;
const RECALL_FEEDBACK_WINDOW_DAYS = 90;

export function createPostgresProfileMemoryHubRepository(db: Db): ProfileMemoryHubRepository {
  return {
    kind: 'profile-memory-hub-repository',
    async load() {
      const configured = await db.select({ id: agents.id }).from(agents).limit(2);
      if (configured.length !== 1 || !configured[0])
        throw new Error('Memory hub requires exactly one configured agent');
      const agentId = configured[0].id;
      const [owner] = await db.select().from(contacts).where(eq(contacts.trust, 'owner')).limit(1);
      const unexpired = sql`(${memories.expiresAt} IS NULL OR ${memories.expiresAt} > now())`;
      const usable = sql`${unexpired} AND ${memories.quarantined} = false`;
      const active = and(
        eq(memories.agentId, agentId),
        eq(memories.category, 'knowledge'),
        eq(memories.quarantined, false),
        or(isNull(memories.expiresAt), gt(memories.expiresAt, sql`now()`)),
      );
      const feedbackSince = new Date(Date.now() - RECALL_FEEDBACK_WINDOW_DAYS * 86_400_000);
      const [quarantined, [card], [health], [feedback], organizerRows, [ownerFacts], [people]] =
        await Promise.all([
          db
            .select()
            .from(memories)
            .where(
              and(
                eq(memories.agentId, agentId),
                eq(memories.category, 'knowledge'),
                eq(memories.quarantined, true),
                or(isNull(memories.expiresAt), gt(memories.expiresAt, sql`now()`)),
              ),
            )
            .orderBy(desc(memories.createdAt))
            .limit(QUARANTINE_LIMIT),
          db.select().from(ownerCard).where(eq(ownerCard.id, 1)).limit(1),
          db
            .select({
              totalUsable: sql<number>`count(*) FILTER (WHERE ${usable})`,
              notYetOrganized: sql<number>`count(*) FILTER (WHERE ${usable} AND ${memories.lastConsolidatedAt} IS NULL)`,
              awaitingReview: sql<number>`count(*) FILTER (WHERE ${unexpired} AND ${memories.quarantined} = true)`,
              ownerConfirmed: sql<number>`count(*) FILTER (WHERE ${usable} AND ${memories.ownerConfirmed} = true)`,
              lastOrganizedAt: sql<Date | null>`max(${memories.lastConsolidatedAt}) FILTER (WHERE ${usable})`,
            })
            .from(memories)
            .where(and(eq(memories.agentId, agentId), eq(memories.category, 'knowledge'))),
          db
            .select({
              rated: sql<number>`count(*)`,
              helpful: sql<number>`count(*) FILTER (WHERE ${recallFeedback.verdict} = 'helpful')`,
              notHelpful: sql<number>`count(*) FILTER (WHERE ${recallFeedback.verdict} = 'not_helpful')`,
              lastRatedAt: sql<Date | null>`max(${recallFeedback.createdAt})`,
            })
            .from(recallFeedback)
            .where(
              and(
                eq(recallFeedback.agentId, agentId),
                gte(recallFeedback.createdAt, feedbackSince),
              ),
            ),
          db
            .select({
              id: tasks.id,
              status: tasks.status,
              progress: tasks.progress,
              updatedAt: tasks.updatedAt,
            })
            .from(tasks)
            .where(
              and(
                eq(tasks.agentId, agentId),
                sql`${tasks.trigger} #>> '{payload,job}' = 'memory.consolidate'`,
              ),
            )
            .orderBy(desc(tasks.createdAt))
            .limit(1),
          owner
            ? db
                .select({ value: count() })
                .from(memories)
                .where(and(active, eq(memories.subjectContactId, owner.id)))
            : Promise.resolve([{ value: 0 }]),
          db.select({ value: count() }).from(contacts).where(ne(contacts.trust, 'owner')),
        ]);
      return {
        ...(owner ? { owner } : {}),
        quarantined,
        memoryHealth: {
          totalUsable: Number(health?.totalUsable ?? 0),
          notYetOrganized: Number(health?.notYetOrganized ?? 0),
          awaitingReview: Number(health?.awaitingReview ?? 0),
          ownerConfirmed: Number(health?.ownerConfirmed ?? 0),
          lastOrganizedAt: health?.lastOrganizedAt ? new Date(health.lastOrganizedAt) : null,
        },
        recallFeedback: {
          rated: Number(feedback?.rated ?? 0),
          helpful: Number(feedback?.helpful ?? 0),
          notHelpful: Number(feedback?.notHelpful ?? 0),
          lastRatedAt: feedback?.lastRatedAt ? new Date(feedback.lastRatedAt) : null,
          windowDays: RECALL_FEEDBACK_WINDOW_DAYS,
        },
        latestOrganizer: organizerRows[0] ?? null,
        card: card ? { compiledAt: card.compiledAt, empty: card.content.trim() === '' } : null,
        ownerFactCount: Number(ownerFacts?.value ?? 0),
        peopleCount: Number(people?.value ?? 0),
      };
    },
  };
}
