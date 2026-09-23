import {
  type ActivityFilter,
  archiveActivity,
  archiveActivityWithRepository,
  archiveOldActivity,
  archiveOldActivityWithRepository,
  getTaskDetail,
  getTaskDetailWithRepository,
  listActivity,
  listActivityWithRepository,
  restoreActivity,
  restoreActivityWithRepository,
  type TaskDetail,
} from '@assistant/application/tasks';
import { loadConfig } from '@assistant/config';
import {
  FirestoreTaskActivityCommandRepository,
  FirestoreTaskActivityRepository,
} from '@assistant/firestore';
import { getDb, getFirestoreInstallationStore } from '@/lib/server';

function firestoreActivity() {
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER !== 'firestore') throw new Error('Firestore mode is not enabled');
  const repository = new FirestoreTaskActivityRepository(getFirestoreInstallationStore());
  return { repository, agentId: config.FIRESTORE_AGENT_ID };
}

export function listTaskActivity(input: {
  archived: boolean;
  filter: ActivityFilter;
  limit?: number;
}) {
  if (loadConfig().PERSISTENCE_DRIVER === 'firestore') {
    const { repository, agentId } = firestoreActivity();
    return listActivityWithRepository(repository, agentId, input);
  }
  return listActivity(getDb(), input);
}

export function getTaskActivityDetail(
  taskId: string,
  options: { pageSize?: number; before?: Date } = {},
): Promise<TaskDetail | null> {
  if (loadConfig().PERSISTENCE_DRIVER === 'firestore') {
    const { repository, agentId } = firestoreActivity();
    return getTaskDetailWithRepository(repository, agentId, taskId, options);
  }
  return getTaskDetail(getDb(), taskId, options);
}

export function archiveTaskActivity(taskId: string): Promise<void> {
  if (loadConfig().PERSISTENCE_DRIVER === 'firestore') {
    const { agentId } = firestoreActivity();
    return archiveActivityWithRepository(
      new FirestoreTaskActivityCommandRepository(getFirestoreInstallationStore()),
      agentId,
      taskId,
    );
  }
  return archiveActivity(getDb(), taskId);
}

export function restoreTaskActivity(taskId: string): Promise<void> {
  if (loadConfig().PERSISTENCE_DRIVER === 'firestore') {
    const { agentId } = firestoreActivity();
    return restoreActivityWithRepository(
      new FirestoreTaskActivityCommandRepository(getFirestoreInstallationStore()),
      agentId,
      taskId,
    );
  }
  return restoreActivity(getDb(), taskId);
}

export function archiveOldTaskActivity(): Promise<void> {
  if (loadConfig().PERSISTENCE_DRIVER === 'firestore') {
    const { agentId } = firestoreActivity();
    return archiveOldActivityWithRepository(
      new FirestoreTaskActivityCommandRepository(getFirestoreInstallationStore()),
      agentId,
    );
  }
  return archiveOldActivity(getDb());
}
