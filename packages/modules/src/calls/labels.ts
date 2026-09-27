import type { ModuleMeta } from '../contract.js';

/** The calls module's tool labels; no runtime imports (see sms/labels.ts). */
export const callsToolLabels = {
  'phone.call': { present: 'On a phone call', past: 'Made a phone call' },
} satisfies NonNullable<ModuleMeta['ui']>['toolLabels'];
