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
import { getAgentIdentity, getDb, getFirestoreInstallationStore } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    const problems = validateAgentPersistenceConfig(config);
    if (problems.length) return mobileJson({ error: problems.join('; ') }, { status: 503 });
    const repository = new FirestoreSituationPackReadRepository(getFirestoreInstallationStore());
    return mobileJson(await repository.overview(config.FIRESTORE_AGENT_ID));
  }
  const agent = await getAgentIdentity();
  if (!agent.id) return mobileJson({ packs: [], sources: [] });
  const [packs, sources] = await Promise.all([
    listSituationPacks(getDb(), agent.id),
    listPackSources(getDb(), agent.id),
  ]);
  return mobileJson({ packs, sources });
}

export async function POST(request: Request) {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    const problems = validateAgentPersistenceConfig(config);
    if (problems.length) return mobileJson({ error: problems.join('; ') }, { status: 503 });
    const text = await request.text();
    if (text.length > 32_000)
      return mobileJson({ ok: false, error: 'Pack command is too large.' }, { status: 413 });
    let input: unknown;
    try {
      input = JSON.parse(text);
    } catch {
      return mobileJson({ ok: false, error: 'Invalid JSON.' }, { status: 400 });
    }
    const repository = new FirestoreSituationPackMutationRepository(
      getFirestoreInstallationStore(),
      config.FIRESTORE_AGENT_ID,
    );
    const result = await repository.command(input, { ownerConfirmed: true });
    return mobileJson(result, { status: result.ok ? 200 : 409 });
  }
  const agent = await getAgentIdentity();
  if (!agent.id) return mobileJson({ ok: false, error: 'Owner unavailable.' }, { status: 404 });
  const text = await request.text();
  if (text.length > 32_000)
    return mobileJson({ ok: false, error: 'Pack command is too large.' }, { status: 413 });
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    return mobileJson({ ok: false, error: 'Invalid JSON.' }, { status: 400 });
  }
  const result = await changeOwnerPack(getDb(), agent.id, input);
  return mobileJson(result, { status: result.ok ? 200 : 409 });
}
