import {
  createPostgresPrivacyErasureRepository,
  createPostgresPrivacyExportRepository,
  type Db,
} from '@assistant/db';
import type { PrivacyExportRepository } from '@assistant/persistence';
import { forgetLongTermMemoryWithRepository, type PrivacyWorkspace } from './privacy-erasure.js';
import { createLongTermMemoryExporter } from './privacy-export.js';

export type { PrivacyWorkspace } from './privacy-erasure.js';
export { forgetLongTermMemoryWithRepository } from './privacy-erasure.js';

/** A deliberately narrow, portable owner view of profile data used for recall. */
export function exportLongTermMemoryData(store: Db | PrivacyExportRepository) {
  const repository =
    'kind' in store && store.kind === 'privacy-export-repository'
      ? (store as PrivacyExportRepository)
      : createPostgresPrivacyExportRepository(store as Db);
  return createLongTermMemoryExporter(repository)();
}

/** Owner-requested erasure with durable workspace asset recovery. */
export function forgetLongTermMemory(db: Db, workspace?: PrivacyWorkspace) {
  return forgetLongTermMemoryWithRepository(createPostgresPrivacyErasureRepository(db), workspace);
}
