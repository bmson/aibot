import type { SkillLibraryRepository } from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import { listMobileWorkspaceSkills } from './workspace-skills.js';

describe('mobile workspace learned-skills projection', () => {
  it('requests the configured owner and returns exactly the mobile contract fields', async () => {
    const list = vi.fn<SkillLibraryRepository['list']>().mockResolvedValue([
      {
        id: 'skill-one',
        name: 'A useful skill',
        preconditions: 'when needed',
        steps: 'do the work',
        gotchas: '',
        ownerAuthored: true,
        deprecated: false,
        useCount: 3,
        successCount: 2,
        failureCount: 1,
        updatedAt: new Date('2026-09-10T12:00:00.000Z'),
      },
    ]);
    const repository: SkillLibraryRepository = {
      kind: 'skill-library-repository',
      list,
    };

    expect(await listMobileWorkspaceSkills(repository, 'owner')).toEqual([
      {
        id: 'skill-one',
        name: 'A useful skill',
        preconditions: 'when needed',
        steps: 'do the work',
        gotchas: '',
        ownerAuthored: true,
        deprecated: false,
        useCount: 3,
        successCount: 2,
        failureCount: 1,
        updatedAt: '2026-09-10T12:00:00.000Z',
      },
    ]);
    expect(list).toHaveBeenCalledExactlyOnceWith('owner');
  });
});
