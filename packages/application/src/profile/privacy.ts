import { getAgent } from '@assistant/core/chat';
import {
  createPostgresPrivacyExportRepository,
  type Db,
  importSources,
  knowledgeGraphEntities,
  knowledgeGraphEntityAliases,
  knowledgeGraphRelations,
  memories,
  memoryTombstones,
  ownerCard,
  situationPacks,
  situationPreviews,
  tasks,
  voiceProfile,
  writingSamples,
} from '@assistant/db';
import type { PrivacyExportRepository } from '@assistant/persistence';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { createLongTermMemoryExporter } from './privacy-export.js';

export interface PrivacyWorkspace {
  delete(relativePath: string): Promise<void>;
}

/**
 * A deliberately narrow, portable view of the profile data that powers recall.
 * It excludes embeddings, encrypted credentials, and operational records: they
 * are either implementation details, secrets, or belong to a different export
 * surface. The content an owner needs to inspect or retain is included.
 */
export function exportLongTermMemoryData(store: Db | PrivacyExportRepository) {
  const repository =
    'kind' in store && store.kind === 'privacy-export-repository'
      ? (store as PrivacyExportRepository)
      : createPostgresPrivacyExportRepository(store as Db);
  return createLongTermMemoryExporter(repository)();
}

/**
 * Owner-requested erasure for everything that is automatically recalled or
 * used to mimic their voice. Tombstones intentionally remain so an ingestion
 * job cannot silently recreate a fact the owner chose to remove.
 */
export async function forgetLongTermMemory(
  db: Db,
  workspace?: PrivacyWorkspace,
): Promise<{ memories: number; graphRelations: number; writingSamples: number }> {
  const agent = await getAgent(db);
  const [memoryRows, relationRows, sampleRows, voiceImports] = await Promise.all([
    db
      .select({ id: memories.id, contentHash: memories.contentHash })
      .from(memories)
      .where(eq(memories.agentId, agent.id)),
    db
      .select({ id: knowledgeGraphRelations.id })
      .from(knowledgeGraphRelations)
      .where(eq(knowledgeGraphRelations.agentId, agent.id)),
    db.select({ id: writingSamples.id }).from(writingSamples),
    db
      .select({
        id: importSources.id,
        workspacePath: importSources.workspacePath,
        taskId: importSources.taskId,
      })
      .from(importSources)
      .where(
        and(eq(importSources.agentId, agent.id), like(importSources.source, 'voice-samples%')),
      ),
  ]);

  await db.transaction(async (tx) => {
    // Preserve explicit plans, but erase their recall-bearing decisions and
    // invalidate previews so an old preview cannot restore a forgotten reason.
    const packs = await tx
      .select({ id: situationPacks.id })
      .from(situationPacks)
      .where(eq(situationPacks.agentId, agent.id))
      .for('update');
    if (packs.length)
      await tx.delete(situationPreviews).where(
        inArray(
          situationPreviews.packId,
          packs.map((pack) => pack.id),
        ),
      );
    await tx
      .update(situationPacks)
      .set({
        data: sql`jsonb_set(${situationPacks.data}, '{decisions}', '[]'::jsonb)`,
        version: sql`${situationPacks.version} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(situationPacks.agentId, agent.id));
    if (memoryRows.length > 0) {
      await tx
        .insert(memoryTombstones)
        .values(memoryRows.map((row) => ({ contentHash: row.contentHash, reason: 'owner_forget' })))
        .onConflictDoNothing({ target: memoryTombstones.contentHash });
    }
    const activeVoiceTaskIds = voiceImports
      .map((row) => row.taskId)
      .filter((id): id is string => !!id);
    if (activeVoiceTaskIds.length > 0) {
      await tx
        .update(tasks)
        .set({ status: 'cancelled', lockedUntil: null, runAfter: null, updatedAt: sql`now()` })
        .where(
          and(
            inArray(tasks.id, activeVoiceTaskIds),
            inArray(tasks.status, ['pending', 'sleeping', 'running', 'needs_attention']),
          ),
        );
    }
    if (voiceImports.length > 0) {
      await tx.delete(importSources).where(
        inArray(
          importSources.id,
          voiceImports.map((row) => row.id),
        ),
      );
    }
    // Remove explicit relations before their source memories; this works with
    // both old installations (without cascade constraints) and current ones.
    await tx.delete(knowledgeGraphRelations).where(eq(knowledgeGraphRelations.agentId, agent.id));
    await tx
      .delete(knowledgeGraphEntityAliases)
      .where(eq(knowledgeGraphEntityAliases.agentId, agent.id));
    await tx.delete(knowledgeGraphEntities).where(eq(knowledgeGraphEntities.agentId, agent.id));
    await tx.delete(memories).where(eq(memories.agentId, agent.id));
    await tx.delete(writingSamples);
    await tx
      .insert(ownerCard)
      .values({ id: 1, content: '', compiledAt: new Date() })
      .onConflictDoUpdate({
        target: ownerCard.id,
        set: { content: '', compiledAt: new Date() },
      });
    await tx
      .insert(voiceProfile)
      .values({ id: 1, description: '', dos: [], donts: [], signature: '', updatedAt: new Date() })
      .onConflictDoUpdate({
        target: voiceProfile.id,
        set: { description: '', dos: [], donts: [], signature: '', updatedAt: new Date() },
      });
  });

  if (workspace) {
    for (const source of voiceImports) {
      await workspace.delete(source.workspacePath).catch((error) => {
        console.error(
          `long-term-memory erasure: workspace delete failed for ${source.workspacePath}`,
          error,
        );
      });
    }
  }

  return {
    memories: memoryRows.length,
    graphRelations: relationRows.length,
    writingSamples: sampleRows.length,
  };
}
