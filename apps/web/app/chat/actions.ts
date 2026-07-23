'use server';

import { ensureChatConversation, getAgent, setConversationModel } from '@assistant/core';
import { conversations, tasks } from '@assistant/db';
import { and, desc, eq, isNotNull, isNull, lt, notInArray } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { isAuthed } from '@/auth';
import { getDb } from '@/lib/server';

const TERMINAL_TASK_STATUSES = ['done', 'failed', 'cancelled'];
const ARCHIVE_AFTER_DAYS = 30;

function revalidateChatViews(conversationId?: string): void {
  revalidatePath('/chat');
  revalidatePath('/chat/all');
  if (conversationId) revalidatePath(`/chat/${conversationId}`);
}

async function requireOwnedChat(conversationId: string) {
  const db = getDb();
  const agent = await getAgent(db);
  const [conversation] = await db
    .select({ id: conversations.id, isPrimary: conversations.isPrimary })
    .from(conversations)
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.agentId, agent.id),
        eq(conversations.channel, 'chat'),
      ),
    );
  if (!conversation) throw new Error('chat not found');
  return { db, agent, conversation };
}

export async function newConversation(): Promise<void> {
  if (!(await isAuthed())) throw new Error('unauthorized');
  const db = getDb();
  const agent = await getAgent(db);
  const conversation = await ensureChatConversation(db, agent.id);
  redirect(`/chat/${conversation.id}`);
}

/** Composer `/model` command — modelId null means "Auto (role default)". */
export async function changeConversationModel(
  conversationId: string,
  modelId: string | null,
): Promise<void> {
  if (!(await isAuthed())) throw new Error('unauthorized');
  await setConversationModel(getDb(), conversationId, modelId);
  revalidatePath(`/chat/${conversationId}`);
}

/** Hide a finished chat without erasing its messages or task evidence. */
export async function archiveConversation(conversationId: string): Promise<void> {
  if (!(await isAuthed())) throw new Error('unauthorized');
  const { db, agent, conversation } = await requireOwnedChat(conversationId);
  if (conversation.isPrimary) {
    // The primary thread is intentionally permanent. Treat a stale form
    // submission as an idempotent no-op instead of surfacing a generic RSC 500.
    redirect(`/chat/${conversation.id}`);
  }
  const [activeTask] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.agentId, agent.id),
        eq(tasks.conversationId, conversation.id),
        notInArray(tasks.status, TERMINAL_TASK_STATUSES),
      ),
    )
    .limit(1);
  if (activeTask) {
    // The archive button can race with work starting after the page rendered.
    // Redirect with an inline explanation instead of turning that safe refusal
    // into Next's generic server-action error page.
    redirect(`/chat/${conversation.id}?notice=archive-active`);
  }

  await db
    .update(conversations)
    .set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(conversations.id, conversation.id), isNull(conversations.archivedAt)));
  revalidateChatViews(conversation.id);
  redirect('/chat/all');
}

/** Restore a chat to the current list. Its messages and evidence were never removed. */
export async function restoreConversation(conversationId: string): Promise<void> {
  if (!(await isAuthed())) throw new Error('unauthorized');
  const { db, conversation } = await requireOwnedChat(conversationId);
  await db
    .update(conversations)
    .set({ archivedAt: null, updatedAt: new Date() })
    .where(and(eq(conversations.id, conversation.id), isNotNull(conversations.archivedAt)));
  revalidateChatViews(conversation.id);
  redirect(`/chat/${conversation.id}`);
}

/**
 * A conservative tidy-up: only chats quiet for 30+ days and with no unfinished
 * work are archived. Nothing is deleted and current work stays visible.
 */
export async function archiveInactiveConversations(): Promise<void> {
  if (!(await isAuthed())) throw new Error('unauthorized');
  const db = getDb();
  const agent = await getAgent(db);
  const cutoff = new Date(Date.now() - ARCHIVE_AFTER_DAYS * 24 * 60 * 60 * 1000);
  const candidates = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.agentId, agent.id),
        eq(conversations.channel, 'chat'),
        eq(conversations.isPrimary, false),
        isNull(conversations.archivedAt),
        lt(conversations.updatedAt, cutoff),
      ),
    )
    .orderBy(desc(conversations.updatedAt))
    .limit(100);

  for (const candidate of candidates) {
    const [activeTask] = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.agentId, agent.id),
          eq(tasks.conversationId, candidate.id),
          notInArray(tasks.status, TERMINAL_TASK_STATUSES),
        ),
      )
      .limit(1);
    if (activeTask) continue;
    await db
      .update(conversations)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(conversations.id, candidate.id), isNull(conversations.archivedAt)));
  }
  revalidateChatViews();
  redirect('/chat/all');
}
