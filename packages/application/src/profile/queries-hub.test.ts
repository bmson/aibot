import type { ProfileMemoryHubRepository } from '@assistant/persistence';
import { describe, expect, it } from 'vitest';
import { getMemoryHubOverview } from './queries.js';

describe('getMemoryHubOverview', () => {
  it('reads through a portable repository', async () => {
    const expected = {
      quarantined: [],
      memoryHealth: {
        totalUsable: 0,
        notYetOrganized: 0,
        awaitingReview: 0,
        ownerConfirmed: 0,
        lastOrganizedAt: null,
      },
      recallFeedback: { rated: 0, helpful: 0, notHelpful: 0, lastRatedAt: null, windowDays: 90 },
      latestOrganizer: null,
      card: null,
      ownerFactCount: 0,
      peopleCount: 0,
    };
    const repository: ProfileMemoryHubRepository = {
      kind: 'profile-memory-hub-repository',
      async load() {
        return expected;
      },
    };
    await expect(getMemoryHubOverview(repository)).resolves.toEqual(expected);
  });
});
