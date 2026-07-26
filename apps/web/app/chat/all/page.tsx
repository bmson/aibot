import { getAgent, listConversations } from '@assistant/core';
import { conversations, tasks } from '@assistant/db';
import { and, count, eq, isNotNull, isNull, notInArray } from 'drizzle-orm';
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
  const [chatRows, archivedCountRows, shownScopeCountRows, activeTaskRows] = await Promise.all([
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
    // listConversations caps at 50. Count the same scope so a truncated list
    // says so instead of silently looking like the whole history.
    db
      .select({ value: count() })
      .from(conversations)
      .where(
        and(
          eq(conversations.agentId, agent.id),
          eq(conversations.channel, 'chat'),
          archived ? isNotNull(conversations.archivedAt) : isNull(conversations.archivedAt),
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
  const totalInScope = shownScopeCountRows[0]?.value ?? chatRows.length;
  const now = new Date();

  return (
    <PageShell size="reading">
      {/* The primary action rides with the title; the housekeeping ones sit in
          their own row beneath. All three in one wrapping row put "New chat"
          wherever the long "Archive inactive chats" label happened to leave a
          gap, which on a phone was its own ragged third line. */}
      <PageHeader
        title={archived ? 'Archived chats' : 'All chats'}
        intro={
          archived
            ? 'Archived chats stay intact and can be restored at any time.'
            : 'Your main thread brings older topics back when they become relevant.'
        }
        actions={
          <form action={newConversation}>
            <SubmitButton variant="primary" pendingLabel="Creating…">
              New chat
            </SubmitButton>
          </form>
        }
      />
      <div className="mt-5 flex flex-wrap items-center gap-2">
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
      </div>
      {chatRows.length === 0 ? (
        <EmptyState>
          {archived ? 'No archived chats.' : 'No chats yet — start one with “New chat”.'}
        </EmptyState>
      ) : (
        <>
          {totalInScope > chatRows.length ? (
            <p className="mt-6 text-xs text-muted">
              Showing the {chatRows.length} most recent of {totalInScope} chats. Archiving inactive
              chats trims this list.
            </p>
          ) : null}
          {/* One card holding divided rows, the same shape the Activity list
              uses — fifty separate slabs made a plain list of chats look far
              heavier than it is, and gave the scroll-reveal fifty animations to
              drive instead of one. */}
          <ul className={`${cardShellClass} mt-6`}>
            {chatRows.map((conversation, index) => (
              <li
                key={conversation.id}
                className={`grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 p-2 ${
                  index > 0 ? 'border-t border-edge' : ''
                }`}
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
                    <SubmitButton size="sm" variant="outline" pendingLabel="Restoring…">
                      Restore
                    </SubmitButton>
                  </form>
                ) : activeConversationIds.has(conversation.id) ? null : (
                  <form action={archiveConversation.bind(null, conversation.id)}>
                    <SubmitButton size="sm" variant="outline" pendingLabel="Archiving…">
                      Archive
                    </SubmitButton>
                  </form>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </PageShell>
  );
}
