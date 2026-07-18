import { executeTask } from '@assistant/core';
import { tasks } from '@assistant/db';
import { eq } from 'drizzle-orm';
import {
  executeAmbiguousApplicationConfirmationTask,
  executeApplicationConfirmationTask,
} from './application-confirmations.js';
import type { AgentDeps } from './deps.js';
import { executorDeps } from './executor-deps.js';

/** Route deterministic internal workflows before the general model executor. */
export async function executeAgentTask(deps: AgentDeps, taskId: string) {
  const [task] = await deps.db
    .select({ trigger: tasks.trigger })
    .from(tasks)
    .where(eq(tasks.id, taskId));
  const trigger = task?.trigger as { payload?: Record<string, unknown> } | undefined;
  if (trigger?.payload?.kind === 'application_confirmation') {
    return executeApplicationConfirmationTask(deps, taskId);
  }
  if (trigger?.payload?.kind === 'application_confirmation_ambiguous') {
    return executeAmbiguousApplicationConfirmationTask(deps, taskId);
  }
  return executeTask(executorDeps(deps), taskId);
}
