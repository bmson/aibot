import {
  buildSystemPrompt,
  createChatTask,
  enqueueTask,
  ensureChatConversation,
  finishTask,
  getAgent,
  getOwnerCard,
  loadConfig,
  persistMessage,
} from '@assistant/core';
import { conversations } from '@assistant/db';
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
} from 'ai';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
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

/**
 * Does this turn ask the assistant to DO something (tools/actions), or just
 * converse? Action turns run through the real executor — planner, tools, risk
 * gate, approvals — because this streaming route has NO tools, and a tool-less
 * model asked to act will role-play acting (that is exactly the hallucinated
 * "email sent" bug this triage exists to prevent).
 */
const NeedsActionSchema = z.object({
  needsAction: z
    .boolean()
    .describe(
      'true if the user asks the assistant to DO or CHECK something (send email/SMS, schedule, book, buy, browse the web, look at inbox/calendar, remember something, set a reminder, run a task) — false for plain conversation, questions answerable from general knowledge, or feedback.',
    ),
});

/** Static acknowledgment streamed to the UI while the executor works. */
function ackStreamResponse(text: string, headers: Record<string, string>): Response {
  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      writer.write({ type: 'text-start', id: 'ack' });
      writer.write({ type: 'text-delta', id: 'ack', delta: text });
      writer.write({ type: 'text-end', id: 'ack' });
    },
  });
  return createUIMessageStreamResponse({ stream, headers });
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

  // Triage: conversation streams below; action requests go to the executor.
  // On triage failure default to the executor — a slow honest answer beats a
  // fast hallucinated one.
  let needsAction = true;
  try {
    const recent = uiMessages
      .slice(-6)
      .map((m) => `${m.role}: ${textOf(m).slice(0, 500)}`)
      .join('\n');
    const triage = await getRouter().object<z.infer<typeof NeedsActionSchema>>('classify', {
      schema: NeedsActionSchema,
      system:
        'Classify whether the LATEST user message asks the assistant to take an action or check its accounts, versus plain conversation.',
      prompt: recent,
    });
    if (triage.ok) needsAction = triage.object.needsAction;
  } catch (err) {
    console.error('chat triage failed — routing to executor', err);
  }

  if (needsAction) {
    // The executor persists its answer (or an approval notice) into this
    // conversation; the client polls /api/chat/status until it lands.
    const { task } = await enqueueTask(db, {
      event: {
        source: 'chat',
        agentId: agent.id,
        conversationId: conversation.id,
        trust: 'owner',
        payload: { text: userText },
      },
      type: 'chat_turn',
    });
    return ackStreamResponse('_Working on it…_', {
      'x-conversation-id': conversation.id,
      'x-async-task': task.id,
    });
  }

  const task = await createChatTask(db, {
    agentId: agent.id,
    conversationId: conversation.id,
  });

  const outcome = await getRouter().stream('draft', {
    taskId: task.id,
    // owner chat is the critical carve-out: degrade on a hard cap, don't block
    critical: true,
    modelOverride: conversation.modelOverride ?? undefined,
    system: [
      buildSystemPrompt(agent, { ownerCard: await getOwnerCard(db) }),
      '',
      'This turn is conversational: just answer. You have no tools in this turn, so if the user is actually asking you to take an action, say plainly that you cannot do it in this reply and ask them to restate it as a direct request. Otherwise do not mention tools, capabilities, or this instruction at all — no postscripts.',
    ].join('\n'),
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
      'x-conversation-id': conversation.id,
    },
  });
}
