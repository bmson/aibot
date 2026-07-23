import { getAgent, listConversations } from '@assistant/core';
import { conversations, tasks } from '@assistant/db';
import { and, count, eq, isNotNull, notInArray } from 'drizzle-orm';
import { MessageSquareText } from 'lucide-react';
import Link from 'next/link';
import { requireOwner } from '@/auth';
import { relativeTime } from '@/lib/format';
import { getDb } from '@/lib/server';
import { btn, cardShellClass, EmptyState, PageHeader, PageShell } from '@/lib/ui';
import { SubmitButton } from '@/lib/ui-client';
import {
  archiveConversation,
  archiveInactiveConversations,
  newConversation,
  restoreConversation,
} from '../actions';

export const metadata = { title: 'All chats' };

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
    <PageShell size="reading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeader
          title={archived ? 'Archived chats' : 'All chats'}
          intro={
            archived
              ? 'Archived chats stay intact and can be restored at any time.'
              : 'Your main thread brings older topics back when they become relevant.'
          }
        />
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/chat" className={btn.outline}>
            Main thread
          </Link>
          {archived ? (
            <Link href="/chat/all" className={btn.outline}>
              Current chats
            </Link>
          ) : (
            <>
              {archivedCount > 0 ? (
                <Link href="/chat/all?view=archived" className={btn.outline}>
                  Archived ({archivedCount})
                </Link>
              ) : null}
              <form action={archiveInactiveConversations}>
                <SubmitButton variant="outline" pendingLabel="Archiving…">
                  Archive inactive chats (30+ days)
                </SubmitButton>
              </form>
            </>
          )}
          <form action={newConversation}>
            <SubmitButton variant="primary" pendingLabel="Creating…">
              New chat
            </SubmitButton>
          </form>
        </div>
      </div>
      {chatRows.length === 0 ? (
        <EmptyState>
          {archived ? 'No archived chats.' : 'No chats yet — start one with “New chat”.'}
        </EmptyState>
      ) : (
        <ul className="mt-6 grid gap-3">
          {chatRows.map((conversation) => (
            <li
              key={conversation.id}
              className={`${cardShellClass} grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 p-2`}
            >
              <Link
                href={`/chat/${conversation.id}`}
                data-mobile-touch-target="true"
                className={`mobile-touch-target flex min-w-0 items-center gap-3 rounded-xl px-2 py-2 motion-safe:transition-colors hover:bg-sunken/65 ${
                  conversation.isPrimary ? 'col-span-2' : ''
                }`}
              >
                <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-sunken text-muted">
                  <MessageSquareText className="size-4" aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-[14px] font-semibold">
                      {conversation.title && conversation.title !== 'Untitled'
                        ? conversation.title
                        : 'New conversation'}
                    </span>
                    {conversation.isPrimary ? (
                      <span className="shrink-0 rounded-full bg-indigo-100 px-1.5 py-0.5 text-2xs font-semibold tracking-wide text-indigo-700 uppercase dark:bg-indigo-950 dark:text-indigo-300">
                        Main
                      </span>
                    ) : activeConversationIds.has(conversation.id) ? (
                      <span className="shrink-0 rounded-full bg-blue-100 px-1.5 py-0.5 text-2xs font-medium text-blue-700 dark:bg-blue-950 dark:text-blue-300">
                        Work active
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted">
                    Last active {relativeTime(conversation.updatedAt, now)}
                  </span>
                </span>
              </Link>
              {conversation.isPrimary ? null : archived ? (
                <form action={restoreConversation.bind(null, conversation.id)}>
                  <SubmitButton
                    variant="outline"
                    pendingLabel="Restoring…"
                    className="h-8 px-3 text-xs"
                  >
                    Restore
                  </SubmitButton>
                </form>
              ) : activeConversationIds.has(conversation.id) ? null : (
                <form action={archiveConversation.bind(null, conversation.id)}>
                  <SubmitButton
                    variant="outline"
                    pendingLabel="Archiving…"
                    className="h-8 px-3 text-xs"
                  >
                    Archive
                  </SubmitButton>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
    </PageShell>
  );
}
