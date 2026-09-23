import {
  archiveActivity,
  archiveActivityWithRepository,
  cancelActivity,
  raiseTaskBudget,
  restoreActivity,
  restoreActivityWithRepository,
  retryActivity,
  revokeTaskAutonomy,
} from '@assistant/application/tasks';
import { loadConfig } from '@assistant/config';
import {
  createInstallationStore,
  FirestoreTaskActivityCommandRepository,
} from '@assistant/firestore';
import { getDb } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Archive and restore use the same non-destructive activity commands as the web UI. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const { id } = await params;
  if (!UUID_RE.test(id)) return mobileJson({ error: 'invalid activity id' }, { status: 400 });
  const body = (await request.json().catch(() => null)) as {
    action?: unknown;
    budgetUsdLimit?: unknown;
  } | null;
  try {
    const config = loadConfig();
    if (config.PERSISTENCE_DRIVER === 'firestore') {
      if (body?.action !== 'archive' && body?.action !== 'restore')
        return mobileJson(
          { error: 'This Activity action is unavailable in Firestore mode.' },
          { status: 503 },
        );
      const store = createInstallationStore({
        projectId: config.GCP_PROJECT,
        installationId: config.ASSISTANT_WORKSPACE_ID,
        databaseId: config.FIRESTORE_DATABASE_ID,
      });
      try {
        const repository = new FirestoreTaskActivityCommandRepository(store);
        if (body.action === 'archive')
          await archiveActivityWithRepository(repository, config.FIRESTORE_AGENT_ID, id);
        else await restoreActivityWithRepository(repository, config.FIRESTORE_AGENT_ID, id);
        return mobileJson({ ok: true });
      } finally {
        await store.db.terminate();
      }
    }
    if (body?.action === 'archive') await archiveActivity(getDb(), id);
    else if (body?.action === 'restore') await restoreActivity(getDb(), id);
    else if (body?.action === 'retry') await retryActivity(getDb(), id);
    else if (body?.action === 'cancel') await cancelActivity(getDb(), id);
    else if (body?.action === 'revoke-autonomy') await revokeTaskAutonomy(getDb(), id);
    else if (body?.action === 'raise-budget') {
      const budget = Number(body.budgetUsdLimit);
      if (!Number.isFinite(budget)) {
        return mobileJson({ error: 'budgetUsdLimit must be a number' }, { status: 400 });
      }
      await raiseTaskBudget(getDb(), id, budget);
    } else {
      return mobileJson(
        {
          error: 'action must be archive, restore, retry, cancel, revoke-autonomy, or raise-budget',
        },
        { status: 400 },
      );
    }
    return mobileJson({ ok: true });
  } catch (error) {
    return mobileJson(
      { error: error instanceof Error ? error.message : 'Activity could not be updated.' },
      { status: 409 },
    );
  }
}
