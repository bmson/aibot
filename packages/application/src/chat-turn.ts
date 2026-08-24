import type { Config } from '@assistant/config';
import {
  buildSystemPrompt,
  createChatTask,
  encodeMessageCursor,
  ensureChatConversation,
  finishTask,
  getAgent,
  listConversationToolEvidence,
  listMessages,
  persistMessage,
} from '@assistant/core/chat';
import { createCueScanner, stripCueTags } from '@assistant/core/chat-cues';
import { getAmbientBlock } from '@assistant/core/memory/ambient';
import { getOwnerCard } from '@assistant/core/memory/consolidation';
import { recallKnowledgeGraph, recallWithGraphFallback } from '@assistant/core/memory/graph-recall';
import { type RecallSource, recallRelevantContext } from '@assistant/core/memory/recall';
import type { ModelRouter, StreamOutcome } from '@assistant/core/model-router';
import { buildAutonomyGrant } from '@assistant/core/workflow/autonomy';
import { enqueueTask } from '@assistant/core/workflow/machine';
import { detectPersonalReadRequest } from '@assistant/core/workflow/read-intent';
import { goalIdForConversation } from '@assistant/core/workflow/schedules';
import { conversations, type Db } from '@assistant/db';
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
} from 'ai';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { pumpWithCues, type StreamChunk } from './chat-cue-stream.js';
import { CORRECTION, guardDraft } from './chat-guard.js';
import { looksLikeActionRequest } from './chat-triage.js';

const MAX_REQUEST_BYTES = 32 * 1024;
const MAX_USER_MESSAGE_BYTES = 16 * 1024;
const MAX_MODEL_HISTORY_BYTES = 64 * 1024;
const MODEL_HISTORY_LIMIT = 40;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** Compact, ASCII-safe recall provenance for the x-recall response header. */
function encodeRecallHeader(sources: RecallSource[]): string {
  const trimmed = sources.slice(0, 3).map((s) => ({
    date: s.date,
    label: s.label.slice(0, 60),
    ...(s.kind ? { kind: s.kind } : {}),
    ...(s.hops ? { hops: s.hops } : {}),
  }));
  return encodeURIComponent(JSON.stringify(trimmed));
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
      'true if the user asks the assistant to DO or CHECK something (send email/SMS, schedule, book, buy, browse the web, look at inbox/calendar — e.g. "look at my calendar", "what\'s on my schedule", "tell me my flights" — remember something, set a reminder, run a task) — false for plain conversation, questions answerable from general knowledge, or feedback.',
    ),
});

/**
 * Action turns are accepted by the workflow queue rather than answered in this
 * request. An empty UI message stream is not a valid completed assistant turn
 * for every AI SDK client version, which surfaced as a generic "request failed"
 * after an otherwise successful submission. Send one explicit acknowledgement;
 * the client replaces the temporary state with the durable task reply it polls.
 *
 * This text is never persisted, so the chat log recognises and drops it rather
 * than leaving a message with no send time pinned below everything that lands
 * afterwards — isAsyncAcknowledgement in apps/web/lib/chat-notices.ts matches
 * its opening, so keep the two in step.
 */
function acceptedStreamResponse(taskId: string, headers: Record<string, string>): Response {
  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      const partId = `task-${taskId}`;
      writer.write({ type: 'text-start', id: partId });
      writer.write({
        type: 'text-delta',
        id: partId,
        delta: 'Got it — I’m working on this now. I’ll post the result here.',
      });
      writer.write({ type: 'text-end', id: partId });
      writer.write({ type: 'finish', finishReason: 'stop' });
    },
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

