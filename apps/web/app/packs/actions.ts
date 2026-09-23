'use server';

import {
  changeOwnerPack,
  listPackSources,
  listSituationPacks,
} from '@assistant/application/situations';
import { loadConfig, validateAgentPersistenceConfig } from '@assistant/config';
import {
  FirestoreSituationPackMutationRepository,
  FirestoreSituationPackReadRepository,
} from '@assistant/firestore';
import { revalidatePath } from 'next/cache';
import { requireOwner } from '@/auth';
import { getAgentIdentity, getDb, getFirestoreInstallationStore } from '@/lib/server';

export async function loadPacks() {
  await requireOwner();
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    const problems = validateAgentPersistenceConfig(config);
    if (problems.length) throw new Error(problems.join('; '));
    const repository = new FirestoreSituationPackReadRepository(getFirestoreInstallationStore());
    return repository.overview(config.FIRESTORE_AGENT_ID);
  }
  const agent = await getAgentIdentity();
  if (!agent.id) return { packs: [], sources: [] };
  const [packs, sources] = await Promise.all([
    listSituationPacks(getDb(), agent.id),
    listPackSources(getDb(), agent.id),
  ]);
  return { packs, sources };
}
export async function changePack(input: unknown) {
  await requireOwner();
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    const problems = validateAgentPersistenceConfig(config);
    if (problems.length) return { ok: false as const, error: problems.join('; ') };
    const repository = new FirestoreSituationPackMutationRepository(
      getFirestoreInstallationStore(),
      config.FIRESTORE_AGENT_ID,
    );
    const result = await repository.command(input, { ownerConfirmed: true });
    revalidatePath('/packs');
    return result;
  }
  const agent = await getAgentIdentity();
  if (!agent.id) return { ok: false as const, error: 'Owner unavailable.' };
  const result = await changeOwnerPack(getDb(), agent.id, input);
  revalidatePath('/packs');
  return result;
}
