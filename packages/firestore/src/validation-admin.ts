/** Explicit tooling subpath; never imported by an application composition root. */
import { randomUUID } from 'node:crypto';
import firestore from '@google-cloud/firestore';
import { createInstallationStore, type InstallationStore } from './store.js';
import { dueTasksQuery } from './task-lifecycle.js';

type AdminClient = InstanceType<typeof firestore.v1.FirestoreAdminClient>;
type IndexRequest = NonNullable<Parameters<AdminClient['createIndex']>[0]>;
export type ValidationIndex = NonNullable<IndexRequest['index']> & { collectionGroup: string };

export function validationDatabaseId(): string {
  return `assistant-validation-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

/** Creates a fresh named database only, waits for indexes, and cleans up its own resource. */
export async function withValidationDatabase<T>(
  input: {
    projectId: string;
    location: string;
    indexes: ValidationIndex[];
    progress: (stage: string, details: Record<string, unknown>) => void;
  },
  validate: (store: InstallationStore) => Promise<T>,
): Promise<T> {
  if (process.env.FIRESTORE_EMULATOR_HOST)
    throw new Error('Live validation refuses emulator routing');
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(input.projectId))
    throw new Error('Explicit Google project ID required');
  const databaseId = validationDatabaseId();
  const name = `projects/${input.projectId}/databases/${databaseId}`;
  const admin = new firestore.v1.FirestoreAdminClient({ projectId: input.projectId });
  let created = false;
  let store: InstallationStore | undefined;
  input.progress('creating_database', { name, location: input.location });
  try {
    const [operation] = await admin.createDatabase({
      parent: `projects/${input.projectId}`,
      databaseId,
      database: {
        locationId: input.location,
        type: 'FIRESTORE_NATIVE',
        databaseEdition: 'STANDARD',
      },
    });
    created = true;
    await operation.promise();
    input.progress('creating_indexes', { name, count: input.indexes.length });
    for (const definition of input.indexes) {
      const { collectionGroup, ...index } = definition;
      const [indexOperation] = await admin.createIndex({
        parent: `${name}/collectionGroups/${collectionGroup}`,
        index,
      });
      await indexOperation.promise();
    }
    input.progress('validating', { name });
    store = createInstallationStore({
      projectId: input.projectId,
      databaseId,
      installationId: `validation-${randomUUID()}`,
    });
    return await validate(store);
  } finally {
    try {
      if (store) await store.db.terminate();
    } finally {
      try {
        if (created) {
          input.progress('deleting_database', { name });
          const [deletion] = await admin.deleteDatabase({ name });
          await deletion.promise();
          input.progress('database_deleted', { name });
        }
      } finally {
        await admin.close();
      }
    }
  }
}

export async function explainDueTaskQuery(store: InstallationStore) {
  const result = await dueTasksQuery(store, store.now(), 10).explain({ analyze: true });
  return result.metrics;
}
