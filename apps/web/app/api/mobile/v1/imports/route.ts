import { getApplication } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_MULTIPART_BYTES = MAX_UPLOAD_BYTES + 1024 * 1024;

/** Upload a backstory archive or writing samples through the same importer as the web UI. */
export async function POST(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  if (request.headers.get('content-type')?.includes('application/json')) {
    const body = (await request.json().catch(() => null)) as {
      action?: unknown;
      source?: unknown;
      verdict?: unknown;
      workspacePath?: unknown;
    } | null;
    if (typeof body?.source !== 'string' || !body.source.trim()) {
      return mobileJson({ error: 'source is required' }, { status: 400 });
    }
    try {
      if (body.action === 'start') {
        if (typeof body.workspacePath !== 'string') {
          return mobileJson({ error: 'workspacePath is required' }, { status: 400 });
        }
        const result = await getApplication().startImport(body.workspacePath, body.source);
        if (result.error) return mobileJson({ error: result.error }, { status: 409 });
      } else if (body.action === 'purge') await getApplication().purgeImport(body.source);
      else if (body.action === 'delete') await getApplication().deleteImport(body.source);
      else if (body.action === 'review') {
        if (body.verdict !== 'approve' && body.verdict !== 'reject') {
          return mobileJson({ error: 'verdict must be approve or reject' }, { status: 400 });
        }
        await getApplication().reviewImport(body.source, body.verdict);
      } else {
        return mobileJson(
          { error: 'action must be start, purge, delete, or review' },
          { status: 400 },
        );
      }
      return mobileJson({ ok: true });
    } catch (error) {
      return mobileJson(
        { error: error instanceof Error ? error.message : 'Import could not be updated.' },
        { status: 409 },
      );
    }
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
    const result = await getApplication().uploadImport({
      fileName: file.name,
      content: await file.text(),
      source: String(form?.get('source') ?? '').trim(),
      voice: String(form?.get('voice') ?? '') === '1',
      register: String(form?.get('register') ?? ''),
    });
    return mobileJson({ ok: true, destination: result.destination }, { status: 201 });
  } catch (error) {
    return mobileJson(
      { error: error instanceof Error ? error.message : 'Import could not be uploaded.' },
      { status: 409 },
    );
  }
}
