import { browserToolLabels } from './browser/labels.js';
import { codeToolLabels } from './code/labels.js';
import { documentsToolLabels } from './documents/labels.js';
import { googleToolLabels } from './google/labels.js';
import { searchToolLabels } from './search/labels.js';
import { smsToolLabels } from './sms/labels.js';

/**
 * Browser-safe module UI data. This entry point may reach ONLY the modules'
 * `labels.ts` files (and type-only imports): unlike `/meta`, whose graph loads
 * `@assistant/config` (dotenv, node builtins) and therefore only runs
 * server-side, this one is imported by web code that client components share.
 * The web build fails loudly if a runtime config import sneaks in here.
 */

const allToolLabels = [
  browserToolLabels,
  codeToolLabels,
  documentsToolLabels,
  googleToolLabels,
  searchToolLabels,
  smsToolLabels,
];

export interface ToolLabelSets {
  present: ReadonlyMap<string, string>;
  past: ReadonlyMap<string, string>;
}

// Labels are static, so the aggregation happens once at module load.
const aggregated: ToolLabelSets = (() => {
  const present = new Map<string, string>();
  const past = new Map<string, string>();
  for (const labels of allToolLabels) {
    for (const [tool, tenses] of Object.entries(labels)) {
      present.set(tool, tenses.present);
      past.set(tool, tenses.past);
    }
  }
  return { present, past };
})();

/**
 * Every module's tool labels, for the web UI's activity chips (present tense)
 * and completed-task log (past tense). Deliberately NOT filtered by enablement:
 * task history must still render labels for calls made by a module that was
 * disabled later.
 */
export function moduleToolLabels(): ToolLabelSets {
  return aggregated;
}
