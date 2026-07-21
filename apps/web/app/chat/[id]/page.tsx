import { decodeMessageCursor, getAgent, listMessages } from '@assistant/core';
import { conversations, goals, models, tasks } from '@assistant/db';
import type { UIMessage } from 'ai';
import { and, count, eq, notInArray, sql } from 'drizzle-orm';
import { notFound } from 'next/navigation';
import { requireOwner } from '@/auth';
import { withApprovalStatuses } from '@/lib/chat-approval-parts';
import { chatNoticeMessage } from '@/lib/chat-notices';
import { getDb } from '@/lib/server';
import { ChatClient } from './chat-client';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TERMINAL_TASK_STATUSES = ['done', 'failed', 'cancelled'];

function goalIdFromMetadata(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
  const goalId = (metadata as Record<string, unknown>).goalId;
  return typeof goalId === 'string' && UUID_RE.test(goalId) ? goalId : undefined;
}

export default async function ChatConversationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ task?: string; cursor?: string; notice?: string; ask?: string }>;
}) {
  await requireOwner();
  const [{ id }, query] = await Promise.all([params, searchParams]);
  if (!UUID_RE.test(id)) notFound();

  const db = getDb();
  const agent = await getAgent(db);
  const [conversation] = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.id, id),
        eq(conversations.agentId, agent.id),
        eq(conversations.channel, 'chat'),
      ),
    );
  if (!conversation) notFound();

  const goalId = goalIdFromMetadata(conversation.metadata);
  const requestedTaskId = query.task && UUID_RE.test(query.task) ? query.task : undefined;
  const requestedCursor = decodeMessageCursor(query.cursor);
  const [rows, linkedGoal, requestedTask, activeTasks] = await Promise.all([
    listMessages(db, id),
    goalId
      ? db
          .select({ title: goals.title })
          .from(goals)
          .where(and(eq(goals.id, goalId), eq(goals.agentId, agent.id)))
          .then(([goal]) => goal)
      : Promise.resolve(undefined),
    requestedTaskId
      ? db
          .select({ id: tasks.id })
          .from(tasks)
          .where(and(eq(tasks.id, requestedTaskId), eq(tasks.conversationId, id)))
          .then(([task]) => task)
      : Promise.resolve(undefined),
    db
      .select({ value: count() })
      .from(tasks)
      .where(
        and(
          eq(tasks.agentId, agent.id),
          eq(tasks.conversationId, id),
          notInArray(tasks.status, TERMINAL_TASK_STATUSES),
        ),
      ),
  ]);
  const initialMessages = await withApprovalStatuses(
    db,
    rows
      .filter((row) => row.role === 'user' || row.role === 'assistant')
      .map((row) => ({
        id: row.id,
        role: row.role as 'user' | 'assistant',
        parts: row.parts as UIMessage['parts'],
      })),
  );

  // Embedding-only models can't chat — keep them out of the switcher.
  const enabledModels = await db
    .select({ id: models.id, label: models.label })
    .from(models)
    .where(
      and(
        eq(models.enabled, true),
        sql`${models.capabilities}->>'embedding' IS DISTINCT FROM 'true'`,
      ),
    )
    .orderBy(models.label);

  return (
    <ChatClient
      conversationId={conversation.id}
      title={conversation.title || 'Untitled'}
      initialMessages={initialMessages}
      models={enabledModels}
      modelOverride={conversation.modelOverride}
      goalTitle={linkedGoal?.title}
      archived={conversation.archivedAt !== null}
      canArchive={!conversation.isPrimary && (activeTasks[0]?.value ?? 0) === 0}
      initialNotice={chatNoticeMessage(query.notice)}
      initialInput={typeof query.ask === 'string' ? query.ask.slice(0, 500) : undefined}
      initialAsyncTurn={
        requestedTask && requestedCursor
          ? { taskId: requestedTask.id, cursor: query.cursor as string }
          : undefined
      }
    />
  );
}
