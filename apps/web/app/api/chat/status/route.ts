import { listMessages } from '@assistant/core';
import { tasks } from '@assistant/db';
import type { UIMessage } from 'ai';
import { eq } from 'drizzle-orm';
import { isAuthed } from '@/auth';
import { getDb } from '@/lib/server';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  if (!UUID_RE.test(conversationId) || !UUID_RE.test(taskId)) {
    return Response.json({ error: 'conversationId and taskId required' }, { status: 400 });
  }

  const db = getDb();
  const [task] = await db
    .select({ status: tasks.status, conversationId: tasks.conversationId })
    .from(tasks)
    .where(eq(tasks.id, taskId));
  if (!task || task.conversationId !== conversationId) {
    return Response.json({ error: 'task not found' }, { status: 404 });
  }

  const rows = await listMessages(db, conversationId);
  const messages: UIMessage[] = rows
    .filter((row) => row.role === 'user' || row.role === 'assistant')
    .map((row) => ({
      id: row.id,
      role: row.role as 'user' | 'assistant',
      parts: row.parts as UIMessage['parts'],
    }));

  return Response.json({ taskStatus: task.status, messages });
}
