import { InboundEventSchema } from '@assistant/core/events';
import { enqueueTask } from '@assistant/core/workflow/machine';
import {
  createPostgresOwnerCardCompilationRepository,
  createPostgresProfileMemoryMaintenance,
  createPostgresProfileMemoryManagementRepository,
  type Db,
} from '@assistant/db';
import {
  createProfileMemoryCommands,
  type ProfileMemoryCommandPersistence,
  type ProfileMemoryEmbeddingPort,
} from './memory-commands.js';

export function createPostgresProfileMemoryCommandPersistence(
  db: Db,
): ProfileMemoryCommandPersistence {
  return {
    kind: 'profile-memory-command-persistence',
    memories: createPostgresProfileMemoryManagementRepository(db),
    ownerCards: createPostgresOwnerCardCompilationRepository(db),
    maintenance: createPostgresProfileMemoryMaintenance(db, async (input) => {
      await enqueueTask(db, {
        event: InboundEventSchema.parse(input.trigger),
        type: input.type,
      });
    }),
  };
}

export function profileMemoryCommands(
  store: Db | ProfileMemoryCommandPersistence,
  router: ProfileMemoryEmbeddingPort = {
    async embed() {
      throw new Error('Memory authoring requires an embedding provider');
    },
  },
) {
  const persistence =
    'kind' in store && store.kind === 'profile-memory-command-persistence'
      ? (store as ProfileMemoryCommandPersistence)
      : createPostgresProfileMemoryCommandPersistence(store as Db);
  return createProfileMemoryCommands(persistence, router);
}
