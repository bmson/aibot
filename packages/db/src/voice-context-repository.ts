import type { VoiceContextRepository } from '@assistant/persistence';
import { eq, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { voiceProfile, writingSamples } from './schema.js';

/** The singleton voice profile and pgvector sample search, as outbound rewrites always read them. */
export function createPostgresVoiceContextRepository(db: Db): VoiceContextRepository {
  return {
    kind: 'voice-context-repository',
    async profile() {
      const [profile] = await db.select().from(voiceProfile).where(eq(voiceProfile.id, 1));
      if (!profile) return null;
      return {
        description: profile.description,
        dos: (profile.dos ?? []) as string[],
        donts: (profile.donts ?? []) as string[],
        signature: profile.signature,
      };
    },
    async hasSamples(register) {
      const [count] = await db
        .select({ n: sql<number>`count(*)` })
        .from(writingSamples)
        .where(eq(writingSamples.register, register));
      return Number(count?.n ?? 0) > 0;
    },
    async nearestSamples(register, embedding, limit) {
      const rows = await db
        .select({ text: writingSamples.text })
        .from(writingSamples)
        .where(eq(writingSamples.register, register))
        .orderBy(sql`${writingSamples.embedding} <=> ${JSON.stringify(embedding)}::vector`)
        .limit(limit);
      return rows.map((row) => row.text);
    },
    async hasSampleText(text) {
      const [duplicate] = await db
        .select({ id: writingSamples.id })
        .from(writingSamples)
        .where(eq(writingSamples.text, text))
        .limit(1);
      return Boolean(duplicate);
    },
    async countSamplesWithContextPrefix(prefix) {
      const [count] = await db
        .select({ n: sql<number>`count(*)` })
        .from(writingSamples)
        .where(sql`${writingSamples.context} LIKE ${`${prefix}%`}`);
      return Number(count?.n ?? 0);
    },
    async addSample(input) {
      await db.insert(writingSamples).values(input);
    },
  };
}
