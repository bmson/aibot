import { getAgent, getOrCreatePrimaryConversation } from '@assistant/core';
import { redirect } from 'next/navigation';
import { requireOwner } from '@/auth';
import { getDb } from '@/lib/server';

export const dynamic = 'force-dynamic';

/**
 * Chat is the front door to the assistant. Keep `/` as a stable external
 * entry point, but do not interpose a dashboard before the conversation.
 */
export default async function IndexPage() {
  await requireOwner();
  const db = getDb();
  const agent = await getAgent(db);
  const primary = await getOrCreatePrimaryConversation(db, agent.id);
  redirect(`/chat/${primary.id}`);
}
