import type { OwnerContextRepository } from '@assistant/persistence';
import { and, desc, eq, gte, lt, lte, or } from 'drizzle-orm';
import type { Db } from './client.js';
import { agents, ambientSnapshots, commitments, locationPings, ownerCard } from './schema.js';

function boundedCommitmentLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 60) {
    throw new Error('Owner context commitment limit must be between 1 and 60');
  }
  return limit;
}

export function createPostgresOwnerContextRepository(db: Db): OwnerContextRepository {
  return {
    kind: 'owner-context-repository',

    async getOwnerCard(agentId) {
      // `owner_card` predates agent scoping. It is safe only for the sole agent in
      // this installation; a multi-agent database cannot attribute the singleton.
      const configuredAgents = await db.select({ id: agents.id }).from(agents).limit(2);
      if (configuredAgents.length !== 1 || configuredAgents[0]?.id !== agentId) return null;
      const [row] = await db
        .select({ content: ownerCard.content, compiledAt: ownerCard.compiledAt })
        .from(ownerCard)
        .where(eq(ownerCard.id, 1))
        .limit(1);
      return row ?? null;
    },

    async getAmbientSnapshot(agentId) {
      const [row] = await db
        .select({
          agentId: ambientSnapshots.agentId,
          block: ambientSnapshots.block,
          flags: ambientSnapshots.flags,
          sources: ambientSnapshots.sources,
          computedAt: ambientSnapshots.computedAt,
        })
        .from(ambientSnapshots)
        .where(eq(ambientSnapshots.agentId, agentId))
        .limit(1);
      return row ?? null;
    },

    async getLatestLocation({ agentId, notBefore, notAfter, source }) {
      const [row] = await db
        .select()
        .from(locationPings)
        .where(
          and(
            eq(locationPings.agentId, agentId),
            gte(locationPings.capturedAt, notBefore),
            lte(locationPings.capturedAt, notAfter),
            source ? eq(locationPings.source, source) : undefined,
          ),
        )
        .orderBy(desc(locationPings.capturedAt))
        .limit(1);
      return row ?? null;
    },

    async listOpenCommitments({ agentId, now, limit }) {
      return db
        .select()
        .from(commitments)
        .where(
          and(
            eq(commitments.agentId, agentId),
            or(
              eq(commitments.status, 'open'),
              and(eq(commitments.status, 'snoozed'), lt(commitments.snoozedUntil, now)),
            ),
          ),
        )
        .orderBy(desc(commitments.updatedAt))
        .limit(boundedCommitmentLimit(limit));
    },
  };
}
