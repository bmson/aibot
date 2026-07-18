import { getAgent, listConversations } from '@assistant/core';
import { conversations, tasks } from '@assistant/db';
import { and, count, eq, isNotNull, notInArray } from 'drizzle-orm';
import Link from 'next/link';
import { requireOwner } from '@/auth';
import { relativeTime } from '@/lib/format';
import { getDb } from '@/lib/server';
import { btn, EmptyState } from '@/lib/ui';
import {
  archiveConversation,
  archiveInactiveConversations,
  newConversation,
  restoreConversation,
} from './actions';

export const dynamic = 'force-dynamic';

const TERMINAL_TASK_STATUSES = ['done', 'failed', 'cancelled'];

export default async function ChatListPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  await requireOwner();
  const { view } = await searchParams;
  const archived = view === 'archived';
  const db = getDb();
  const agent = await getAgent(db);
  const [chatRows, archivedCountRows, activeTaskRows] = await Promise.all([
    listConversations(db, agent.id, { archived }),
    db
      .select({ value: count() })
      .from(conversations)
      .where(
        and(
          eq(conversations.agentId, agent.id),
          eq(conversations.channel, 'chat'),
          isNotNull(conversations.archivedAt),
        ),
      ),
    db
      .selectDistinct({ conversationId: tasks.conversationId })
      .from(tasks)
      .where(
        and(
          eq(tasks.agentId, agent.id),
          isNotNull(tasks.conversationId),
          notInArray(tasks.status, TERMINAL_TASK_STATUSES),
        ),
      ),
  ]);
  const activeConversationIds = new Set(
    activeTaskRows
      .map((task) => task.conversationId)
      .filter((conversationId): conversationId is string => conversationId !== null),
  );
  const archivedCount = archivedCountRows[0]?.value ?? 0;
  const now = new Date();

  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{archived ? 'Archived chats' : 'Chats'}</h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            {archived
              ? 'Archived chats are kept intact and can be restored at any time.'
              : 'Archive finished chats to keep this list focused. Nothing is deleted.'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {archived ? (
            <Link href="/chat" className={btn.outline}>
              Current chats
            </Link>
          ) : (
            <>
              {archivedCount > 0 ? (
                <Link href="/chat?view=archived" className={btn.outline}>
                  Archived ({archivedCount})
                </Link>
              ) : null}
              <form action={archiveInactiveConversations}>
                <button type="submit" className={btn.outline}>
                  Archive inactive chats (30+ days)
                </button>
              </form>
            </>
          )}
          <form action={newConversation}>
            <button type="submit" className={btn.primary}>
              New chat
            </button>
          </form>
        </div>
      </div>
      {chatRows.length === 0 ? (
        <EmptyState>
          {archived ? 'No archived chats.' : 'No chats yet — start one with “New chat”.'}
        </EmptyState>
      ) : (
        <ul className="mt-6 flex flex-col gap-1">
          {chatRows.map((conversation) => (
            <li key={conversation.id} className="flex items-center gap-2">
              <Link
                href={`/chat/${conversation.id}`}
                className="flex min-w-0 flex-1 items-baseline justify-between rounded-md px-3 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-900"
              >
                <span className="truncate">{conversation.title || 'Untitled'}</span>
                <span className="ml-4 shrink-0 text-xs text-zinc-500 dark:text-zinc-500">
                  {relativeTime(conversation.updatedAt, now)}
                </span>
              </Link>
              {archived ? (
                <form action={restoreConversation.bind(null, conversation.id)}>
                  <button type="submit" className={btn.outline}>
                    Restore
                  </button>
                </form>
              ) : activeConversationIds.has(conversation.id) ? (
                <span className="shrink-0 text-xs text-zinc-500 dark:text-zinc-500">
                  Work active
                </span>
              ) : (
                <form action={archiveConversation.bind(null, conversation.id)}>
                  <button type="submit" className={btn.outline}>
                    Archive
                  </button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
