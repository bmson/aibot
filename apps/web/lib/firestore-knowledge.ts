import {
  correctKnowledgeGraphRelationWith,
  GRAPH_EXTRACTION_VERSION,
  knowledgeGraphCurationCommands,
  knowledgeWorkspaceQueries,
} from '@assistant/application';
import { profileLibraryQueries } from '@assistant/application/profile';
import { loadConfig, validateAgentPersistenceConfig } from '@assistant/config';
import {
  assertPrivacyErasureFenceUnchanged,
  FirestoreKnowledgeGraphCurationRepository,
  FirestoreKnowledgeGraphRelationMutationRepository,
  FirestoreKnowledgeWorkspaceReadRepository,
  FirestoreProfileLibraryRepository,
  getFirestoreKnowledgeGraphRelation,
  readPrivacyErasureFence,
} from '@assistant/firestore';
import {
  addOwnerKnowledgeGraphFactForCurrentPersistence,
  getFirestoreInstallationStore,
} from '@/lib/server';

function firestoreOwner() {
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER !== 'firestore')
    throw new Error('Firestore knowledge reads require Firestore persistence');
  const problems = validateAgentPersistenceConfig(config);
  if (problems.length) throw new Error(problems.join('; '));
  return { store: getFirestoreInstallationStore(), agentId: config.FIRESTORE_AGENT_ID };
}

/** SQL-free knowledge workspace reads for the configured Firestore owner. */
export function getFirestoreKnowledgeWorkspace() {
  const { store, agentId } = firestoreOwner();
  return knowledgeWorkspaceQueries(new FirestoreKnowledgeWorkspaceReadRepository(store, agentId));
}

/** Owner rename, retype, merge, orphan removal, retry, and search on the Firestore graph. */
export function getFirestoreKnowledgeCuration() {
  const { store, agentId } = firestoreOwner();
  return knowledgeGraphCurationCommands(
    new FirestoreKnowledgeGraphCurationRepository(store),
    agentId,
  );
}

/** Save the owner's replacement fact, then retire the corrected relation. */
export function correctFirestoreKnowledgeRelation(
  relationId: string,
  input: Parameters<typeof addOwnerKnowledgeGraphFactForCurrentPersistence>[0],
) {
  const { store, agentId } = firestoreOwner();
  return correctKnowledgeGraphRelationWith(
    {
      relationExists: async (id) =>
        (await getFirestoreKnowledgeGraphRelation(store, agentId, GRAPH_EXTRACTION_VERSION, id)) !==
        null,
      addFact: addOwnerKnowledgeGraphFactForCurrentPersistence,
      reject: (id) =>
        new FirestoreKnowledgeGraphRelationMutationRepository(store, agentId).review(
          id,
          'rejected',
        ),
    },
    relationId,
    input,
  );
}

/** The memory library page and its filters, fenced by the owner and privacy erasure. */
export async function loadFirestoreMemoryLibrary(
  input: Parameters<ReturnType<typeof profileLibraryQueries>['list']>[0],
) {
  const { store, agentId } = firestoreOwner();
  const fence = await readPrivacyErasureFence(store, agentId);
  const agents = await store.collection('agents').limit(2).get();
  if (
    agents.size !== 1 ||
    agents.docs[0]?.id !== store.doc('agents', agentId).id ||
    agents.docs[0]?.get('id') !== agentId
  )
    throw new Error('Memory library requires one matching configured owner');
  const queries = profileLibraryQueries(new FirestoreProfileLibraryRepository(store), agentId);
  const result = await Promise.all([queries.list(input), queries.listFilters()] as const);
  await assertPrivacyErasureFenceUnchanged(store, agentId, fence);
  return result;
}
