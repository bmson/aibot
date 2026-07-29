import type { ModuleMeta } from '../contract.js';

/**
 * The sms module's tool labels, in a file with no runtime imports so the
 * browser-safe `@assistant/modules/ui` entry can aggregate them without
 * dragging configuration (and node builtins) into a client bundle.
 */
export const smsToolLabels = {
  'sms.send': { present: 'Sending a text', past: 'Sent a text message' },
} satisfies NonNullable<ModuleMeta['ui']>['toolLabels'];
