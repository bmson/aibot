import { parseFirestoreEmbeddingSpace } from '@assistant/config';
import { checkFirestoreRuntimeData, createInstallationStore } from '@assistant/firestore';
import { parseFirestoreRuntimeDataPreflightArgs } from './firestore-runtime-data-preflight-args.js';
import { createGcloudAuthClient } from './gcloud-auth.js';

/** Read-only data gate for a future consumer runtime stage. */
async function main() {
  const values = parseFirestoreRuntimeDataPreflightArgs(process.argv.slice(2));
  const projectId = process.env.GCP_PROJECT?.trim();
  const installationId = process.env.ASSISTANT_WORKSPACE_ID?.trim();
  const databaseId = values['database-id']?.trim() || process.env.FIRESTORE_DATABASE_ID?.trim();
  const agentId = process.env.FIRESTORE_AGENT_ID?.trim();
  const provider = process.env.LLM_PROVIDER;
  const rawSpace = process.env.FIRESTORE_EMBEDDING_SPACE;
  if (
    !projectId ||
    !installationId ||
    !databaseId ||
    !agentId ||
    !rawSpace ||
    (provider !== 'vertex' && provider !== 'openrouter')
  ) {
    throw new Error(
      'Set GCP_PROJECT, ASSISTANT_WORKSPACE_ID, FIRESTORE_DATABASE_ID (or --database-id), FIRESTORE_AGENT_ID, FIRESTORE_EMBEDDING_SPACE, and LLM_PROVIDER=vertex|openrouter explicitly',
    );
  }
  const embeddingSpace = parseFirestoreEmbeddingSpace(rawSpace);
  const authClient = values['gcloud-auth'] ? await createGcloudAuthClient() : undefined;
  const store = createInstallationStore({ projectId, installationId, databaseId, authClient });
  try {
    const result = await checkFirestoreRuntimeData(store, {
      agentId,
      provider,
      embeddingSpace,
    });
    console.log(JSON.stringify(result));
    if (!result.ready) process.exitCode = 1;
  } finally {
    await store.db.terminate();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Firestore runtime data preflight failed');
  process.exitCode = 1;
});
