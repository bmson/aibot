import { executeTask } from '@assistant/core';
import { createPostgresTaskRepository } from '@assistant/db';
import { type AgentDeps, agentServices } from './deps.js';
import { executorDeps } from './executor-deps.js';

/** Route deterministic internal workflows before the general model executor. */
export async function executeAgentTask(deps: AgentDeps, taskId: string, generation?: number) {
  const taskRepository = deps.persistence?.tasks ?? createPostgresTaskRepository(deps.db);
  const task = await taskRepository.getTask(taskId);
  if (
    deps.config.PERSISTENCE_DRIVER === 'firestore' &&
    (!task || task.agentId !== deps.config.FIRESTORE_AGENT_ID)
  ) {
    throw new Error('Task is missing or outside the configured Firestore agent');
  }
  const trigger = task?.trigger as { payload?: Record<string, unknown> } | undefined;
  const kind = typeof trigger?.payload?.kind === 'string' ? trigger.payload.kind : undefined;
  // Module-declared deterministic handlers claim their trigger kinds.
  const handler = kind ? deps.modules.taskHandlerFor(kind) : undefined;
  if (handler) return handler.run(agentServices(deps), taskId, generation);
  // A deterministic kind whose owning module was removed must NOT fall through
  // to the general model executor — it would run an internal-trust task with a
  // payload it does not understand. Complete it benignly instead, mirroring
  // jobUnavailable. (Other internal-source kinds, e.g. known-sender-reply, have
  // no module owner and correctly go to the model executor below.)
  const unavailable = kind ? deps.modules.taskKindUnavailable(kind) : null;
  if (unavailable) {
    const lease = await taskRepository.claim(taskId, generation);
    if (!lease) return { outcome: 'not_claimable' as const };
    await taskRepository.completeTask(lease, { status: 'cancelled', progress: unavailable });
    return { outcome: 'cancelled' as const, detail: unavailable };
  }
  return executeTask(executorDeps(deps), taskId, generation);
}
