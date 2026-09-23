import {
  deleteMobileSkill,
  setMobileSkillDeprecated,
} from '@assistant/application/workspace-skills';
import { loadConfig, validateAgentPersistenceConfig } from '@assistant/config';
import { createInstallationStore, FirestoreSkillMutationRepository } from '@assistant/firestore';
import { getApplication } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function firestoreMutation(id: string, deprecated?: boolean): Promise<Response> {
  const config = loadConfig();
  const problems = validateAgentPersistenceConfig(config);
  if (problems.length) return mobileJson({ error: problems.join('; ') }, { status: 503 });
  const store = createInstallationStore({
    projectId: config.GCP_PROJECT,
    installationId: config.ASSISTANT_WORKSPACE_ID,
  });
  try {
    const repository = new FirestoreSkillMutationRepository(store);
    if (deprecated === undefined)
      await deleteMobileSkill(repository, config.FIRESTORE_AGENT_ID, id);
    else await setMobileSkillDeprecated(repository, config.FIRESTORE_AGENT_ID, id, deprecated);
    return mobileJson({ ok: true });
  } catch (error) {
    return mobileJson(
      { error: error instanceof Error ? error.message : 'Skill could not be updated.' },
      { status: 409 },
    );
  } finally {
    await store.db.terminate();
  }
}

function skillInput(
  body: unknown,
): { name: string; preconditions: string; steps: string; gotchas: string } | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'invalid skill body' };
  }
  const value = body as Record<string, unknown>;
  const text = (key: string) => (typeof value[key] === 'string' ? value[key].trim() : '');
  const name = text('name');
  const steps = text('steps');
  if (!name) return { error: 'Name is required.' };
  if (!steps) return { error: 'Steps are required.' };
  return { name, steps, preconditions: text('preconditions'), gotchas: text('gotchas') };
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  if (loadConfig().PERSISTENCE_DRIVER === 'firestore')
    return mobileJson(
      { error: 'Skill editing is unavailable in Firestore mode.' },
      { status: 503 },
    );
  const { id } = await params;
  if (!UUID_RE.test(id)) return mobileJson({ error: 'invalid skill id' }, { status: 400 });
  const input = skillInput(await request.json().catch(() => null));
  if ('error' in input) return mobileJson({ error: input.error }, { status: 400 });
  const result = await getApplication().editSkill(id, input);
  return result.error
    ? mobileJson({ error: result.error }, { status: 409 })
    : mobileJson({ ok: true });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const { id } = await params;
  if (!UUID_RE.test(id)) return mobileJson({ error: 'invalid skill id' }, { status: 400 });
  const body = (await request.json().catch(() => null)) as { deprecated?: unknown } | null;
  if (typeof body?.deprecated !== 'boolean') {
    return mobileJson({ error: 'deprecated must be a boolean' }, { status: 400 });
  }
  if (loadConfig().PERSISTENCE_DRIVER === 'firestore')
    return firestoreMutation(id, body.deprecated);
  await getApplication().setSkillDeprecated(id, body.deprecated);
  return mobileJson({ ok: true });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const { id } = await params;
  if (!UUID_RE.test(id)) return mobileJson({ error: 'invalid skill id' }, { status: 400 });
  if (loadConfig().PERSISTENCE_DRIVER === 'firestore') return firestoreMutation(id);
  await getApplication().deleteSkill(id);
  return mobileJson({ ok: true });
}
