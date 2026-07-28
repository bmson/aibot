import { browserMeta } from './browser/meta.js';
import { codeMeta } from './code/meta.js';
import type { ModuleMeta } from './contract.js';
import { documentsMeta } from './documents/meta.js';
import { googleMeta } from './google/meta.js';
import { remindersMeta } from './reminders/meta.js';
import { searchMeta } from './search/meta.js';
import { smsMeta } from './sms/meta.js';
import { watchesMeta } from './watches/meta.js';

/**
 * Every module's metadata, ordered like `assistantModuleNames` so diagnostics
 * and deployment plans read in a stable order. A conformance test asserts this
 * list stays exactly in step with the configuration enum.
 */
export const assistantModuleMetas: readonly ModuleMeta[] = [
  browserMeta,
  codeMeta,
  documentsMeta,
  googleMeta,
  remindersMeta,
  searchMeta,
  smsMeta,
  watchesMeta,
];
