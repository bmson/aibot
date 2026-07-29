import type { ModuleMeta } from '../contract.js';

/**
 * The search module's tool labels, in a file with no runtime imports so the
 * browser-safe `@assistant/modules/ui` entry can aggregate them without
 * dragging configuration (and node builtins) into a client bundle.
 */
export const searchToolLabels = {
  'web.search': { present: 'Searching the web', past: 'Searched the web' },
} satisfies NonNullable<ModuleMeta['ui']>['toolLabels'];
