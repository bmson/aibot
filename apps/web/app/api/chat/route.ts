import { isAuthed } from '@/auth';
import { getApplication } from '@/lib/server';

export async function POST(request: Request): Promise<Response> {
  if (!(await isAuthed())) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  return getApplication().handleChatTurn(request);
}
