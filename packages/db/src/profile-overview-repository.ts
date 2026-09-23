import type { ProfileVoiceOverviewRepository } from '@assistant/persistence';
import { and, desc, eq, like, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { agents, importSources, voiceProfile, writingSamples } from './schema.js';

const VOICE_IMPORT_LIMIT = 5;

/** Legacy Db-compatible voice read, with agent-scoped imports. */
export function createPostgresProfileVoiceOverviewRepository(
  db: Db,
): ProfileVoiceOverviewRepository {
  return {
    kind: 'profile-voice-overview-repository',
    async load() {
      const configured = await db.select({ id: agents.id }).from(agents).limit(2);
      if (configured.length !== 1 || !configured[0])
        throw new Error('Voice overview requires exactly one configured agent');
      const agentId = configured[0].id;
      const [sampleRows, imports, [voice]] = await Promise.all([
        db
          .select({
            total: sql<number>`count(*)`,
            auto: sql<number>`count(*) filter (where ${writingSamples.context} like 'auto:%')`,
            uploaded: sql<number>`count(*) filter (where ${writingSamples.context} like 'upload:%')`,
          })
          .from(writingSamples),
        db
          .select()
          .from(importSources)
          .where(
            and(eq(importSources.agentId, agentId), like(importSources.source, 'voice-samples%')),
          )
          .orderBy(desc(importSources.updatedAt), desc(importSources.id))
          .limit(VOICE_IMPORT_LIMIT),
        db.select().from(voiceProfile).where(eq(voiceProfile.id, 1)).limit(1),
      ]);
      const sample = sampleRows[0];
      return {
        voiceStats: {
          total: Number(sample?.total ?? 0),
          auto: Number(sample?.auto ?? 0),
          uploaded: Number(sample?.uploaded ?? 0),
        },
        voiceProfile: {
          description: voice?.description ?? '',
          dos: Array.isArray(voice?.dos)
            ? voice.dos.filter((value): value is string => typeof value === 'string')
            : [],
          donts: Array.isArray(voice?.donts)
            ? voice.donts.filter((value): value is string => typeof value === 'string')
            : [],
          signature: voice?.signature ?? '',
        },
        voiceImports: imports.map((row) => ({
          source: row.source,
          status: row.status,
          itemsTotal: row.itemsTotal,
          itemsProcessed: row.itemsProcessed,
          memoriesSaved: row.memoriesSaved,
          taskId: row.taskId,
          error: row.error,
        })),
      };
    },
  };
}