export async function handleChatTurn(
  req: Request,
  dependencies: { config: Config; db: Db; router: ModelRouter },
): Promise<Response> {
  const { config, db, router } = dependencies;
  if (!config.OPENROUTER_API_KEY) {
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
  const body = parsedBody as {
    messages?: UIMessage[];
    conversationId?: string;
    autonomous?: boolean;
  };
  if (body.conversationId && !UUID_RE.test(body.conversationId)) {
    return Response.json({ error: 'invalid conversationId' }, { status: 400 });
  }
  // The composer's "Autonomous" toggle. This POST is an authenticated owner
  // action (isAuthed above), so it is a valid grant-arming surface: the toggle
  // IS the approval, and the task runs free-range (subject to the dispatcher's
  // hard floor). A forced action request always runs through the executor.
  const autonomousRequested = body.autonomous === true;
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

  const agent = await getAgent(db);
  const conversation = await ensureChatConversation(db, agent.id, body.conversationId);

  // Replying is an explicit choice to resume an archived chat. Preserve the
  // history, but make it visible again instead of creating a duplicate thread.
  if (conversation.archivedAt) {
    await db
      .update(conversations)
      .set({ archivedAt: null, updatedAt: new Date() })
      .where(eq(conversations.id, conversation.id));
  }

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
  const historyRows = await listMessages(db, conversation.id, {
    limit: MODEL_HISTORY_LIMIT,
  });
  const modelHistory = boundedModelHistory(historyRows);

  // Triage: conversation streams below; action requests go to the executor.
  // On triage failure default to the executor — a slow honest answer beats a
  // fast hallucinated one.
  let needsAction = true;
  // A deterministic gate first: a clear imperative ("add lunch Friday noon")
  // must reach the tools path even when the cheap classify model misreads it as
  // conversation. Failed-action follow-ups also return to the executor when
  // the preceding assistant turn committed to an action. Only the genuinely
  // ambiguous rest falls through to the model.
  const priorAssistantText = [...modelHistory.slice(0, -1)]
    .reverse()
    .find((message) => message.role === 'assistant');
  if (
    autonomousRequested ||
    looksLikeActionRequest(userText, priorAssistantText ? textOf(priorAssistantText) : '')
  ) {
    // A free-range request must run through the executor (which honors the grant
    // and its floor) — never the tool-less streaming path.
    needsAction = true;
  } else {
    try {
      // Prior turns are context only; the latest message is what we classify.
      // Passing them mixed together let the model judge the whole thread (a
      // finished task in the history read as "nothing to do").
      const context = modelHistory
        .slice(-6, -1)
        .map((m) => `${m.role}: ${textOf(m).slice(0, 500)}`)
        .join('\n');
      const triage = await router.object<z.infer<typeof NeedsActionSchema>>('classify', {
        schema: NeedsActionSchema,
        system:
          'Route one chat turn. Decide whether the LATEST user message asks the assistant to DO or CHECK something (send/schedule/book/buy/browse, read, summarize, or report on the inbox or calendar — "look at my calendar and tell me…", "what do I have this week" — remember something, set a reminder, run a task) versus plain conversation. Judge ONLY the latest message; earlier turns are context. When uncertain, choose action — this streaming path has no tools and cannot act on the message.',
        prompt: context
          ? `Prior turns (context only):\n${context}\n\nLATEST USER MESSAGE (classify this):\n${userText}`
          : `LATEST USER MESSAGE (classify this):\n${userText}`,
      });
      if (triage.ok) needsAction = triage.object.needsAction;
    } catch (err) {
      console.error('chat triage failed — routing to executor', err);
    }
  }

  if (needsAction) {
    // Fail before creating a task when the deployed queue cannot authenticate
    // to the agent. Previously this threw from getQueueNotifier and surfaced as
    // an opaque 500, most often on a second turn that was action-routed.
    if (
      config.QUEUE_DRIVER === 'cloudtasks' &&
      (!config.INTERNAL_OIDC_AUDIENCE || !config.INTERNAL_OIDC_SERVICE_ACCOUNT)
    ) {
      console.error('chat action queue is missing its OIDC configuration');
      return Response.json(
        {
          error:
            'The task service is temporarily unavailable. Your message was saved; refresh this chat in a moment before retrying.',
        },
        { status: 503 },
      );
    }
    // The executor persists its answer (or an approval notice) into this
    // conversation; the client polls /api/chat/status until it lands.
    try {
      const { task } = await enqueueTask(db, {
        event: {
          source: 'chat',
          agentId: agent.id,
          conversationId: conversation.id,
          trust: 'owner',
          payload: { text: userText },
        },
        type: 'chat_turn',
        // An answer typed into a goal's work chat belongs to that goal, so the
        // goal's own sessions can see it was answered.
        goalId: await goalIdForConversation(db, conversation.id),
        ...(autonomousRequested
          ? {
              autonomyGrant: buildAutonomyGrant({
                grantedVia: 'composer',
                nowMs: Date.now(),
              }),
            }
          : {}),
      });
      return acceptedStreamResponse(task.id, {
        'x-conversation-id': conversation.id,
        'x-async-task': task.id,
        'x-message-cursor': messageCursor,
      });
    } catch (error) {
      console.error('chat action task could not be queued', error);
      return Response.json(
        {
          error:
            'The task service is temporarily unavailable. Your message was saved; refresh this chat in a moment before retrying.',
        },
        { status: 503 },
      );
    }
  }

  // Long-running-chat auto-recall (Phase 1): reach back into the owner's own
  // earlier discussion that is relevant to this turn but has scrolled out of
  // the live window. Best-effort — a recall failure must never fail the chat.
  let recallBlock: string | undefined;
  let recallSources: RecallSource[] = [];
  if (config.CHAT_RECALL_ENABLED) {
    try {
      const layered = await recallWithGraphFallback({
        graph: config.GRAPH_RAG_ENABLED
          ? async () => {
              const [queryEmbedding] = await router.embed([userText]);
              return {
                graph: await recallKnowledgeGraph(db, {
                  agentId: agent.id,
                  queryText: userText,
                  queryEmbedding,
                }),
                queryEmbedding,
              };
            }
          : undefined,
        history: (queryEmbedding, graph) =>
          recallRelevantContext(
            db,
            {
              agentId: agent.id,
              queryText: userText,
              embed: (values, embedOpts) => router.embed(values, embedOpts ?? {}),
              exclude: {
                conversationId: conversation.id,
                sinceCreatedAt: historyRows[0]?.createdAt ?? persistedUser.createdAt,
              },
            },
            {
              ...(graph.used > 0 ? { maxChars: 1200 } : {}),
              queryEmbedding,
            },
          ),
        onGraphError: (err) => {
          // GraphRAG is additive. Existing vector recall must still answer when
          // graph storage, extraction, or its query embedding is unavailable.
          console.error('knowledge graph recall failed — falling back to chat recall', err);
        },
      });
      recallBlock = layered.block || undefined;
      recallSources = layered.sources;
    } catch (err) {
      console.error('chat recall failed — continuing without it', err);
    }
  }

  const task = await createChatTask(db, {
    agentId: agent.id,
    conversationId: conversation.id,
    goalId: await goalIdForConversation(db, conversation.id),
  });

  // Honesty-check scope for guardDraft: everything earlier turns actually did,
  // all marked prior-turn. This turn itself runs no tools.
  const toolEvidence = await listConversationToolEvidence(db, conversation.id);
  const readRequest = detectPersonalReadRequest(modelHistory);

  let outcome: StreamOutcome;
  try {
    outcome = await router.stream('draft', {
      taskId: task.id,
      // owner chat is the critical carve-out: degrade on a hard cap, don't block
      critical: true,
      modelOverride: conversation.modelOverride ?? undefined,
      system: [
        buildSystemPrompt(agent, {
          ownerCard: await getOwnerCard(db),
          recall: recallBlock,
          // Owner chat is always owner-trust and untainted here, so the fused
          // "right now" block (location + weather) is available — "where am I?"
          // and "should I go for a run?" answer without a mid-task tool call.
          ambient: await getAmbientBlock(db, agent.id),
          channel: 'dashboard-chat',
        }),
        '',
        'This turn is conversational: just answer. You have no tools in this turn, so if the user is actually asking you to take an action, say plainly that you cannot do it in this reply and ask them to restate it as a direct request. Otherwise do not mention tools, capabilities, or this instruction at all — no postscripts.',
      ].join('\n'),
      messages: await convertToModelMessages(modelHistory),
      onComplete: async (text) => {
        // Strip the companion cue tags BEFORE the guard, for the same reason
        // the pump strips them below: the contract's prose matchers must see
        // clean text, and the persisted reply must be byte-identical to the
        // streamed one (retireProvisionalReplies dedupes on exact text).
        const stripped = stripCueTags(text);
        const guarded = guardDraft(stripped.text, toolEvidence, { readRequest });
        if (guarded.corrected) {
          console.warn('tool-less chat draft claimed unperformed work', {
            taskId: task.id,
          });
        }
        await finishTask(db, task, {
          status: 'done',
          responseText: guarded.text,
          recall: recallSources,
          cues: stripped.cues,
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
    await finishTask(db, task, {
      status: 'failed',
      progress: outcome.decision.reason,
    });
    return Response.json(
      { error: outcome.decision.reason, mode: outcome.decision.mode },
      { status: 402 },
    );
  }

  // Stream the draft as-is, then run the honesty check on the finished text and
  // append the correction part when it claimed tool-backed work — the deltas
  // have already reached the client, so appending is the only honest option
  // that keeps the live view and the persisted message (onComplete) identical.
  const okOutcome = outcome;
  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      // Pump the model stream by hand (not writer.merge, whose pump can race a
      // direct write) and hold the finish part back, so the correction — when
      // needed — still lands inside the message, not after the client saw it end.
      // The pump also strips companion cue tags from the text deltas and
      // re-emits them as data-* parts, so the face reacts mid-stream while the
      // streamed text stays byte-identical to what onComplete persists.
      const parts = okOutcome.toUIMessageStream({ sendFinish: false });
      await pumpWithCues(
        parts as unknown as AsyncIterable<StreamChunk>,
        (chunk) => writer.write(chunk as Parameters<typeof writer.write>[0]),
        createCueScanner(),
      );
      const draft = await okOutcome.text;
      if (guardDraft(stripCueTags(draft).text, toolEvidence, { readRequest }).corrected) {
        const partId = `contract-${task.id}`;
        writer.write({ type: 'text-start', id: partId });
        writer.write({ type: 'text-delta', id: partId, delta: CORRECTION });
        writer.write({ type: 'text-end', id: partId });
      }
      writer.write({ type: 'finish', finishReason: 'stop' });
    },
  });
  return createUIMessageStreamResponse({
    stream,
    headers: {
      'x-model-id': outcome.modelId,
      'x-model-degraded': String(outcome.degraded),
      'x-conversation-id': conversation.id,
      'x-message-cursor': messageCursor,
      // Live transparency for this streaming turn; the persisted `recall`
      // message part carries the same provenance across reloads.
      ...(recallSources.length > 0 ? { 'x-recall': encodeRecallHeader(recallSources) } : {}),
    },
  });
}
