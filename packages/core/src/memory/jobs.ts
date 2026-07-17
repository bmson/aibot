import type { Db, TaskRow } from '@assistant/db';
import type { ModelRouter } from '../model-router/router.js';
import { runMemoryConsolidation } from './consolidation.js';
import { runMemoryExtraction } from './extraction.js';
import { runImportJob, type WorkspaceReader } from './import.js';

/**
 * Code jobs: tasks whose trigger payload carries { job: '<name>' } run a
 * registered function instead of the model step loop. Costs still meter to
 * the task (model/embed calls pass taskId), failures go through the normal
 * retry/dead-letter machinery, and a job may yield (done: false) to sleep
 * and resume from its checkpoint — that's how imports survive interruption.
 */
export type CodeJobName = 'memory.extract' | 'memory.consolidate' | 'import.run';

const CODE_JOBS: ReadonlySet<string> = new Set([
  'memory.extract',
  'memory.consolidate',
  'import.run',
]);

export interface CodeJobOutcome {
  done: boolean;
  runAfter?: Date;
  summary: string;
}

export function codeJobName(task: TaskRow): CodeJobName | null {
  const payload = (task.trigger as { payload?: { job?: unknown } } | null)?.payload;
  const job = typeof payload?.job === 'string' ? payload.job : null;
  return job && CODE_JOBS.has(job) ? (job as CodeJobName) : null;
}

export async function runCodeJob(
  deps: { db: Db; router: ModelRouter; workspace?: WorkspaceReader },
  job: CodeJobName,
  task: TaskRow,
): Promise<CodeJobOutcome> {
  switch (job) {
    case 'memory.extract': {
      const r = await runMemoryExtraction(deps, { taskId: task.id });
      return {
        done: true,
        summary: `extraction: ${r.saved} saved (${r.quarantined} quarantined, ${r.contactsCreated} new people), ${r.duplicates} duplicate, ${r.tombstoned} tombstoned, from ${r.conversationsScanned} conversation(s)`,
      };
    }
    case 'memory.consolidate': {
      const r = await runMemoryConsolidation(deps, { taskId: task.id });
      return {
        done: true,
        summary: `consolidation: ${r.entities} entities, ${r.duplicatesExpired} duplicates expired, ${r.contradictionsResolved} contradictions resolved, ${r.domainsAssigned} domains assigned, owner card recompiled`,
      };
    }
    case 'import.run':
      return runImportJob(deps, task);
  }
}
