import { browserMeta } from './browser/meta.js';
import { codeMeta } from './code/meta.js';
import type { ModuleMeta } from './contract.js';
import { documentsMeta } from './documents/meta.js';
import { calendarMeta } from './google/calendar-meta.js';
import { googleMeta } from './google/meta.js';
import { mapsMeta } from './maps/meta.js';
import { pushMeta } from './push/meta.js';
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
  calendarMeta,
  codeMeta,
  documentsMeta,
  googleMeta,
  mapsMeta,
  pushMeta,
  remindersMeta,
  searchMeta,
  smsMeta,
  watchesMeta,
];
