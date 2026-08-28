import { getAgent } from '@assistant/core/chat';
import {
  contacts,
  type Db,
  importSources,
  knowledgeGraphEntities,
  knowledgeGraphEntityAliases,
  knowledgeGraphRelations,
  memories,
  memoryTombstones,
  ownerCard,
  tasks,
  voiceProfile,
  writingSamples,
} from '@assistant/db';
import { and, eq, inArray, like, sql } from 'drizzle-orm';

export interface PrivacyWorkspace {
  delete(relativePath: string): Promise<void>;
}

/**
 * A deliberately narrow, portable view of the profile data that powers recall.
 * It excludes embeddings, encrypted credentials, and operational records: they
 * are either implementation details, secrets, or belong to a different export
 * surface. The content an owner needs to inspect or retain is included.
 */
export async function exportLongTermMemoryData(db: Db) {
  const agent = await getAgent(db);
  const [memoryRows, entities, aliases, relations, people, samples, profile, card] =
    await Promise.all([
      db
        .select({
          id: memories.id,
          category: memories.category,
          kind: memories.kind,
          content: memories.content,
          importance: memories.importance,
          confidence: memories.confidence,
          originTrust: memories.originTrust,
          quarantined: memories.quarantined,
          domain: memories.domain,
          ownerConfirmed: memories.ownerConfirmed,
          pinned: memories.pinned,
          source: memories.source,
          createdAt: memories.createdAt,
          expiresAt: memories.expiresAt,
        })
        .from(memories)
        .where(eq(memories.agentId, agent.id)),
      db
        .select({
          id: knowledgeGraphEntities.id,
          canonicalKey: knowledgeGraphEntities.canonicalKey,
          label: knowledgeGraphEntities.label,
          preferredLabel: knowledgeGraphEntities.preferredLabel,
          kind: knowledgeGraphEntities.kind,
          contactId: knowledgeGraphEntities.contactId,
          createdAt: knowledgeGraphEntities.createdAt,
          updatedAt: knowledgeGraphEntities.updatedAt,
        })
        .from(knowledgeGraphEntities)
        .where(eq(knowledgeGraphEntities.agentId, agent.id)),
      db
        .select({
          canonicalKey: knowledgeGraphEntityAliases.canonicalKey,
          entityId: knowledgeGraphEntityAliases.entityId,
          createdAt: knowledgeGraphEntityAliases.createdAt,
        })
        .from(knowledgeGraphEntityAliases)
        .where(eq(knowledgeGraphEntityAliases.agentId, agent.id)),
      db
        .select({
          id: knowledgeGraphRelations.id,
          subjectEntityId: knowledgeGraphRelations.subjectEntityId,
          predicate: knowledgeGraphRelations.predicate,
          objectEntityId: knowledgeGraphRelations.objectEntityId,
          sourceMemoryId: knowledgeGraphRelations.sourceMemoryId,
          evidenceQuote: knowledgeGraphRelations.evidenceQuote,
          confidence: knowledgeGraphRelations.confidence,
          validFrom: knowledgeGraphRelations.validFrom,
          validUntil: knowledgeGraphRelations.validUntil,
          reviewStatus: knowledgeGraphRelations.reviewStatus,
          createdAt: knowledgeGraphRelations.createdAt,
        })
        .from(knowledgeGraphRelations)
        .where(eq(knowledgeGraphRelations.agentId, agent.id)),
      db
        .select({
          id: contacts.id,
          name: contacts.name,
          aliases: contacts.aliases,
          emails: contacts.emails,
          phones: contacts.phones,
          relationship: contacts.relationship,
          trust: contacts.trust,
          notes: contacts.notes,
          createdAt: contacts.createdAt,
          updatedAt: contacts.updatedAt,
        })
        .from(contacts),
      db
        .select({
          id: writingSamples.id,
          register: writingSamples.register,
          text: writingSamples.text,
          context: writingSamples.context,
          createdAt: writingSamples.createdAt,
        })
        .from(writingSamples),
      db
        .select({
          description: voiceProfile.description,
          dos: voiceProfile.dos,
          donts: voiceProfile.donts,
          signature: voiceProfile.signature,
          updatedAt: voiceProfile.updatedAt,
        })
        .from(voiceProfile)
        .where(eq(voiceProfile.id, 1))
        .limit(1),
      db.select().from(ownerCard).where(eq(ownerCard.id, 1)).limit(1),
    ]);

  return {
    format: 'assistant-long-term-memory-export/v1',
    exportedAt: new Date().toISOString(),
    scope: [
      'saved facts',
      'knowledge graph projections',
      'people profiles',
      'writing samples and voice profile',
      'compiled recall card',
    ],
    memories: memoryRows,
    knowledgeGraph: { entities, aliases, relations },
    people,
    writingVoice: { samples, profile: profile[0] ?? null },
    compiledOwnerCard: card[0] ?? null,
  };
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
