import { isAuthed } from '@/auth';
import { getApplication } from '@/lib/server';

/** Stream a Workspace artifact for owner download, gated on a real files row. */
export async function GET(req: Request) {
  if (!(await isAuthed())) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const path = new URL(req.url).searchParams.get('path') ?? '';
  const artifact = await getApplication().downloadArtifact(path);
  if (!artifact) return Response.json({ error: 'not found' }, { status: 404 });
  return new Response(new Uint8Array(artifact.bytes), {
    headers: {
      'content-type': artifact.contentType,
      'content-disposition': `attachment; filename="${artifact.filename}"`,
      'content-length': String(artifact.bytes.length),
    },
  });
}
