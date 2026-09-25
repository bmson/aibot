import { randomUUID } from 'node:crypto';
import { nudgePolicyContract } from '@assistant/persistence/testing';
import { eq } from 'drizzle-orm';
import { createDb } from './client.js';
import { createPostgresNudgePolicyRepository } from './nudge-policy-repository.js';
import { agents, notificationPrefs, proactivePings } from './schema.js';

function testDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith('_test'))
    throw new Error('Requires isolated _test database');
  return url;
}

nudgePolicyContract('PostgreSQL nudge policy contract', async () => {
  const db = createDb(testDatabaseUrl());
  // A fresh owner per case: the cap counts this owner's ledger, and the seeded
  // owner's rows from other suites must not count against it.
  const agentId = randomUUID();
  await db.insert(agents).values({
    id: agentId,
    name: `nudge-test-${agentId.slice(0, 8)}`,
    email: `${agentId}@nudge-test.invalid`,
    workspacePrefix: `nudge-test/${agentId}`,
  });
  return {
    agentId,
    repository: createPostgresNudgePolicyRepository(db),
    async setPrefs(prefs) {
      await db.delete(notificationPrefs).where(eq(notificationPrefs.agentId, agentId));
      if (prefs)
        await db.insert(notificationPrefs).values({
          agentId,
          quietStartMin: prefs.quietStartMin ?? null,
          quietEndMin: prefs.quietEndMin ?? null,
          ambientDailyCap: prefs.ambientDailyCap ?? null,
        });
    },
    async pings() {
      return db
        .select({
          urgency: proactivePings.urgency,
          channel: proactivePings.channel,
          delivered: proactivePings.delivered,
          reason: proactivePings.reason,
          createdAt: proactivePings.createdAt,
        })
        .from(proactivePings)
        .where(eq(proactivePings.agentId, agentId));
    },
    async dispose() {
      try {
        // Prefs and pings cascade with the owner.
        await db.delete(agents).where(eq(agents.id, agentId));
      } finally {
        await db.$client.end();
      }
    },
  };
});
