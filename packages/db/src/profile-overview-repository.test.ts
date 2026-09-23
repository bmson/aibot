import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDb } from './client.js';
import { createPostgresProfileVoiceOverviewRepository } from './profile-overview-repository.js';
import { agents, importSources, writingSamples } from './schema.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:55432/assistant_test';

describe('PostgreSQL profile voice overview', () => {
  it('preserves counts, ordered import state, and the existing singleton profile', async () => {
    const db = createDb(DATABASE_URL);
    const sampleId = randomUUID();
    const sourceId = randomUUID();
    try {
      const configured = await db.select({ id: agents.id }).from(agents).limit(2);
      if (configured.length !== 1 || !configured[0]) throw new Error('Test requires one agent');
      const before = await createPostgresProfileVoiceOverviewRepository(db).load();
      await db.insert(writingSamples).values({
        id: sampleId,
        register: 'email_casual',
        text: 'One sample',
        context: 'upload:test',
      });
      await db.insert(importSources).values({
        id: sourceId,
        agentId: configured[0].id,
        source: `voice-samples-${sourceId}`,
        workspacePath: 'import/test',
        kind: 'text',
        status: 'done',
        itemsTotal: 3,
        itemsProcessed: 2,
        memoriesSaved: 1,
      });
      const after = await createPostgresProfileVoiceOverviewRepository(db).load();
      expect(after.voiceStats).toEqual({
        total: before.voiceStats.total + 1,
        auto: before.voiceStats.auto,
        uploaded: before.voiceStats.uploaded + 1,
      });
      expect(after.voiceProfile).toEqual(before.voiceProfile);
      expect(after.voiceImports[0]).toMatchObject({
        source: `voice-samples-${sourceId}`,
        itemsTotal: 3,
        itemsProcessed: 2,
        memoriesSaved: 1,
      });
    } finally {
      await db.delete(importSources).where(eq(importSources.id, sourceId));
      await db.delete(writingSamples).where(eq(writingSamples.id, sampleId));
      await db.$client.end();
    }
  });
});
