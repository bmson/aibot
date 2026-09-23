import type { ProfileVoiceOverviewRepository } from '@assistant/persistence';
import { describe, expect, it } from 'vitest';
import { getVoiceOverview } from './queries.js';

describe('getVoiceOverview', () => {
  it('uses a portable repository without a database dependency', async () => {
    const expected = {
      voiceStats: { total: 3, auto: 1, uploaded: 2 },
      voiceProfile: { description: 'Direct', dos: ['concise'], donts: [], signature: '' },
      voiceImports: [],
    };
    const repository: ProfileVoiceOverviewRepository = {
      kind: 'profile-voice-overview-repository',
      async load() {
        return expected;
      },
    };
    await expect(getVoiceOverview(repository)).resolves.toEqual(expected);
  });
});
