import type { ProfileOverviewRepository } from '@assistant/persistence';
import { assertPrivacyErasureFenceUnchanged } from './privacy-erasure.js';
import { loadProfileHubSource, profileMemoryHubFromSource } from './profile-memory-hub.js';
import { FirestoreProfileVoiceOverviewRepository } from './profile-overview.js';
import type { InstallationStore } from './store.js';

const PROFILE_CONTACT_LIMIT = 500;
const PROFILE_FACT_LIMIT = 250;

/** Complete mobile Profile read for the configured installation owner. */
export class FirestoreProfileOverviewRepository implements ProfileOverviewRepository {
  readonly kind = 'profile-overview-repository' as const;

  constructor(
    readonly store: InstallationStore,
    readonly configuredAgentId?: string,
  ) {}

  async load() {
    // Keep the source fence open across the voice read so an erasure between
    // those two complete reads cannot return a mixed pre/post-erasure profile.
    const source = await loadProfileHubSource(this.store, this.configuredAgentId);
    const voice = await new FirestoreProfileVoiceOverviewRepository(
      this.store,
      this.configuredAgentId,
    ).load();
    const hub = profileMemoryHubFromSource(source);
    if (source.contacts.length > PROFILE_CONTACT_LIMIT)
      throw new Error('Profile contact count exceeds the view limit');
    const allContacts = [...source.contacts].sort(
      (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
    );
    const owner = allContacts.find((contact) => contact.trust === 'owner');
    const activeMemories = source.memories.filter(
      (row) =>
        row.category === 'knowledge' &&
        !row.quarantined &&
        (!row.expiresAt || row.expiresAt > source.now),
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
    const result = {
      ...(owner ? { owner } : {}),
      people: allContacts
        .filter((contact) => contact.trust !== 'owner')
        .map((contact) => ({ contact, factCount: factCounts.get(contact.id) ?? 0 })),
      ownerFacts,
      quarantined: hub.quarantined,
      card: source.card,
      voiceStats: voice.voiceStats,
      voiceProfile: voice.voiceProfile,
      voiceImports: voice.voiceImports,
      memoryHealth: hub.memoryHealth,
      latestOrganizer: hub.latestOrganizer,
    };
    await assertPrivacyErasureFenceUnchanged(this.store, source.agentId, source.fence);
    return result;
  }
}
