import { executeTask } from '@assistant/core';
import { tasks } from '@assistant/db';
import { eq } from 'drizzle-orm';
import { type AgentDeps, agentServices } from './deps.js';
import { executorDeps } from './executor-deps.js';

/** Route deterministic internal workflows before the general model executor. */
export async function executeAgentTask(deps: AgentDeps, taskId: string) {
  const [task] = await deps.db
    .select({ trigger: tasks.trigger })
    .from(tasks)
    .where(eq(tasks.id, taskId));
  const trigger = task?.trigger as { payload?: Record<string, unknown> } | undefined;
  const kind = trigger?.payload?.kind;
  // Module-declared deterministic handlers claim their trigger kinds; every
  // other task goes to the general model executor.
  const handler = typeof kind === 'string' ? deps.modules.taskHandlerFor(kind) : undefined;
  if (handler) return handler.run(agentServices(deps), taskId);
  return executeTask(executorDeps(deps), taskId);
}
