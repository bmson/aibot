import type { ModuleMeta } from '../contract.js';

/**
 * The documents module's tool labels, in a file with no runtime imports so the
 * browser-safe `@assistant/modules/ui` entry can aggregate them without
 * dragging configuration (and node builtins) into a client bundle.
 */
export const documentsToolLabels = {
  'documents.search': { present: 'Searching documents', past: 'Searched documents' },
} satisfies NonNullable<ModuleMeta['ui']>['toolLabels'];
