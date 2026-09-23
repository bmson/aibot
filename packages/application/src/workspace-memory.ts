import type { ProfileOverview } from './profile.js';

type MobileMemoryFact = Pick<
  ProfileOverview['ownerFacts'][number],
  'id' | 'content' | 'kind' | 'domain' | 'ownerConfirmed' | 'pinned' | 'importance'
> & { createdAt: string };

/** The JSON shape of the existing mobile workspace `memory` section. */
export interface MobileWorkspaceMemory {
  ownerName: string | null;
  ownerContactId: string | null;
  health: Omit<ProfileOverview['memoryHealth'], 'lastOrganizedAt'> & {
    lastOrganizedAt: string | null;
  };
  facts: MobileMemoryFact[];
  awaitingReview: MobileMemoryFact[];
  peopleCount: number;
  people: Array<ProfileOverview['people'][number]['contact'] & { factCount: number }>;
  card: { content: string; compiledAt: string } | null;
  voiceStats: ProfileOverview['voiceStats'];
  latestOrganizer: { id: string; status: string; progress: string; updatedAt: string } | null;
}

function mobileMemoryFact(fact: ProfileOverview['ownerFacts'][number]): MobileMemoryFact {
  return {
    id: fact.id,
    content: fact.content,
    kind: fact.kind,
    domain: fact.domain,
    ownerConfirmed: fact.ownerConfirmed,
    pinned: fact.pinned,
    importance: fact.importance,
    createdAt: fact.createdAt.toISOString(),
  };
}

/** Preserve the PostgreSQL workspace contract for either profile read adapter. */
export function projectMobileWorkspaceMemory(profile: ProfileOverview): MobileWorkspaceMemory {
  return {
    ownerName: profile.owner?.name ?? null,
    ownerContactId: profile.owner?.id ?? null,
    health: {
      totalUsable: profile.memoryHealth.totalUsable,
      notYetOrganized: profile.memoryHealth.notYetOrganized,
      awaitingReview: profile.memoryHealth.awaitingReview,
      ownerConfirmed: profile.memoryHealth.ownerConfirmed,
      lastOrganizedAt: profile.memoryHealth.lastOrganizedAt?.toISOString() ?? null,
    },
    facts: profile.ownerFacts.slice(0, 80).map(mobileMemoryFact),
    awaitingReview: profile.quarantined.slice(0, 40).map(mobileMemoryFact),
    peopleCount: profile.people.length,
    people: profile.people.map(({ contact, factCount }) => ({
      id: contact.id,
      name: contact.name,
      aliases: contact.aliases,
      relationship: contact.relationship,
      trust: contact.trust,
      factCount,
    })),
    card: profile.card
      ? { content: profile.card.content, compiledAt: profile.card.compiledAt.toISOString() }
      : null,
    voiceStats: {
      total: profile.voiceStats.total,
      auto: profile.voiceStats.auto,
      uploaded: profile.voiceStats.uploaded,
    },
    latestOrganizer: profile.latestOrganizer
      ? {
          id: profile.latestOrganizer.id,
          status: profile.latestOrganizer.status,
          progress: profile.latestOrganizer.progress,
          updatedAt: profile.latestOrganizer.updatedAt.toISOString(),
        }
      : null,
  };
}
