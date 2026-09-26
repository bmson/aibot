import type { PortableDocumentStores } from '@assistant/application/documents';
import { loadConfig } from '@assistant/config';
import {
  FirestoreDocumentCatalogRepository,
  FirestoreDocumentDeletionRepository,
  FirestoreDocumentReadRepository,
} from '@assistant/firestore';
import { getFirestoreInstallationStore } from '@/lib/server';

/** The configured owner's Firestore document stores for upload and deletion. */
export function getFirestoreDocumentStores(): PortableDocumentStores {
  const { FIRESTORE_AGENT_ID: agentId } = loadConfig();
  const store = getFirestoreInstallationStore();
  return {
    agentId,
    catalog: new FirestoreDocumentCatalogRepository(store, agentId),
    deletion: new FirestoreDocumentDeletionRepository(store, agentId),
  };
}

/** The owner's document catalog overview, read from Firestore. */
export function getFirestoreDocumentsOverview() {
  const { FIRESTORE_AGENT_ID: agentId } = loadConfig();
  return new FirestoreDocumentReadRepository(getFirestoreInstallationStore(), agentId).list(
    agentId,
  );
}
