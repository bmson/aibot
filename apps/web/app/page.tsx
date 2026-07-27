import { redirect } from 'next/navigation';
import { requireOwner } from '@/auth';
import { getApplication } from '@/lib/server';

export const dynamic = 'force-dynamic';

/**
 * Chat is the front door to the assistant. Keep `/` as a stable external
 * entry point, but do not interpose a dashboard before the conversation.
 */
export default async function IndexPage() {
  await requireOwner();
  redirect(`/chat/${await getApplication().getPrimaryConversationId()}`);
}
