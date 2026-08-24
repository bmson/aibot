import { getApplication } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

/** Create a conversation or run the same history cleanup offered by the web chat index. */
export async function POST(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const body = (await request.json().catch(() => null)) as { action?: unknown } | null;
  try {
    if (body?.action === 'create') {
      const conversationId = await getApplication().createChat();
      return mobileJson({ conversationId }, { status: 201 });
    }
    if (body?.action === 'archive-inactive') {
      const archived = await getApplication().archiveInactiveChats();
      return mobileJson({ ok: true, archived });
    }
    return mobileJson({ error: 'action must be create or archive-inactive' }, { status: 400 });
  } catch (error) {
    return mobileJson(
      { error: error instanceof Error ? error.message : 'Chats could not be updated.' },
      { status: 409 },
    );
  }
}
