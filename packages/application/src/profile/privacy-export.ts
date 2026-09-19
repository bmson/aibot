import type { PrivacyExportRepository } from '@assistant/persistence';

export const LONG_TERM_MEMORY_EXPORT_SCOPE = [
  'saved facts',
  'knowledge graph projections',
  'people profiles',
  'writing samples and voice profile',
  'compiled recall card',
  'situation packs and decision reasons',
] as const;

/** Bind the owner-readable export without retaining a database or SQL fallback. */
export function createLongTermMemoryExporter(
  repository: PrivacyExportRepository,
  now: () => Date = () => new Date(),
) {
  return async function exportLongTermMemoryData() {
    return {
      format: 'assistant-long-term-memory-export/v1' as const,
      exportedAt: now().toISOString(),
      scope: [...LONG_TERM_MEMORY_EXPORT_SCOPE],
      ...(await repository.exportOwnerData()),
    };
  };
}
