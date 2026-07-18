import { detectKind, getAgent, startImport } from '@assistant/core';
import { safeRelPath } from '@assistant/tools';
import { redirect } from 'next/navigation';
import { isAuthed } from '@/auth';
import { getDb, getWorkspace } from '@/lib/server';

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // Cloud Run request cap is 32MB — stay under it
const MAX_MULTIPART_BYTES = MAX_UPLOAD_BYTES + 1024 * 1024; // form fields + MIME boundary overhead

/**
 * Backstory archive upload: multipart form → workspace import/<name> →
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

  const cleanName = file.name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'archive.txt';
  const workspacePath = safeRelPath(`import/${cleanName}`);
  const sourceTag =
    String(form.get('source') ?? '').trim() || cleanName.replace(/\.[a-z0-9]+$/i, '').toLowerCase();

  const content = await file.text();
  await getWorkspace().write(workspacePath, content);

  const db = getDb();
  const agent = await getAgent(db);
  await startImport(db, {
    agentId: agent.id,
    source: sourceTag,
    workspacePath,
    kind: detectKind(cleanName, content.slice(0, 4000)),
  });

  redirect('/import');
}
