import type { LocationPingRepository } from '@assistant/persistence';
import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { locationPings, tasks } from './schema.js';

/** The SQL the ingest route and arrival hook have always issued, behind the port. */
export function createPostgresLocationPingRepository(db: Db): LocationPingRepository {
  return {
    kind: 'location-ping-repository',
    async record(agentId, ping) {
      await db.insert(locationPings).values({
        agentId,
        lat: String(ping.lat),
        lng: String(ping.lng),
        label: ping.label,
        accuracyM: ping.accuracyM,
        source: ping.source,
        timeZone: ping.timeZone,
        capturedAt: ping.capturedAt,
      });
    },
    async recent(agentId, { from, before }) {
      const rows = await db
        .select({
          lat: locationPings.lat,
          lng: locationPings.lng,
          accuracyM: locationPings.accuracyM,
          capturedAt: locationPings.capturedAt,
        })
        .from(locationPings)
        .where(
          and(
            eq(locationPings.agentId, agentId),
            gte(locationPings.capturedAt, from),
            lt(locationPings.capturedAt, before),
          ),
        )
        .orderBy(desc(locationPings.capturedAt));
      return rows.map((row) => ({ ...row, lat: Number(row.lat), lng: Number(row.lng) }));
    },
    async hasArrivalTaskSince(agentId, since) {
      const [row] = await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(
          and(
            eq(tasks.agentId, agentId),
            sql`${tasks.externalEventId} like 'arrival:%'`,
            gte(tasks.createdAt, since),
          ),
        )
        .limit(1);
      return Boolean(row);
    },
  };
}
