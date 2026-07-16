import type { Db, TaskRow } from '@assistant/db';
import type { ModelRouter } from '../model-router/router.js';
import { runMemoryConsolidation } from './consolidation.js';
import { runMemoryExtraction } from './extraction.js';

/**
 * Code jobs: scheduled tasks whose trigger payload carries { job: '<name>' }
 * run a registered function instead of the model step loop. Costs still meter
 * to the task (model/embed calls pass taskId), and failures go through the
 * normal retry/dead-letter machinery.
 */
export type CodeJobName = 'memory.extract' | 'memory.consolidate';

export function codeJobName(task: TaskRow): CodeJobName | null {
  const payload = (task.trigger as { payload?: { job?: unknown } } | null)?.payload;
  const job = typeof payload?.job === 'string' ? payload.job : null;
  return job === 'memory.extract' || job === 'memory.consolidate' ? job : null;
}

export async function runCodeJob(
  deps: { db: Db; router: ModelRouter },
  job: CodeJobName,
  taskId: string,
): Promise<string> {
  switch (job) {
    case 'memory.extract': {
      const r = await runMemoryExtraction(deps, { taskId });
      return `extraction: ${r.saved} saved (${r.quarantined} quarantined, ${r.contactsCreated} new people), ${r.duplicates} duplicate, ${r.tombstoned} tombstoned, from ${r.conversationsScanned} conversation(s)`;
    }
    case 'memory.consolidate': {
      const r = await runMemoryConsolidation(deps, { taskId });
      return `consolidation: ${r.entities} entities, ${r.duplicatesExpired} duplicates expired, ${r.contradictionsResolved} contradictions resolved, ${r.domainsAssigned} domains assigned, owner card recompiled`;
    }
  }
}
