import type { ProfileOverviewRepository } from '@assistant/persistence';
import { describe, expect, it } from 'vitest';
import { getProfileOverview } from './queries.js';

describe('getProfileOverview', () => {
  it('uses a portable read and selects compiled-card fact IDs', async () => {
    const now = new Date('2026-09-22T12:00:00Z');
    const fact = (id: string, pinned: boolean, importance: number) => ({
      id,
      content: id,
      kind: 'fact',
      domain: 'work',
      confidence: '1.00',
      importance,
      ownerConfirmed: false,
      pinned,
      lastConsolidatedAt: null,
      originTrust: 'owner',
      sourceTaskId: null,
      createdAt: now,
      validFrom: null,
      validUntil: null,
    });
    const repository: ProfileOverviewRepository = {
      kind: 'profile-overview-repository',
      async load() {
        return {
          people: [],
          ownerFacts: [fact('pinned', true, 1), fact('important', false, 5)],
          quarantined: [],
          card: null,
          voiceStats: { total: 0, auto: 0, uploaded: 0 },
          voiceProfile: { description: '', dos: [], donts: [], signature: '' },
          voiceImports: [],
          memoryHealth: {
            totalUsable: 2,
            notYetOrganized: 2,
            awaitingReview: 0,
            ownerConfirmed: 0,
            lastOrganizedAt: null,
          },
          latestOrganizer: null,
        };
      },
    };
    const result = await getProfileOverview(repository);
    expect(result.cardFactIds).toEqual(['pinned', 'important']);
    expect(result.ownerFacts).toHaveLength(2);
  });
});
