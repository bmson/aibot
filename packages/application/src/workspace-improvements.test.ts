import type { WorkspaceImprovementRepository } from '@assistant/persistence';
import { describe, expect, it } from 'vitest';
import { listMobileWorkspaceImprovements } from './workspace-improvements.js';

describe('mobile workspace improvement projection', () => {
  it('retains the existing mobile payload and only marks model role changes applyable', async () => {
    const repository: WorkspaceImprovementRepository = {
      kind: 'workspace-improvement-repository',
      listOpen: async () => [
        {
          id: 'one',
          kind: 'model_role',
          title: 'Use another model',
          rationale: 'Retry cost',
          change: { suggestion: 'Switch the draft role' },
          evidenceIds: ['first', 'second'],
          createdAt: new Date('2026-09-22T00:00:00Z'),
        },
        {
          id: 'two',
          kind: 'note',
          title: 'Review workflow',
          rationale: 'Recurring failures',
          change: { suggestion: 12 },
          evidenceIds: [],
          createdAt: new Date('2026-09-21T00:00:00Z'),
        },
      ],
    };
    expect(await listMobileWorkspaceImprovements(repository, 'owner')).toEqual([
      {
        id: 'one',
        kind: 'model_role',
        title: 'Use another model',
        rationale: 'Retry cost',
        suggestion: 'Switch the draft role',
        evidenceCount: 2,
        applyable: true,
        createdAt: '2026-09-22T00:00:00.000Z',
      },
      {
        id: 'two',
        kind: 'note',
        title: 'Review workflow',
        rationale: 'Recurring failures',
        suggestion: '',
        evidenceCount: 0,
        applyable: false,
        createdAt: '2026-09-21T00:00:00.000Z',
      },
    ]);
  });
});
