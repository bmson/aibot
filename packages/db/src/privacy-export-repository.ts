import type { LongTermMemoryExportData, PrivacyExportRepository } from '@assistant/persistence';
import { eq } from 'drizzle-orm';
import type { Db } from './client.js';
import {
  agents,
  contacts,
  knowledgeGraphEntities,
  knowledgeGraphEntityAliases,
  knowledgeGraphRelations,
  memories,
  memoryTombstones,
  ownerCard,
  situationPacks,
  voiceProfile,
  writingSamples,
} from './schema.js';

export function createPostgresPrivacyExportRepository(db: Db): PrivacyExportRepository {
  return {
    kind: 'privacy-export-repository',
    async exportOwnerData(): Promise<LongTermMemoryExportData> {
      const configured = await db.select({ id: agents.id }).from(agents).limit(2);
      if (configured.length !== 1 || !configured[0])
        throw new Error('Privacy export requires exactly one configured agent');
      const agentId = configured[0].id;
      const [
        memoryRows,
        tombstones,
        entities,
        aliases,
        relations,
        people,
        samples,
        profile,
        card,
        packs,
      ] = await Promise.all([
        db
          .select({
            id: memories.id,
            contentHash: memories.contentHash,
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
          .where(eq(memories.agentId, agentId)),
        db.select({ contentHash: memoryTombstones.contentHash }).from(memoryTombstones),
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
          .where(eq(knowledgeGraphEntities.agentId, agentId)),
        db
          .select({
            canonicalKey: knowledgeGraphEntityAliases.canonicalKey,
            entityId: knowledgeGraphEntityAliases.entityId,
            createdAt: knowledgeGraphEntityAliases.createdAt,
          })
          .from(knowledgeGraphEntityAliases)
          .where(eq(knowledgeGraphEntityAliases.agentId, agentId)),
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
          .where(eq(knowledgeGraphRelations.agentId, agentId)),
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
        db.select().from(situationPacks).where(eq(situationPacks.agentId, agentId)),
      ]);
      const tombstonedHashes = new Set(tombstones.map((row) => row.contentHash));
      const activeRows = memoryRows.filter((row) => !tombstonedHashes.has(row.contentHash));
      const activeMemoryIds = new Set(activeRows.map((row) => row.id));
      return {
        memories: activeRows.map(({ contentHash: _contentHash, ...row }) => row),
        knowledgeGraph: {
          entities,
          aliases,
          relations: relations.filter((row) => activeMemoryIds.has(row.sourceMemoryId)),
        },
        people,
        writingVoice: { samples, profile: profile[0] ?? null },
        compiledOwnerCard: card[0] ?? null,
        situationPacks: packs,
      };
    },
  };
}
