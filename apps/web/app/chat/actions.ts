'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { isAuthed } from '@/auth';
import { getApplication } from '@/lib/server';

function revalidateChatViews(conversationId?: string): void {
  revalidatePath('/chat');
  revalidatePath('/chat/all');
  if (conversationId) revalidatePath(`/chat/${conversationId}`);
}

export async function newConversation(): Promise<void> {
  if (!(await isAuthed())) throw new Error('unauthorized');
  redirect(`/chat/${await getApplication().createChat()}`);
}

/** Composer `/model` command — modelId null means "Auto (role default)". */
export async function changeConversationModel(
  conversationId: string,
  modelId: string | null,
): Promise<void> {
  if (!(await isAuthed())) throw new Error('unauthorized');
  await getApplication().changeChatModel(conversationId, modelId);
  revalidatePath(`/chat/${conversationId}`);
}

/** Hide a finished chat without erasing its messages or task evidence. */
export async function archiveConversation(conversationId: string): Promise<void> {
  if (!(await isAuthed())) throw new Error('unauthorized');
  const result = await getApplication().archiveChat(conversationId);
  if (result === 'primary') {
    // The primary thread is intentionally permanent. Treat a stale form
    // submission as an idempotent no-op instead of surfacing a generic RSC 500.
    redirect(`/chat/${conversationId}`);
  }
  if (result === 'active') {
    // The archive button can race with work starting after the page rendered.
    // Redirect with an inline explanation instead of turning that safe refusal
    // into Next's generic server-action error page.
    redirect(`/chat/${conversationId}?notice=archive-active`);
  }
  revalidateChatViews(conversationId);
  redirect('/chat/all');
}

/** Restore a chat to the current list. Its messages and evidence were never removed. */
export async function restoreConversation(conversationId: string): Promise<void> {
  if (!(await isAuthed())) throw new Error('unauthorized');
  await getApplication().restoreChat(conversationId);
  revalidateChatViews(conversationId);
  redirect(`/chat/${conversationId}`);
}

/**
 * A conservative tidy-up: only chats quiet for 30+ days and with no unfinished
 * work are archived. Nothing is deleted and current work stays visible.
 */
export async function archiveInactiveConversations(): Promise<void> {
  if (!(await isAuthed())) throw new Error('unauthorized');
  await getApplication().archiveInactiveChats();
  revalidateChatViews();
  redirect('/chat/all');
}
