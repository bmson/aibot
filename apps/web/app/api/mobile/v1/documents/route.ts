import { isModuleEnabled, loadConfig } from '@assistant/config';
import { getApplication } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_MULTIPART_BYTES = MAX_UPLOAD_BYTES + 1024 * 1024;

/** Binary document upload with the same limits and extraction pipeline as the web form. */
export async function POST(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  if (!isModuleEnabled(loadConfig(), 'documents')) {
    return mobileJson({ error: 'documents module disabled' }, { status: 404 });
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
