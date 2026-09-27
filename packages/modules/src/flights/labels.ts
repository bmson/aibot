import type { ModuleMeta } from '../contract.js';

/** Runtime-import-free, so the browser-safe `/ui` entry can aggregate it. */
export const flightsToolLabels = {
  'flights.status': { present: 'Checking the flight', past: 'Checked the flight' },
  'flights.track': { present: 'Tracking the flight', past: 'Tracking the flight' },
} satisfies NonNullable<ModuleMeta['ui']>['toolLabels'];
