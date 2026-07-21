import type { Db, TaskRow } from '@assistant/db';
import { tasks, toolCalls } from '@assistant/db';
import type { ModelMessage } from 'ai';
import { and, eq, sql } from 'drizzle-orm';
import { requestedDocumentReadIntent } from '../artifact-intent.js';

/** The latest owner-supplied Google Doc URL in the current user turn, if any. */
function sharedDocumentIntent(window: ModelMessage[]) {
  for (let i = window.length - 1; i >= 0; i -= 1) {
    const message = window[i];
    if (message?.role !== 'user' || typeof message.content !== 'string') continue;
    return requestedDocumentReadIntent(message.content);
  }
  return undefined;
}

/** Avoid repeatedly re-reading the same shared document on every chat turn. */
export async function unreadSharedDocumentIntent(db: Db, task: TaskRow, window: ModelMessage[]) {
  if (task.trust !== 'owner') return undefined;
  const intent = sharedDocumentIntent(window);
  if (!intent || !task.conversationId) return intent;
  const [alreadyRead] = await db
    .select({ id: toolCalls.id })
    .from(toolCalls)
    .innerJoin(tasks, eq(tasks.id, toolCalls.taskId))
    .where(
      and(
        eq(tasks.conversationId, task.conversationId),
        eq(toolCalls.toolName, intent.toolName),
        sql`${toolCalls.args}->>'documentId' = ${intent.documentId}`,
      ),
    )
    .limit(1);
  return alreadyRead ? undefined : intent;
}
