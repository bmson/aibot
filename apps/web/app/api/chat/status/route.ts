import { decodeMessageCursor, encodeMessageCursor, listMessages } from '@assistant/core';
import { tasks } from '@assistant/db';
import type { UIMessage } from 'ai';
import { eq } from 'drizzle-orm';
import { isAuthed } from '@/auth';
import { withApprovalStatuses } from '@/lib/chat-approval-parts';
import { getDb } from '@/lib/server';

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
  const cursor = decodeMessageCursor(cursorValue);
  if (!UUID_RE.test(conversationId) || !UUID_RE.test(taskId)) {
    return Response.json({ error: 'conversationId and taskId required' }, { status: 400 });
  }
  if (cursorValue && !cursor) {
    return Response.json({ error: 'invalid cursor' }, { status: 400 });
  }

  const db = getDb();
  const [task] = await db
    .select({ status: tasks.status, conversationId: tasks.conversationId })
    .from(tasks)
    .where(eq(tasks.id, taskId));
  if (!task || task.conversationId !== conversationId) {
    return Response.json({ error: 'task not found' }, { status: 404 });
  }

  const rows = await listMessages(db, conversationId, {
    ...(cursor ? { after: cursor } : {}),
    limit: cursor ? PAGE_SIZE + 1 : PAGE_SIZE,
  });
  const hasMore = Boolean(cursor && rows.length > PAGE_SIZE);
  const page = rows.slice(0, PAGE_SIZE);
  const messages = await withApprovalStatuses(
    db,
    page
      .filter((row) => row.role === 'user' || row.role === 'assistant')
      .map((row) => ({
        id: row.id,
        role: row.role as 'user' | 'assistant',
        parts: row.parts as UIMessage['parts'],
      })),
  );

  const last = page.at(-1);
  const nextCursor = last ? encodeMessageCursor(last) : cursor ? encodeMessageCursor(cursor) : null;
  return Response.json({ taskStatus: task.status, messages, nextCursor, hasMore });
}
