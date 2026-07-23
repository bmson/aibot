import { getAgent } from '@assistant/core';
import { files } from '@assistant/db';
import { and, eq } from 'drizzle-orm';
import { isAuthed } from '@/auth';
import { getDb, getWorkspace } from '@/lib/server';

// Only artifacts the bot produces — never profile/secrets. The files-row check
// below is the authoritative owner gate; this is defense in depth.
const SAFE_PREFIXES = ['code/', 'browser/attachments/', 'documents/'];

/** Stream a Workspace artifact for owner download, gated on a real files row. */
export async function GET(req: Request) {
  if (!(await isAuthed())) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const path = new URL(req.url).searchParams.get('path') ?? '';
  if (!SAFE_PREFIXES.some((p) => path.startsWith(p))) {
    return Response.json({ error: 'forbidden' }, { status: 403 });
  }
  const db = getDb();
  const agent = await getAgent(db);
  const [row] = await db
    .select()
    .from(files)
    .where(and(eq(files.agentId, agent.id), eq(files.workspacePath, path)))
    .limit(1);
  if (!row) return Response.json({ error: 'not found' }, { status: 404 });

  const bytes = await getWorkspace()
    .readBytes(path)
    .catch(() => null);
  if (!bytes) return Response.json({ error: 'not found' }, { status: 404 });
  const filename = (path.split('/').pop() ?? 'file').replace(/[\r\n"]/g, '_');
  return new Response(new Uint8Array(bytes), {
    headers: {
      'content-type': row.mime || 'application/octet-stream',
      'content-disposition': `attachment; filename="${filename}"`,
      'content-length': String(bytes.length),
    },
  });
}
