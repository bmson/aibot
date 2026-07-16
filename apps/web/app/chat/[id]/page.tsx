import { listMessages } from '@assistant/core';
import { conversations, models } from '@assistant/db';
import type { UIMessage } from 'ai';
import { and, eq, sql } from 'drizzle-orm';
import { notFound } from 'next/navigation';
import { requireOwner } from '@/auth';
import { getDb } from '@/lib/server';
import { ChatClient } from './chat-client';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ChatConversationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireOwner();
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();

  const db = getDb();
  const [conversation] = await db.select().from(conversations).where(eq(conversations.id, id));
  if (!conversation) notFound();

  const rows = await listMessages(db, id);
  const initialMessages: UIMessage[] = rows
    .filter((row) => row.role === 'user' || row.role === 'assistant')
    .map((row) => ({
      id: row.id,
      role: row.role as 'user' | 'assistant',
      parts: row.parts as UIMessage['parts'],
    }));

  // Embedding-only models can't chat — keep them out of the switcher.
  const enabledModels = await db
    .select({ id: models.id, label: models.label })
    .from(models)
    .where(
      and(
        eq(models.enabled, true),
        sql`${models.capabilities}->>'embedding' IS DISTINCT FROM 'true'`,
      ),
    )
    .orderBy(models.label);

  return (
    <ChatClient
      conversationId={conversation.id}
      title={conversation.title || 'Untitled'}
      initialMessages={initialMessages}
      models={enabledModels}
      modelOverride={conversation.modelOverride}
    />
  );
}
