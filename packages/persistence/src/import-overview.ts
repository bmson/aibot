import type { Records } from './records.js';

export interface ImportOverviewData {
  sources: Records['importSources'][];
  quarantineBySource: Record<string, number>;
}

/** Owner-scoped import metadata and quarantine counts for workspace views. */
export interface ImportOverviewRepository {
  readonly kind: 'import-overview-repository';
  load(): Promise<ImportOverviewData>;
}

export function isImportOverviewRepository(value: unknown): value is ImportOverviewRepository {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    value.kind === 'import-overview-repository' &&
    'load' in value &&
    typeof value.load === 'function'
  );
}
