import { getAgent } from '@assistant/core/chat';
import type { LongTermMemoryExportData, PrivacyExportRepository } from '@assistant/persistence';
import { eq } from 'drizzle-orm';
import type { Db } from './client.js';
import {
  contacts,
  knowledgeGraphEntities,
  knowledgeGraphEntityAliases,
  knowledgeGraphRelations,
  memories,
  ownerCard,
  situationPacks,
  voiceProfile,
  writingSamples,
} from './schema.js';

export function createPostgresPrivacyExportRepository(db: Db): PrivacyExportRepository {
  return {
    kind: 'privacy-export-repository',
    async exportOwnerData(): Promise<LongTermMemoryExportData> {
      const agent = await getAgent(db);
      const [memoryRows, entities, aliases, relations, people, samples, profile, card, packs] =
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
          db.select().from(situationPacks).where(eq(situationPacks.agentId, agent.id)),
        ]);
      return {
        memories: memoryRows,
        knowledgeGraph: { entities, aliases, relations },
        people,
        writingVoice: { samples, profile: profile[0] ?? null },
        compiledOwnerCard: card[0] ?? null,
        situationPacks: packs,
      };
    },
  };
}
