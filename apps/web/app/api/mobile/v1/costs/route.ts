import { updateBudgetCaps, updateBudgetCapsWithRepository } from '@assistant/application/costs';
import { loadConfig, validateAgentPersistenceConfig } from '@assistant/config';
import { createInstallationStore, FirestoreBudgetCapsRepository } from '@assistant/firestore';
import { getDb } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

/** Update the same default-task, daily, and monthly hard caps as the web costs form. */
export async function PATCH(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || Array.isArray(body)) {
    return mobileJson({ error: 'invalid cost limits body' }, { status: 400 });
  }
  const values = {
    task_default: typeof body.taskDefault === 'string' ? body.taskDefault : '',
    daily: typeof body.daily === 'string' ? body.daily : '',
    monthly: typeof body.monthly === 'string' ? body.monthly : '',
  };
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    const problems = validateAgentPersistenceConfig(config);
    if (problems.length) throw new Error(problems.join('; '));
    const store = createInstallationStore({
      projectId: config.GCP_PROJECT,
      installationId: config.ASSISTANT_WORKSPACE_ID,
    });
    try {
      await updateBudgetCapsWithRepository(
        new FirestoreBudgetCapsRepository(store),
        config.FIRESTORE_AGENT_ID,
        values,
      );
    } finally {
      await store.db.terminate();
    }
  } else await updateBudgetCaps(getDb(), values);
  return mobileJson({ ok: true });
}
