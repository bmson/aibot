import type { TaskCreateInput } from './task-creation.js';

export interface ProfileMemoryMaintenance {
  readonly kind: 'profile-memory-maintenance';
  queueGraphSync(input: { agentId: string; memoryId: string }): Promise<void>;
  removeOrphanedGraphEntities(input: { agentId: string; memoryId: string }): Promise<void>;
  retryBlockedGraphSource(input: { agentId: string; memoryId: string }): Promise<void>;
}

export type ProfileGraphSyncEnqueuer = (input: TaskCreateInput) => Promise<void>;

export function graphSyncExternalEventId(memoryId: string, now: Date): string {
  if (!memoryId || !Number.isFinite(now.getTime())) throw new Error('Invalid graph sync identity');
  return `profile:graph-sync:${memoryId}:${now.toISOString().slice(0, 16)}`;
}

export function graphSyncTaskInput(agentId: string, memoryId: string, now: Date): TaskCreateInput {
  const externalEventId = graphSyncExternalEventId(memoryId, now);
  return {
    agentId,
    type: 'scheduled',
    trust: 'assistant',
    externalEventId,
    trigger: {
      source: 'internal',
      externalEventId,
      agentId,
      trust: 'assistant',
      payload: {
        job: 'memory.graph_sync',
        instruction: 'refresh corrected source knowledge',
      },
    },
  };
}
