import { isAuthed } from '@/auth';
import { getApplication } from '@/lib/server';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 50;

/**
 * Poll target for async chat turns: the executor persists its answer (or an
 * approval/budget notice) into the conversation; the client re-syncs the
 * thread from here until the task settles.
 */
export async function GET(req: Request) {
  if (!(await isAuthed())) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  const url = new URL(req.url);
  const conversationId = url.searchParams.get('conversationId') ?? '';
  const taskId = url.searchParams.get('taskId') ?? '';
  const cursorValue = url.searchParams.get('cursor');
  if (!UUID_RE.test(conversationId) || !UUID_RE.test(taskId)) {
    return Response.json({ error: 'conversationId and taskId required' }, { status: 400 });
  }
  const application = getApplication();
  if (cursorValue && !application.isValidChatCursor(cursorValue)) {
    return Response.json({ error: 'invalid cursor' }, { status: 400 });
  }
  const status = await application.getChatTaskStatus({
    conversationId,
    taskId,
    ...(cursorValue ? { cursor: cursorValue } : {}),
    pageSize: PAGE_SIZE,
  });
  if (!status) {
    return Response.json({ error: 'task not found' }, { status: 404 });
  }
  return Response.json(status);
}
