import { parseFirestoreEmbeddingSpace } from '@assistant/config';
import { checkFirestoreRuntimeData, createInstallationStore } from '@assistant/firestore';

/** Read-only data gate for a future consumer runtime stage. */
async function main() {
  const projectId = process.env.GCP_PROJECT?.trim();
  const installationId = process.env.ASSISTANT_WORKSPACE_ID?.trim();
  const agentId = process.env.FIRESTORE_AGENT_ID?.trim();
  const provider = process.env.LLM_PROVIDER;
  const rawSpace = process.env.FIRESTORE_EMBEDDING_SPACE;
  if (
    !projectId ||
    !installationId ||
    !agentId ||
    !rawSpace ||
    (provider !== 'vertex' && provider !== 'openrouter')
  ) {
    throw new Error(
      'Set GCP_PROJECT, ASSISTANT_WORKSPACE_ID, FIRESTORE_AGENT_ID, FIRESTORE_EMBEDDING_SPACE, and LLM_PROVIDER=vertex|openrouter explicitly',
    );
  }
  const embeddingSpace = parseFirestoreEmbeddingSpace(rawSpace);
  const store = createInstallationStore({ projectId, installationId });
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
