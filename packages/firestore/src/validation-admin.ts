/** Explicit tooling subpath; never imported by an application composition root. */
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
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
    // Index builds are independent and take minutes in real Firestore. Wait for
    // every operation to settle, including after a failure, before deleting its database.
    const builds: Promise<PromiseSettledResult<void>>[] = [];
    for (const definition of input.indexes) {
      const { collectionGroup, ...index } = definition;
      try {
        // Submit control-plane changes serially; their builds still run concurrently.
        // Google can abort even independent index creations due to metadata contention.
        let operation: { promise(): Promise<unknown> } | undefined;
        for (let attempt = 0; !operation; attempt++) {
          try {
            [operation] = await admin.createIndex({
              parent: `${name}/collectionGroups/${collectionGroup}`,
              index,
            });
          } catch (error) {
            if ((error as { code?: number }).code !== 10 || attempt >= 4) throw error;
            input.progress('index_creation_retry', { name, collectionGroup, attempt: attempt + 1 });
            await delay(250 * 2 ** attempt);
          }
        }
        // Attach rejection handlers immediately, even while later creates are pending.
        builds.push(
          operation.promise().then(
            () => {
              input.progress('index_ready', { name, collectionGroup, fields: index.fields });
              return { status: 'fulfilled', value: undefined } as const;
            },
            (reason: unknown) => ({ status: 'rejected', reason }) as const,
          ),
        );
      } catch (reason) {
        input.progress('index_creation_failed', {
          name,
          collectionGroup,
          message: reason instanceof Error ? reason.message : String(reason),
        });
        builds.push(Promise.resolve({ status: 'rejected', reason }));
      }
    }
    const completedBuilds = await Promise.all(builds);
    const failure = completedBuilds.find((build) => build.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    input.progress('validating', { name });
    store = createInstallationStore({
      projectId: input.projectId,
      databaseId,
      installationId: `validation-${randomUUID()}`,
    });
    const result = await validate(store);
    input.progress('validation_passed', { name });
    return result;
  } catch (error) {
    // Cleanup itself can take minutes; report the original failure immediately.
    input.progress('validation_failed', {
      name,
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
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
