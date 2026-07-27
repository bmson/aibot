import { redirect } from 'next/navigation';
import { isAuthed } from '@/auth';
import { getApplication } from '@/lib/server';

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // Cloud Run request cap is 32MB — stay under it
const MAX_MULTIPART_BYTES = MAX_UPLOAD_BYTES + 1024 * 1024; // form fields + MIME boundary overhead

/**
 * Backstory archive upload: multipart form → immutable workspace upload →
 * import source + resumable job task. Bigger archives should be copied into
 * the bucket's import/ prefix directly (gcloud storage cp) and started from
 * the dashboard list instead.
 */
export async function POST(req: Request) {
  if (!(await isAuthed())) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  const contentLength = Number(req.headers.get('content-length') ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_MULTIPART_BYTES) {
    return Response.json(
      { error: 'file too large for upload — copy it into the workspace import/ prefix instead' },
      { status: 413 },
    );
  }

  const form = await req.formData().catch(() => null);
  if (!form) return Response.json({ error: 'invalid multipart form' }, { status: 400 });
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return Response.json({ error: 'no file uploaded' }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return Response.json(
      { error: 'file too large for upload — copy it into the workspace import/ prefix instead' },
      { status: 413 },
    );
  }

  const labelField = String(form.get('source') ?? '').trim();
  // Voice uploads seed the writing-sample corpus instead of memory; the Profile
  // page posts here with voice=1 and a register.
  const isVoice = String(form.get('voice') ?? '') === '1';

  const content = await file.text();
  const result = await getApplication().uploadImport({
    fileName: file.name,
    content,
    source: labelField,
    voice: isVoice,
    register: String(form.get('register') ?? ''),
  });

  redirect(result.destination);
}
