import { deleteDocument } from '@assistant/application/documents';
import { isModuleEnabled, loadConfig, validateAgentPersistenceConfig } from '@assistant/config';
import { FirestoreDocumentReadRepository } from '@assistant/firestore';
import { getFirestoreDocumentStores } from '@/lib/firestore-documents';
import { getApplication, getFirestoreInstallationStore, getWorkspace } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Read one configured-owner document and its extracted passages. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const config = loadConfig();
  if (!isModuleEnabled(config, 'documents')) {
    return mobileJson({ error: 'documents module disabled' }, { status: 404 });
  }
  const { id } = await params;
  if (!UUID_RE.test(id)) return mobileJson({ error: 'invalid document id' }, { status: 400 });
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    const problems = validateAgentPersistenceConfig(config);
    if (problems.length) return mobileJson({ error: problems.join('; ') }, { status: 503 });
    const result = await new FirestoreDocumentReadRepository(
      getFirestoreInstallationStore(),
      config.FIRESTORE_AGENT_ID,
    ).get(config.FIRESTORE_AGENT_ID, id);
    return result
      ? mobileJson(result)
      : mobileJson({ error: 'document not found' }, { status: 404 });
  }
  const result = await getApplication().getDocument(id);
  return result ? mobileJson(result) : mobileJson({ error: 'document not found' }, { status: 404 });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const config = loadConfig();
  if (!isModuleEnabled(config, 'documents')) {
    return mobileJson({ error: 'documents module disabled' }, { status: 404 });
  }
  const { id } = await params;
  if (!UUID_RE.test(id)) return mobileJson({ error: 'invalid document id' }, { status: 400 });
  try {
    if (config.PERSISTENCE_DRIVER === 'firestore')
      await deleteDocument(getFirestoreDocumentStores(), getWorkspace(), id);
    else await getApplication().deleteDocument(id);
    return mobileJson({ ok: true });
  } catch (error) {
    return mobileJson(
      { error: error instanceof Error ? error.message : 'Document could not be deleted.' },
      { status: 409 },
    );
  }
}
