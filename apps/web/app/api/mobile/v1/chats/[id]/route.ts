import { getApplication } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const { id } = await params;
  if (!UUID_RE.test(id)) return mobileJson({ error: 'invalid chat id' }, { status: 400 });
  const conversation = await getApplication().getChatConversation(id, {});
  return conversation
    ? mobileJson(conversation)
    : mobileJson({ error: 'chat not found' }, { status: 404 });
}

/** Archive, restore, and model selection use the same chat commands as the web UI. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const { id } = await params;
  if (!UUID_RE.test(id)) return mobileJson({ error: 'invalid chat id' }, { status: 400 });
  const body = (await request.json().catch(() => null)) as {
    action?: unknown;
    modelId?: unknown;
  } | null;
  try {
    if (body?.action === 'archive') {
      const result = await getApplication().archiveChat(id);
      if (result === 'primary') {
        return mobileJson({ error: 'The main chat cannot be archived.' }, { status: 409 });
      }
      if (result === 'active') {
        return mobileJson(
          { error: 'Finish or cancel active work before archiving this chat.' },
          { status: 409 },
        );
      }
    } else if (body?.action === 'restore') {
      await getApplication().restoreChat(id);
    } else if (body?.action === 'change-model') {
      if (body.modelId !== null && typeof body.modelId !== 'string') {
        return mobileJson({ error: 'modelId must be a string or null' }, { status: 400 });
      }
      await getApplication().changeChatModel(id, body.modelId ?? null);
    } else {
      return mobileJson(
        { error: 'action must be archive, restore, or change-model' },
        { status: 400 },
      );
    }
    return mobileJson({ ok: true });
  } catch (error) {
    return mobileJson(
      { error: error instanceof Error ? error.message : 'Chat could not be updated.' },
      { status: 409 },
    );
  }
}
