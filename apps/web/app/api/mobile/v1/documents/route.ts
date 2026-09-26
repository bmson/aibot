import { uploadDocument } from '@assistant/application/documents';
import { isModuleEnabled, loadConfig, validateAgentPersistenceConfig } from '@assistant/config';
import { FirestoreDocumentReadRepository } from '@assistant/firestore';
import { getFirestoreDocumentStores } from '@/lib/firestore-documents';
import { getApplication, getFirestoreInstallationStore, getWorkspace } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_MULTIPART_BYTES = MAX_UPLOAD_BYTES + 1024 * 1024;

/** List the configured owner's documents and aggregate statistics. */
export async function GET(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  if (!isModuleEnabled(loadConfig(), 'documents')) {
    return mobileJson({ error: 'documents module disabled' }, { status: 404 });
  }
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    const problems = validateAgentPersistenceConfig(config);
    if (problems.length) return mobileJson({ error: problems.join('; ') }, { status: 503 });
    const result = await new FirestoreDocumentReadRepository(
      getFirestoreInstallationStore(),
      config.FIRESTORE_AGENT_ID,
    ).list(config.FIRESTORE_AGENT_ID);
    return mobileJson(result);
  }
  return mobileJson(await getApplication().getDocuments());
}

/** Binary document upload with the same limits and extraction pipeline as the web form. */
export async function POST(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const config = loadConfig();
  if (!isModuleEnabled(config, 'documents')) {
    return mobileJson({ error: 'documents module disabled' }, { status: 404 });
  }
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    const problems = validateAgentPersistenceConfig(config);
    if (problems.length) return mobileJson({ error: problems.join('; ') }, { status: 503 });
  }
  const contentLength = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_MULTIPART_BYTES) {
    return mobileJson({ error: 'file too large for upload' }, { status: 413 });
  }
  const form = await request.formData().catch(() => null);
  const file = form?.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return mobileJson({ error: 'no file uploaded' }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return mobileJson({ error: 'file too large for upload' }, { status: 413 });
  }
  try {
    if (config.PERSISTENCE_DRIVER === 'firestore') {
      const result = await uploadDocument(getFirestoreDocumentStores(), getWorkspace(), {
        name: file.name,
        title: String(form?.get('title') ?? ''),
        mime: file.type,
        bytes: Buffer.from(await file.arrayBuffer()),
      });
      return mobileJson({ ok: true, duplicate: result.duplicate }, { status: 201 });
    }
    await getApplication().uploadDocument({
      name: file.name,
      title: String(form?.get('title') ?? ''),
      mime: file.type,
      bytes: Buffer.from(await file.arrayBuffer()),
    });
    return mobileJson({ ok: true }, { status: 201 });
  } catch (error) {
    return mobileJson(
      { error: error instanceof Error ? error.message : 'Document could not be uploaded.' },
      { status: 409 },
    );
  }
}
