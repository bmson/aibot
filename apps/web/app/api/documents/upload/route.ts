import { isModuleEnabled, loadConfig } from '@assistant/config';
import { redirect } from 'next/navigation';
import { isAuthed } from '@/auth';
import { getApplication } from '@/lib/server';

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // Cloud Run request cap is 32MB — stay under it
const MAX_MULTIPART_BYTES = MAX_UPLOAD_BYTES + 1024 * 1024;

/**
 * Document upload (Phase 11): multipart form → binary workspace write → a
 * `documents` row plus a resumable extraction job. Unlike the backstory import
 * route this reads the raw bytes (PDFs, not just UTF-8 archives).
 */
export async function POST(req: Request) {
  if (!isModuleEnabled(loadConfig(), 'documents')) {
    return Response.json({ error: 'documents module disabled' }, { status: 404 });
  }
  if (!(await isAuthed())) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  const contentLength = Number(req.headers.get('content-length') ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_MULTIPART_BYTES) {
    return Response.json({ error: 'file too large for upload' }, { status: 413 });
  }

  const form = await req.formData().catch(() => null);
  if (!form) return Response.json({ error: 'invalid multipart form' }, { status: 400 });
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return Response.json({ error: 'no file uploaded' }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return Response.json({ error: 'file too large for upload' }, { status: 413 });
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  await getApplication().uploadDocument({
    name: file.name,
    title: String(form.get('title') ?? ''),
    mime: file.type,
    bytes,
  });

  redirect('/documents');
}
