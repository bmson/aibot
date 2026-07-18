import { getAgent, getOrCreatePrimaryConversation } from '@assistant/core';
import { redirect } from 'next/navigation';
import { requireOwner } from '@/auth';
import { getDb } from '@/lib/server';

export const dynamic = 'force-dynamic';

/**
 * The single long-running thread is the default chat experience (Phase 3 of the
 * long-running-chat design): /chat opens the one canonical primary thread. The
 * full list of threads stays reachable at /chat/all.
 */
export default async function ChatIndexPage() {
  await requireOwner();
  const db = getDb();
  const agent = await getAgent(db);
  const primary = await getOrCreatePrimaryConversation(db, agent.id);
  redirect(`/chat/${primary.id}`);
}
