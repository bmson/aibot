import { claimTask, completeTask, executeTask } from '@assistant/core';
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
  const kind = typeof trigger?.payload?.kind === 'string' ? trigger.payload.kind : undefined;
  // Module-declared deterministic handlers claim their trigger kinds.
  const handler = kind ? deps.modules.taskHandlerFor(kind) : undefined;
  if (handler) return handler.run(agentServices(deps), taskId);
  // A deterministic kind whose owning module was removed must NOT fall through
  // to the general model executor — it would run an internal-trust task with a
  // payload it does not understand. Complete it benignly instead, mirroring
  // jobUnavailable. (Other internal-source kinds, e.g. known-sender-reply, have
  // no module owner and correctly go to the model executor below.)
  const unavailable = kind ? deps.modules.taskKindUnavailable(kind) : null;
  if (unavailable) {
    const lease = await claimTask(deps.db, taskId);
    if (!lease) return { outcome: 'not_claimable' as const };
    await completeTask(deps.db, lease, { status: 'cancelled', progress: unavailable });
    return { outcome: 'cancelled' as const, detail: unavailable };
  }
  return executeTask(executorDeps(deps), taskId);
}
