import { getAgent, getOrCreatePrimaryConversation } from '@assistant/core';
import { requireOwner } from '@/auth';
import { getDb } from '@/lib/server';
import { type ChatPageQuery, renderChatConversation } from './conversation-page';

export const dynamic = 'force-dynamic';

/**
 * The single long-running thread is the default chat experience (Phase 3 of the
 * long-running-chat design): /chat renders the one canonical primary thread at
 * a clean, stable URL. The full list of threads stays reachable at /chat/all.
 */
export default async function ChatIndexPage({
  searchParams,
}: {
  searchParams: Promise<ChatPageQuery>;
}) {
  await requireOwner();
  const db = getDb();
  const agent = await getAgent(db);
  const primary = await getOrCreatePrimaryConversation(db, agent.id);
  return renderChatConversation(primary.id, await searchParams);
}
