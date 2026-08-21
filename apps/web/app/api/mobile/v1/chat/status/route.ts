import { getApplication } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 50;
const MAX_REFRESH_IDS = 10;

export async function GET(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const url = new URL(request.url);
  const conversationId = url.searchParams.get('conversationId') ?? '';
  const taskId = url.searchParams.get('taskId');
  const cursor = url.searchParams.get('cursor');
  const refresh = url.searchParams.get('refresh');

  if (!UUID_RE.test(conversationId)) {
    return mobileJson({ error: 'conversationId required' }, { status: 400 });
  }
  if (taskId !== null && !UUID_RE.test(taskId)) {
    return mobileJson({ error: 'invalid taskId' }, { status: 400 });
  }
  const refreshIds = refresh ? refresh.split(',').slice(0, MAX_REFRESH_IDS) : [];
  if (refreshIds.some((id) => !UUID_RE.test(id))) {
    return mobileJson({ error: 'invalid refresh id' }, { status: 400 });
  }

  const application = getApplication();
  if (cursor && !application.isValidChatCursor(cursor)) {
    return mobileJson({ error: 'invalid cursor' }, { status: 400 });
  }
  const status = await application.getChatUpdates({
    conversationId,
    ...(taskId ? { taskId } : {}),
    ...(cursor ? { cursor } : {}),
    ...(refreshIds.length > 0 ? { refreshIds } : {}),
    pageSize: PAGE_SIZE,
  });
  return status
    ? mobileJson(status)
    : mobileJson({ error: 'conversation not found' }, { status: 404 });
}
