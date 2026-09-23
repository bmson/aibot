import type { ModuleMeta } from '../contract.js';

/** Runtime-import-free, so the browser-safe `/ui` entry can aggregate it. */
export const mapsToolLabels = {
  'maps.directions': { present: 'Finding the route', past: 'Found the route' },
} satisfies NonNullable<ModuleMeta['ui']>['toolLabels'];
