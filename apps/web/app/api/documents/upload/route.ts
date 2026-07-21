import { createHash, randomUUID } from 'node:crypto';
import { getAgent, startDocumentIngest } from '@assistant/core';
import { safeRelPath } from '@assistant/tools';
import { redirect } from 'next/navigation';
import { isAuthed } from '@/auth';
import { getDb, getWorkspace } from '@/lib/server';

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // Cloud Run request cap is 32MB — stay under it
const MAX_MULTIPART_BYTES = MAX_UPLOAD_BYTES + 1024 * 1024;

function cleanName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'document';
}

/**
 * Document upload (Phase 11): multipart form → binary workspace write → a
 * `documents` row plus a resumable extraction job. Unlike the backstory import
 * route this reads the raw bytes (PDFs, not just UTF-8 archives).
 */
export async function POST(req: Request) {
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

  const name = cleanName(file.name);
  const bytes = Buffer.from(await file.arrayBuffer());
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const mime = file.type || 'application/octet-stream';
  const workspacePath = safeRelPath(`documents/uploads/${randomUUID()}-${name}`);
  const title = String(form.get('title') ?? '').trim() || name;

  const workspace = getWorkspace();
  const db = getDb();
  const agent = await getAgent(db);

  await workspace.writeBytes(workspacePath, bytes, mime);
  let duplicate = false;
  try {
    const result = await startDocumentIngest(db, {
      agentId: agent.id,
      title,
      workspacePath,
      mime,
      bytes: bytes.length,
      sha256,
      source: 'upload',
      trust: 'owner',
    });
    duplicate = result.duplicate;
  } catch (err) {
    await workspace.delete(workspacePath).catch(() => {});
    throw err;
  }
  // A duplicate upload points at an existing document — drop the redundant blob.
  if (duplicate) await workspace.delete(workspacePath).catch(() => {});

  redirect('/documents');
}
