import { isAuthed } from '@/auth';
import { getApplication } from '@/lib/server';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 50;
/** Matches MAX_REFRESH_IDS in the application service — reject early, cheaply. */
const MAX_REFRESH_IDS = 10;

/**
 * Poll target for the open chat. `taskId` is optional: with one, the caller
 * also gets that task's status and live tool activity (an action turn waiting
 * on the executor); without one, this is the idle thread poll that picks up
 * whatever the assistant posted on its own — a schedule, a watch, an approval
 * resuming — instead of leaving it for the next page load.
 *
 * `refresh` carries the ids of decision cards the page is already showing, so
 * an approval resolved on another surface stops offering its buttons here
 * without waiting for a reload.
 */
export async function GET(req: Request) {
  if (!(await isAuthed())) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  const url = new URL(req.url);
  const conversationId = url.searchParams.get('conversationId') ?? '';
  const taskId = url.searchParams.get('taskId');
  const cursorValue = url.searchParams.get('cursor');
  const refreshValue = url.searchParams.get('refresh');
  if (!UUID_RE.test(conversationId)) {
    return Response.json({ error: 'conversationId required' }, { status: 400 });
  }
  if (taskId !== null && !UUID_RE.test(taskId)) {
    return Response.json({ error: 'invalid taskId' }, { status: 400 });
  }
  const refreshIds = refreshValue ? refreshValue.split(',').slice(0, MAX_REFRESH_IDS) : [];
  if (refreshIds.some((id) => !UUID_RE.test(id))) {
    return Response.json({ error: 'invalid refresh id' }, { status: 400 });
  }
  const application = getApplication();
  if (cursorValue && !application.isValidChatCursor(cursorValue)) {
    return Response.json({ error: 'invalid cursor' }, { status: 400 });
  }
  const status = await application.getChatUpdates({
    conversationId,
    ...(taskId ? { taskId } : {}),
    ...(cursorValue ? { cursor: cursorValue } : {}),
    ...(refreshIds.length ? { refreshIds } : {}),
    pageSize: PAGE_SIZE,
  });
  if (!status) {
    return Response.json({ error: 'not found' }, { status: 404 });
  }
  return Response.json(status);
}
