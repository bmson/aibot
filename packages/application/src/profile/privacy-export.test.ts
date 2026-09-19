import type { PrivacyExportRepository } from '@assistant/persistence';
import { describe, expect, it } from 'vitest';
import { createLongTermMemoryExporter } from './privacy-export.js';

describe('long-term memory export use case', () => {
  it('builds the stable owner-visible envelope without SQL', async () => {
    const data = {
      memories: [],
      knowledgeGraph: { entities: [], aliases: [], relations: [] },
      people: [],
      writingVoice: { samples: [], profile: null },
      compiledOwnerCard: null,
      situationPacks: [],
    };
    const repository: PrivacyExportRepository = {
      kind: 'privacy-export-repository',
      exportOwnerData: async () => data,
    };
    const exportData = createLongTermMemoryExporter(
      repository,
      () => new Date('2026-09-19T20:00:00.000Z'),
    );

    await expect(exportData()).resolves.toEqual({
      format: 'assistant-long-term-memory-export/v1',
      exportedAt: '2026-09-19T20:00:00.000Z',
      scope: [
        'saved facts',
        'knowledge graph projections',
        'people profiles',
        'writing samples and voice profile',
        'compiled recall card',
        'situation packs and decision reasons',
      ],
      ...data,
    });
  });
});
