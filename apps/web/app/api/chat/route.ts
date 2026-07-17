import {
  buildSystemPrompt,
  createChatTask,
  encodeMessageCursor,
  enqueueTask,
  ensureChatConversation,
  finishTask,
  getAgent,
  getOwnerCard,
  listMessages,
  loadConfig,
  persistMessage,
  type StreamOutcome,
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

const MAX_REQUEST_BYTES = 32 * 1024;
const MAX_USER_MESSAGE_BYTES = 16 * 1024;
const MAX_MODEL_HISTORY_BYTES = 64 * 1024;
const MODEL_HISTORY_LIMIT = 40;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

async function readBoundedBody(
  req: Request,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false }> {
  if (!req.body) return { ok: true, text: '' };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { ok: false };
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(body) };
}

function textOf(message: UIMessage): string {
  return message.parts
    .filter((part): part is Extract<UIMessage['parts'][number], { type: 'text' }> => {
      return part?.type === 'text' && typeof part.text === 'string';
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

/** Complete the SDK request without inventing a temporary assistant message. */
function acceptedStreamResponse(headers: Record<string, string>): Response {
  const stream = createUIMessageStream({
    execute: () => {},
  });
  return createUIMessageStreamResponse({ stream, headers });
}

function boundedModelHistory(rows: Awaited<ReturnType<typeof listMessages>>): UIMessage[] {
  const newestFirst = [...rows]
    .reverse()
    .filter((row) => row.role === 'user' || row.role === 'assistant');
  const selected: UIMessage[] = [];
  let bytes = 0;
  for (const row of newestFirst) {
    const text = row.text;
    const nextBytes = byteLength(text);
    // Keep a contiguous recent suffix; silently reaching far around one huge
    // message produces misleading context.
    if (bytes + nextBytes > MAX_MODEL_HISTORY_BYTES) break;
    bytes += nextBytes;
    selected.push({
      id: row.id,
      role: row.role as 'user' | 'assistant',
      parts: [{ type: 'text', text }],
    });
  }
  return selected.reverse();
}

export async function POST(req: Request) {
  if (!(await isAuthed())) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!loadConfig().OPENROUTER_API_KEY) {
    return Response.json({ error: 'OPENROUTER_API_KEY not set — add it to .env' }, { status: 503 });
  }

  const declaredLength = Number(req.headers.get('content-length') ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    return Response.json({ error: 'chat request too large' }, { status: 413 });
  }
  const requestBody = await readBoundedBody(req, MAX_REQUEST_BYTES).catch(() => null);
  if (!requestBody) return Response.json({ error: 'failed to read request body' }, { status: 400 });
  if (!requestBody.ok) {
    return Response.json({ error: 'chat request too large' }, { status: 413 });
  }
  const rawBody = requestBody.text;
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody) as unknown;
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
    return Response.json({ error: 'body must be an object' }, { status: 400 });
  }
  const body = parsedBody as { messages?: UIMessage[]; conversationId?: string };
  if (body.conversationId && !UUID_RE.test(body.conversationId)) {
    return Response.json({ error: 'invalid conversationId' }, { status: 400 });
  }
  const uiMessages = body.messages ?? [];
  if (!Array.isArray(uiMessages)) {
    return Response.json({ error: 'messages must be an array' }, { status: 400 });
  }
  const userMessage = [...uiMessages]
    .reverse()
    .find(
      (message): message is UIMessage =>
        Boolean(message) && typeof message === 'object' && message.role === 'user',
    );
  if (!userMessage || !Array.isArray(userMessage.parts)) {
    return Response.json({ error: 'no user message in request' }, { status: 400 });
  }

  const userText = textOf(userMessage).trim();
  if (!userText) return Response.json({ error: 'empty user message' }, { status: 400 });
  if (byteLength(userText) > MAX_USER_MESSAGE_BYTES) {
    return Response.json({ error: 'user message too large' }, { status: 413 });
  }

  const db = getDb();
  const agent = await getAgent(db);
  const conversation = await ensureChatConversation(db, agent.id, body.conversationId);

  if (!conversation.title) {
    await db
      .update(conversations)
      .set({ title: userText.slice(0, 60) })
      .where(eq(conversations.id, conversation.id));
  }

  const persistedUser = await persistMessage(db, {
    conversationId: conversation.id,
    role: 'user',
    origin: 'owner',
    parts: [{ type: 'text', text: userText }],
    text: userText,
  });
  if (!persistedUser) throw new Error('failed to persist chat message');
  const messageCursor = encodeMessageCursor(persistedUser);
  const modelHistory = boundedModelHistory(
    await listMessages(db, conversation.id, { limit: MODEL_HISTORY_LIMIT }),
  );

  // Triage: conversation streams below; action requests go to the executor.
  // On triage failure default to the executor — a slow honest answer beats a
  // fast hallucinated one.
  let needsAction = true;
  try {
    const recent = modelHistory
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
    return acceptedStreamResponse({
      'x-conversation-id': conversation.id,
      'x-async-task': task.id,
      'x-message-cursor': messageCursor,
    });
  }

  const task = await createChatTask(db, {
    agentId: agent.id,
    conversationId: conversation.id,
  });

  let outcome: StreamOutcome;
  try {
    outcome = await getRouter().stream('draft', {
      taskId: task.id,
      // owner chat is the critical carve-out: degrade on a hard cap, don't block
      critical: true,
      modelOverride: conversation.modelOverride ?? undefined,
      system: [
        buildSystemPrompt(agent, { ownerCard: await getOwnerCard(db) }),
        '',
        'This turn is conversational: just answer. You have no tools in this turn, so if the user is actually asking you to take an action, say plainly that you cannot do it in this reply and ask them to restate it as a direct request. Otherwise do not mention tools, capabilities, or this instruction at all — no postscripts.',
      ].join('\n'),
      messages: await convertToModelMessages(modelHistory),
      onComplete: async (text) => {
        await finishTask(db, task, {
          status: 'done',
          responseText: text,
        });
      },
      onError: async (error) => {
        await finishTask(db, task, {
          status: 'failed',
          progress: String(error).slice(0, 500),
        });
      },
    });
  } catch (error) {
    await finishTask(db, task, {
      status: 'failed',
      progress: String(error).slice(0, 500),
    });
    return Response.json({ error: 'model request failed' }, { status: 502 });
  }

  if (!outcome.ok) {
    await finishTask(db, task, { status: 'failed', progress: outcome.decision.reason });
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
      'x-message-cursor': messageCursor,
    },
  });
}
