import type { ProfileOverviewRepository } from '@assistant/persistence';
import { and, asc, count, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { createPostgresProfileMemoryHubRepository } from './profile-memory-hub-repository.js';
import { createPostgresProfileVoiceOverviewRepository } from './profile-overview-repository.js';
import { agents, contacts, memories, ownerCard } from './schema.js';

const PROFILE_CONTACT_LIMIT = 500;
const PROFILE_FACT_LIMIT = 250;

/** Complete mobile Profile read. Limits fail visibly before rows can disappear. */
export function createPostgresProfileOverviewRepository(db: Db): ProfileOverviewRepository {
  return {
    kind: 'profile-overview-repository',
    async load() {
      const [hub, voice, configured, allContacts, [card]] = await Promise.all([
        createPostgresProfileMemoryHubRepository(db).load(),
        createPostgresProfileVoiceOverviewRepository(db).load(),
        db.select({ id: agents.id }).from(agents).limit(2),
        db
          .select()
          .from(contacts)
          .orderBy(asc(contacts.name), asc(contacts.id))
          .limit(PROFILE_CONTACT_LIMIT + 1),
        db.select().from(ownerCard).where(eq(ownerCard.id, 1)).limit(1),
      ]);
      if (configured.length !== 1 || !configured[0])
        throw new Error('Profile overview requires exactly one configured agent');
      if (allContacts.length > PROFILE_CONTACT_LIMIT)
        throw new Error('Profile contact count exceeds the view limit');
      const agentId = configured[0].id;
      const owner = allContacts.find((contact) => contact.trust === 'owner');
      const active = and(
        eq(memories.agentId, agentId),
        eq(memories.category, 'knowledge'),
        eq(memories.quarantined, false),
        or(isNull(memories.expiresAt), gt(memories.expiresAt, sql`now()`)),
      );
      const contactIds = allContacts.map((contact) => contact.id);
      const [ownerFacts, factCountRows] = await Promise.all([
        owner
          ? db
              .select()
              .from(memories)
              .where(and(active, eq(memories.subjectContactId, owner.id)))
              .orderBy(desc(memories.pinned), desc(memories.importance), desc(memories.confidence))
              .limit(PROFILE_FACT_LIMIT + 1)
          : Promise.resolve([]),
        contactIds.length > 0
          ? db
              .select({ contactId: memories.subjectContactId, value: count() })
              .from(memories)
              .where(and(active, inArray(memories.subjectContactId, contactIds)))
              .groupBy(memories.subjectContactId)
          : Promise.resolve([]),
      ]);
      if (ownerFacts.length > PROFILE_FACT_LIMIT)
        throw new Error('Profile owner fact count exceeds the view limit');
      const factCounts = new Map(
        factCountRows.map((row) => [row.contactId ?? '', Number(row.value)]),
      );
      return {
        ...(owner ? { owner } : {}),
        people: allContacts
          .filter((contact) => contact.trust !== 'owner')
          .map((contact) => ({ contact, factCount: factCounts.get(contact.id) ?? 0 })),
        ownerFacts,
        quarantined: hub.quarantined,
        card: card ? { content: card.content, compiledAt: card.compiledAt } : null,
        voiceStats: voice.voiceStats,
        voiceProfile: voice.voiceProfile,
        voiceImports: voice.voiceImports,
        memoryHealth: hub.memoryHealth,
        latestOrganizer: hub.latestOrganizer,
      };
    },
  };
}
