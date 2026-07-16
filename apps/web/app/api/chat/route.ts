import {
  buildSystemPrompt,
  createChatTask,
  ensureChatConversation,
  finishTask,
  getAgent,
  getOwnerCard,
  loadConfig,
  persistMessage,
} from '@assistant/core';
import { conversations } from '@assistant/db';
import { convertToModelMessages, type UIMessage } from 'ai';
import { eq } from 'drizzle-orm';
import { isAuthed } from '@/auth';
import { getDb, getRouter } from '@/lib/server';

function textOf(message: UIMessage): string {
  return message.parts
    .filter((part): part is Extract<UIMessage['parts'][number], { type: 'text' }> => {
      return part.type === 'text';
    })
    .map((part) => part.text)
    .join('\n');
}

export async function POST(req: Request) {
  if (!(await isAuthed())) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!loadConfig().OPENROUTER_API_KEY) {
    return Response.json({ error: 'OPENROUTER_API_KEY not set — add it to .env' }, { status: 503 });
  }

  const body = (await req.json()) as { messages?: UIMessage[]; conversationId?: string };
  const uiMessages = body.messages ?? [];
  const userMessage = [...uiMessages].reverse().find((m) => m.role === 'user');
  if (!userMessage) {
    return Response.json({ error: 'no user message in request' }, { status: 400 });
  }

  const db = getDb();
  const agent = await getAgent(db);
  const conversation = await ensureChatConversation(db, agent.id, body.conversationId);

  const userText = textOf(userMessage);
  if (!conversation.title) {
    await db
      .update(conversations)
      .set({ title: userText.slice(0, 60) })
      .where(eq(conversations.id, conversation.id));
  }

  await persistMessage(db, {
    conversationId: conversation.id,
    role: 'user',
    origin: 'owner',
    parts: userMessage.parts,
    text: userText,
  });

  const task = await createChatTask(db, {
    agentId: agent.id,
    conversationId: conversation.id,
  });

  const outcome = await getRouter().stream('draft', {
    taskId: task.id,
    modelOverride: conversation.modelOverride ?? undefined,
    system: buildSystemPrompt(agent, { ownerCard: await getOwnerCard(db) }),
    messages: await convertToModelMessages(uiMessages),
    onComplete: async (text) => {
      await persistMessage(db, {
        conversationId: conversation.id,
        taskId: task.id,
        role: 'assistant',
        origin: 'assistant',
        parts: [{ type: 'text', text }],
        text,
      });
      await finishTask(db, task.id, 'done');
    },
  });

  if (!outcome.ok) {
    await finishTask(db, task.id, 'failed', outcome.decision.reason);
    return Response.json(
      { error: outcome.decision.reason, mode: outcome.decision.mode },
      { status: 402 },
    );
  }

  return outcome.toUIMessageStreamResponse({
    headers: {
      'x-model-id': outcome.modelId,
      'x-model-degraded': String(outcome.degraded),
    },
  });
}
