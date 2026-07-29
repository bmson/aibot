import type { ModuleMeta } from '../contract.js';

/**
 * The browser module's tool labels, in a file with no runtime imports so the
 * browser-safe `@assistant/modules/ui` entry can aggregate them without
 * dragging configuration (and node builtins) into a client bundle.
 */
export const browserToolLabels = {
  'browser.plan': { present: 'Planning a browser task', past: 'Planned a browser task' },
  'browser.execute': { present: 'Running a browser task', past: 'Ran a browser task' },
} satisfies NonNullable<ModuleMeta['ui']>['toolLabels'];
