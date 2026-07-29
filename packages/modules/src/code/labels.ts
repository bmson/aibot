import type { ModuleMeta } from '../contract.js';

/**
 * The code module's tool labels, in a file with no runtime imports so the
 * browser-safe `@assistant/modules/ui` entry can aggregate them without
 * dragging configuration (and node builtins) into a client bundle.
 */
export const codeToolLabels = {
  'code.execute': { present: 'Running code', past: 'Ran code' },
} satisfies NonNullable<ModuleMeta['ui']>['toolLabels'];
