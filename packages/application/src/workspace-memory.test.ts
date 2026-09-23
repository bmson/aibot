import type { ProfileOverviewRepository } from '@assistant/persistence';
import { describe, expect, it } from 'vitest';
import { getProfileOverview } from './profile.js';
import { projectMobileWorkspaceMemory } from './workspace-memory.js';

describe('mobile workspace memory projection', () => {
  it('keeps the existing fact and review limits with JSON timestamps', async () => {
    const at = new Date('2026-09-22T12:00:00.000Z');
    const fact = (id: string) => ({
      id,
      content: id,
      kind: 'fact',
      domain: null,
      confidence: '0.90',
      importance: 3,
      ownerConfirmed: false,
      pinned: false,
      lastConsolidatedAt: null,
      originTrust: 'owner',
      sourceTaskId: null,
      createdAt: at,
      validFrom: null,
      validUntil: null,
    });
    const repository: ProfileOverviewRepository = {
      kind: 'profile-overview-repository',
      async load() {
        return {
          people: [],
          ownerFacts: Array.from({ length: 81 }, (_, index) => fact(`fact-${index}`)),
          quarantined: Array.from({ length: 41 }, (_, index) => fact(`review-${index}`)),
          card: null,
          voiceStats: { total: 0, auto: 0, uploaded: 0 },
          voiceProfile: { description: '', dos: [], donts: [], signature: '' },
          voiceImports: [],
          memoryHealth: {
            totalUsable: 81,
            notYetOrganized: 81,
            awaitingReview: 41,
            ownerConfirmed: 0,
            lastOrganizedAt: null,
          },
          latestOrganizer: null,
        };
      },
    };

    const result = projectMobileWorkspaceMemory(await getProfileOverview(repository));
    expect(result.facts).toHaveLength(80);
    expect(result.awaitingReview).toHaveLength(40);
    expect(result.facts[79]).toEqual({
      id: 'fact-79',
      content: 'fact-79',
      kind: 'fact',
      domain: null,
      ownerConfirmed: false,
      pinned: false,
      importance: 3,
      createdAt: at.toISOString(),
    });
    expect(result.awaitingReview[39]?.id).toBe('review-39');
  });
});
