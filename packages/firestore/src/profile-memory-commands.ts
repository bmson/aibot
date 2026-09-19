import type { EmbeddingSpace } from '@assistant/persistence';
import { FirestoreOwnerCardCompilationRepository } from './owner-card-compilation.js';
import { FirestoreProfileMemoryMaintenance } from './profile-memory-maintenance.js';
import { FirestoreProfileMemoryManagementRepository } from './profile-memory-management.js';
import type { InstallationStore } from './store.js';

/** Concrete Firestore composition for the portable application memory commands. */
export function createFirestoreProfileMemoryCommandPersistence(
  store: InstallationStore,
  embeddingSpace: EmbeddingSpace,
) {
  return {
    kind: 'profile-memory-command-persistence' as const,
    memories: new FirestoreProfileMemoryManagementRepository(store, embeddingSpace),
    ownerCards: new FirestoreOwnerCardCompilationRepository(store),
    maintenance: new FirestoreProfileMemoryMaintenance(store),
  };
}
