import { getAgent, listConversations } from '@assistant/core';
import Link from 'next/link';
import { requireOwner } from '@/auth';
import { getDb } from '@/lib/server';
import { newConversation } from './actions';

export const dynamic = 'force-dynamic';

function relativeTime(date: Date): string {
  const minutes = Math.round((Date.now() - date.getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default async function ChatListPage() {
  await requireOwner();
  const db = getDb();
  const agent = await getAgent(db);
  const conversations = await listConversations(db, agent.id);

  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Chat</h1>
        <form action={newConversation}>
          <button
            type="submit"
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            New chat
          </button>
        </form>
      </div>
      {conversations.length === 0 ? (
        <p className="mt-6 text-sm text-zinc-500 dark:text-zinc-400">
          No conversations yet — start one with “New chat”.
        </p>
      ) : (
        <ul className="mt-6 flex flex-col gap-1">
          {conversations.map((conversation) => (
            <li key={conversation.id}>
              <Link
                href={`/chat/${conversation.id}`}
                className="flex items-baseline justify-between rounded-md px-3 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-900"
              >
                <span className="truncate">{conversation.title || 'Untitled'}</span>
                <span className="ml-4 shrink-0 text-xs text-zinc-500 dark:text-zinc-500">
                  {relativeTime(conversation.updatedAt)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
