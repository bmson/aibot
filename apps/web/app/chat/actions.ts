'use server';

import { ensureChatConversation, getAgent, setConversationModel } from '@assistant/core';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { isAuthed } from '@/auth';
import { getDb } from '@/lib/server';

export async function newConversation(): Promise<void> {
  if (!(await isAuthed())) throw new Error('unauthorized');
  const db = getDb();
  const agent = await getAgent(db);
  const conversation = await ensureChatConversation(db, agent.id);
  redirect(`/chat/${conversation.id}`);
}

/** Chat header model switcher — modelId null means "Auto (role default)". */
export async function changeConversationModel(
  conversationId: string,
  modelId: string | null,
): Promise<void> {
  if (!(await isAuthed())) throw new Error('unauthorized');
  await setConversationModel(getDb(), conversationId, modelId);
  revalidatePath(`/chat/${conversationId}`);
}
