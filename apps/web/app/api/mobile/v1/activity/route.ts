import { archiveOldActivity, listActivityWithRepository } from '@assistant/application/tasks';
import { loadConfig } from '@assistant/config';
import { createInstallationStore, FirestoreTaskActivityRepository } from '@assistant/firestore';
import { getApplication, getDb } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

/** Archived activity is intentionally a separate, on-demand mobile read. */
export async function GET(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const archived = new URL(request.url).searchParams.get('archived') === 'true';
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    const store = createInstallationStore({
      projectId: config.GCP_PROJECT,
      installationId: config.ASSISTANT_WORKSPACE_ID,
      databaseId: config.FIRESTORE_DATABASE_ID,
    });
    try {
      return mobileJson(
        await listActivityWithRepository(
          new FirestoreTaskActivityRepository(store),
          config.FIRESTORE_AGENT_ID,
          { archived, filter: 'all', limit: 50 },
        ),
      );
    } finally {
      await store.db.terminate();
    }
  }
  return mobileJson(await getApplication().listActivity({ archived, filter: 'all', limit: 50 }));
}

export async function POST(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  if (loadConfig().PERSISTENCE_DRIVER === 'firestore')
    return mobileJson(
      { error: 'Activity editing is unavailable in Firestore mode.' },
      { status: 503 },
    );
  const body = (await request.json().catch(() => null)) as { action?: unknown } | null;
  if (body?.action !== 'archive-old') {
    return mobileJson({ error: 'action must be archive-old' }, { status: 400 });
  }
  await archiveOldActivity(getDb());
  return mobileJson({ ok: true });
}
