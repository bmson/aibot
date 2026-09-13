import { createPostgresExecutionEvidenceRepository, type Db } from '@assistant/db';
import type { ExecutionEvidenceRepository } from '@assistant/persistence';
import type { TaskState } from '../../events.js';
import { reconcileRequestChecklist } from '../request-checklist.js';

/** Exact task scope, including undecided/denied calls; no conversation-wide receipts. */
export async function refreshRequestChecklist(
  store: Db | ExecutionEvidenceRepository,
  task: { id: string; agentId: string },
  state: TaskState,
): Promise<void> {
  if (!state.requestChecklist) return;
  const repository =
    'kind' in store && store.kind === 'execution-evidence-repository'
      ? (store as ExecutionEvidenceRepository)
      : createPostgresExecutionEvidenceRepository(store as Db);
  const [rows, decisions] = await Promise.all([
    repository.taskEvidence({ agentId: task.agentId, taskId: task.id }),
    repository.checklistDecisions({ agentId: task.agentId, taskId: task.id }),
  ]);
  const byCall = new Map(decisions.map((decision) => [decision.toolCallId, decision.status]));
  state.requestChecklist = reconcileRequestChecklist(
    state.requestChecklist,
    rows.map((row) => {
      const decision = byCall.get(row.id);
      if (decision === 'denied' || decision === 'expired') return { ...row, status: decision };
      if (decision === 'approved' && row.status === 'awaiting_approval')
        return { ...row, status: 'approved_not_executed' };
      return row;
    }),
  );
}
