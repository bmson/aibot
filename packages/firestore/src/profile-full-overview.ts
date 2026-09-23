import type { ProfileOverviewRepository, Records } from '@assistant/persistence';
import {
  FirestoreProfileMemoryHubRepository,
  ownedProfileRow,
  scanProfileCollection,
} from './profile-memory-hub.js';
import { FirestoreProfileVoiceOverviewRepository } from './profile-overview.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

const PROFILE_CONTACT_LIMIT = 500;
const PROFILE_FACT_LIMIT = 250;

/** Complete mobile Profile read for an installation with one configured agent. */
export class FirestoreProfileOverviewRepository implements ProfileOverviewRepository {
  readonly kind = 'profile-overview-repository' as const;

  constructor(readonly store: InstallationStore) {}

  async load() {
    const [hub, voice, configured] = await Promise.all([
      new FirestoreProfileMemoryHubRepository(this.store).load(),
      new FirestoreProfileVoiceOverviewRepository(this.store).load(),
      this.store.collection('agents').limit(2).get(),
    ]);
    if (configured.size !== 1 || !configured.docs[0])
      throw new Error('Profile overview requires exactly one configured agent');
    const agentDoc = configured.docs[0];
    const agentId = agentDoc.get('id');
    if (typeof agentId !== 'string' || documentKey(agentId) !== agentDoc.id)
      throw new Error('Configured agent record is malformed');

    const [contactDocs, memoryDocs, cardDoc] = await Promise.all([
      scanProfileCollection(this.store.collection('contacts')),
      scanProfileCollection(this.store.collection('memories').where('agentId', '==', agentId)),
      this.store.doc('ownerCards', agentId).get(),
    ]);
    if (contactDocs.length > PROFILE_CONTACT_LIMIT)
      throw new Error('Profile contact count exceeds the view limit');
    const allContacts = contactDocs
      .map((doc) => {
        const row = decodeRecord<Records['contacts']>(doc.data());
        if (!row.id || documentKey(row.id) !== doc.id) throw new Error('Malformed Profile contact');
        return row;
      })
      .sort(
        (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
      );
    const owner = allContacts.find((contact) => contact.trust === 'owner');
    const now = this.store.now();
    const activeMemories = memoryDocs
      .map((doc) => ownedProfileRow<Records['memories']>(doc, agentId))
      .filter(
        (row) =>
          row.category === 'knowledge' &&
          !row.quarantined &&
          (!row.expiresAt || row.expiresAt > now),
      );
    const ownerFacts = owner
      ? activeMemories
          .filter((row) => row.subjectContactId === owner.id)
          .sort(
            (left, right) =>
              Number(right.pinned) - Number(left.pinned) ||
              right.importance - left.importance ||
              Number(right.confidence) - Number(left.confidence),
          )
      : [];
    if (ownerFacts.length > PROFILE_FACT_LIMIT)
      throw new Error('Profile owner fact count exceeds the view limit');
    const factCounts = new Map<string, number>();
    for (const row of activeMemories) {
      if (row.subjectContactId)
        factCounts.set(row.subjectContactId, (factCounts.get(row.subjectContactId) ?? 0) + 1);
    }
    const card = cardDoc.exists
      ? decodeRecord<{ agentId?: unknown; content?: unknown; compiledAt?: unknown }>(cardDoc.data())
      : null;
    if (
      card &&
      (card.agentId !== agentId ||
        typeof card.content !== 'string' ||
        !(card.compiledAt instanceof Date))
    )
      throw new Error('Malformed Profile owner card');

    return {
      ...(owner ? { owner } : {}),
      people: allContacts
        .filter((contact) => contact.trust !== 'owner')
        .map((contact) => ({ contact, factCount: factCounts.get(contact.id) ?? 0 })),
      ownerFacts,
      quarantined: hub.quarantined,
      card: card ? { content: card.content as string, compiledAt: card.compiledAt as Date } : null,
      voiceStats: voice.voiceStats,
      voiceProfile: voice.voiceProfile,
      voiceImports: voice.voiceImports,
      memoryHealth: hub.memoryHealth,
      latestOrganizer: hub.latestOrganizer,
    };
  }
}
