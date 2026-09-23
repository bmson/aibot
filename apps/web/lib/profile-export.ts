import { exportLongTermMemoryData } from '@assistant/application/profile';
import { loadConfig } from '@assistant/config';
import { FirestorePrivacyExportRepository } from '@assistant/firestore';
import { getApplication, getFirestoreInstallationStore } from '@/lib/server';

/** Both owner clients download the same privacy-scoped long-term memory view. */
export function loadOwnerProfileExport() {
  const config = loadConfig();
  return config.PERSISTENCE_DRIVER === 'firestore'
    ? exportLongTermMemoryData(
        new FirestorePrivacyExportRepository(
          getFirestoreInstallationStore(),
          config.FIRESTORE_AGENT_ID,
        ),
      )
    : getApplication().exportLongTermMemoryData();
}
