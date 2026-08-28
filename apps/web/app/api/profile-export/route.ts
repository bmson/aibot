import { isAuthed } from '@/auth';
import { getApplication } from '@/lib/server';

/** Download the owner's long-term recall and writing-voice data as portable JSON. */
export async function GET() {
  if (!(await isAuthed())) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const payload = await getApplication().exportLongTermMemoryData();
  const filename = `assistant-long-term-memory-${new Date().toISOString().slice(0, 10)}.json`;
  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
    },
  });
}
