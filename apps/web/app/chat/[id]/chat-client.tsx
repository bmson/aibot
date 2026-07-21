'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type UIMessage } from 'ai';
import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { btn } from '@/lib/ui';
import { archiveConversation, changeConversationModel, restoreConversation } from '../actions';
import { InlineApproval, type InlineApprovalPart } from './inline-approval';
import { InlineBudgetRequest, type InlineBudgetRequestPart } from './inline-budget-request';
import { MessageMarkdown } from './markdown';

interface ChatClientProps {
  conversationId: string;
  title: string;
  initialMessages: UIMessage[];
  models: { id: string; label: string }[];
  modelOverride: string | null;
  goalTitle?: string;
  /** A task created by the goal form before this page opened. */
  initialAsyncTurn?: { taskId: string; cursor: string };
  archived: boolean;
  canArchive: boolean;
  initialNotice?: string;
  /** Pre-fills the composer (e.g. an "ask about this document" deep-link). */
  initialInput?: string;
}

const ASYNC_ACK_TEXT = 'Got it — I’m working on this now. I’ll post the result here.';

interface RecallSource {
  date: string;
  label: string;
}

function messageText(message: UIMessage): string {
  return message.parts
    .filter(
      (part): part is Extract<UIMessage['parts'][number], { type: 'text' }> => part.type === 'text',
    )
    .map((part) => part.text)
    .join('');
}

/** Auto-recall provenance carried on an assistant message's custom `recall` part. */
function recallSourcesOf(message: UIMessage): RecallSource[] {
  for (const part of message.parts as Array<{ type?: string; sources?: unknown }>) {
    if (part?.type === 'recall' && Array.isArray(part.sources)) {
      return (part.sources as RecallSource[]).filter(
        (s) => s && typeof s.date === 'string' && typeof s.label === 'string',
      );
    }
  }
  return [];
}

/** The "recalled from earlier" affordance: what auto-recall drew on for a turn. */
function RecallChip({ sources }: { sources: RecallSource[] }) {
  if (sources.length === 0) return null;
  return (
    <div className="mb-1.5 flex flex-wrap items-center gap-1 text-[11px] text-slate-500 dark:text-zinc-400">
      <span className="font-medium">↩ Recalled from earlier:</span>
      {sources.map((source, index) => (
        <span
          key={`${source.date}-${index.toString()}`}
          className="rounded bg-slate-100 px-1.5 py-0.5 dark:bg-zinc-800"
          title={source.label}
        >
          {source.date} · {source.label}
        </span>
      ))}
    </div>
  );
}

function decodeRecallHeader(value: string | null): RecallSource[] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(value)) as unknown;
    if (!Array.isArray(parsed)) return null;
    const sources = parsed.filter(
      (s): s is RecallSource =>
        Boolean(s) &&
        typeof (s as RecallSource).date === 'string' &&
        typeof (s as RecallSource).label === 'string',
    );
    return sources.length > 0 ? sources : null;
  } catch {
    return null;
  }
}

/**
 * The transport throws `Error(await response.text())` on non-ok responses, so
 * 402/503 JSON bodies from the chat route arrive as the error message.
 */
function errorText(error: Error): string {
  try {
    const parsed = JSON.parse(error.message) as { error?: string };
    if (parsed.error) return parsed.error;
  } catch {
    // not JSON — fall through to the raw message
  }
  return (
    error.message ||
    'We could not display the response. Your message may still have been saved — refresh this chat before retrying.'
  );
}

export function ChatClient({
  conversationId,
  title,
  initialMessages,
  models,
  modelOverride,
  goalTitle,
  initialAsyncTurn,
  archived,
  canArchive,
  initialNotice,
  initialInput,
}: ChatClientProps) {
  const [input, setInput] = useState(initialInput ?? '');
  const [fallbackNote, setFallbackNote] = useState<string | null>(null);
  const [isSwitching, startTransition] = useTransition();
  /** Set when the route handed the turn to the executor — we poll until it settles. */
  const [asyncTurn, setAsyncTurn] = useState<{ taskId: string; cursor: string } | null>(
    initialAsyncTurn ?? null,
  );
  const [asyncNote, setAsyncNote] = useState<string | null>(null);
  /** Live provenance for the current streaming turn (the persisted part covers reloads). */
  const [liveRecall, setLiveRecall] = useState<RecallSource[] | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const messageScrollerRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: '/api/chat',
        body: { conversationId },
        // The server owns history. Sending only the new user turn keeps request
        // size flat and prevents a client from selecting model context.
        prepareSendMessagesRequest: ({ messages, body }) => {
          const latestUser = [...messages].reverse().find((message) => message.role === 'user');
          return { body: { ...body, messages: latestUser ? [latestUser] : [] } };
        },
        // Wrap fetch to capture the routing headers set by the chat route.
        fetch: (async (info, init) => {
          const response = await fetch(info, init);
          const modelId = response.headers.get('x-model-id');
          const degraded = response.headers.get('x-model-degraded') === 'true';
          setFallbackNote(degraded && modelId ? `responded with ${modelId} (fallback)` : null);
          setLiveRecall(decodeRecallHeader(response.headers.get('x-recall')));
          const taskId = response.headers.get('x-async-task');
          const cursor = response.headers.get('x-message-cursor');
          setAsyncTurn(taskId && cursor ? { taskId, cursor } : null);
          if (taskId) setAsyncNote(null);
          return response;
        }) as typeof fetch,
      }),
    [conversationId],
  );

  const { messages, sendMessage, setMessages, status, error, clearError } = useChat({
    id: conversationId,
    messages: initialMessages,
    transport,
  });

  // Action turns run in the executor (tools, approvals) — poll the thread
  // until the task settles, then replace the local ack with the real answer.
  useEffect(() => {
    if (!asyncTurn) return;
    const startedAt = Date.now();
    const TIMEOUT_MS = 5 * 60 * 1000;
    let cancelled = false;
    let cursor = asyncTurn.cursor;
    let sawAssistant = false;

    const mergeMessages = (incoming: UIMessage[]) => {
      if (incoming.length === 0) return;
      setMessages((current) => {
        const merged = [...current];
        const indexes = new Map(merged.map((message, index) => [message.id, index]));
        for (const message of incoming) {
          const index = indexes.get(message.id);
          if (index === undefined) {
            indexes.set(message.id, merged.length);
            merged.push(message);
          } else {
            merged[index] = message;
          }
        }
        // The route sends a short acknowledgement while an action task starts.
        // Once the durable assistant reply arrives, remove that temporary copy
        // so a simple request still reads as one coherent conversation.
        const hasDurableReply = incoming.some(
          (message) => message.role === 'assistant' && messageText(message) !== ASYNC_ACK_TEXT,
        );
        return hasDurableReply
          ? merged.filter(
              (message) => message.role !== 'assistant' || messageText(message) !== ASYNC_ACK_TEXT,
            )
          : merged;
      });
    };

    const settle = (note: string | null) => {
      if (cancelled) return;
      setAsyncNote(note);
      setAsyncTurn(null);
    };

    const tick = async () => {
      if (cancelled) return;
      try {
        const query = new URLSearchParams({
          conversationId,
          taskId: asyncTurn.taskId,
          cursor,
        });
        const res = await fetch(`/api/chat/status?${query.toString()}`);
        if (res.ok) {
          const data = (await res.json()) as {
            taskStatus: string;
            messages: UIMessage[];
            nextCursor: string | null;
            hasMore: boolean;
          };
          mergeMessages(data.messages);
          sawAssistant ||= data.messages.some((message) => message.role === 'assistant');
          if (data.nextCursor) cursor = data.nextCursor;
          if (data.hasMore) {
            if (!cancelled) window.setTimeout(tick, 0);
            return;
          }
          if (
            (data.taskStatus === 'done' ||
              data.taskStatus === 'waiting_approval' ||
              data.taskStatus === 'waiting_budget' ||
              data.taskStatus === 'needs_attention') &&
            sawAssistant
          ) {
            return settle(null);
          }
          if (data.taskStatus === 'failed' || data.taskStatus === 'cancelled') {
            return settle(
              `the task ${data.taskStatus === 'cancelled' ? 'was cancelled' : `ended ${data.taskStatus}`} — see the Tasks page`,
            );
          }
        }
      } catch {
        // transient poll failure — keep trying until the timeout
      }
      if (Date.now() - startedAt > TIMEOUT_MS) {
        return settle('Still working. The result will appear here when it finishes.');
      }
      if (!cancelled) window.setTimeout(tick, 2500);
    };

    void tick();
    return () => {
      cancelled = true;
    };
  }, [asyncTurn, conversationId, setMessages]);

  const busy = status === 'submitted' || status === 'streaming' || asyncTurn !== null;

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      const scroller = messageScrollerRef.current;
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  });

  const submitCurrentMessage = () => {
    const text = input.trim();
    if (!text || busy) return;
    stickToBottomRef.current = true;
    setInput('');
    setLiveRecall(null);
    void sendMessage({ text });
  };

  return (
    <div className="mx-auto flex h-[calc(100dvh-6.5rem)] max-w-4xl flex-col lg:h-[calc(100vh-4rem)]">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-4 dark:border-zinc-800">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold tracking-[0.14em] text-indigo-700 uppercase dark:text-indigo-300">
            Chat
          </p>
          <h1 className="mt-1 truncate text-xl font-semibold tracking-[-0.03em]">{title}</h1>
          {goalTitle ? (
            <p className="mt-1 truncate text-xs text-slate-500 dark:text-zinc-400">
              Working toward: {goalTitle}
            </p>
          ) : null}
          {archived ? (
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              Archived — sending a message restores this chat.
            </p>
          ) : null}
        </div>
        <div className="flex min-w-0 items-center gap-2">
          {archived ? (
            <form action={restoreConversation.bind(null, conversationId)}>
              <button type="submit" className={btn.outline}>
                Restore
              </button>
            </form>
          ) : canArchive ? (
            <form action={archiveConversation.bind(null, conversationId)}>
              <button type="submit" className={btn.outline}>
                Archive
              </button>
            </form>
          ) : null}
          {fallbackNote ? (
            <span className="text-xs text-zinc-500 dark:text-zinc-500">{fallbackNote}</span>
          ) : null}
          <details className="relative">
            <summary className="inline-flex cursor-pointer list-none items-center rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
              Model
            </summary>
            <div className="absolute top-full right-0 z-10 mt-2 w-56 rounded-xl border border-slate-200 bg-white p-2 shadow-lg dark:border-zinc-700 dark:bg-zinc-950">
              <label
                htmlFor="conversation-model"
                className="px-1 text-[10px] font-semibold tracking-[0.12em] text-slate-500 uppercase dark:text-zinc-400"
              >
                Response model
              </label>
              <select
                id="conversation-model"
                aria-label="Model"
                defaultValue={modelOverride ?? ''}
                disabled={isSwitching}
                onChange={(event) => {
                  const value = event.target.value;
                  startTransition(() => changeConversationModel(conversationId, value || null));
                }}
                className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-base sm:text-sm dark:border-zinc-700 dark:bg-zinc-900"
              >
                <option value="">Auto</option>
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                  </option>
                ))}
              </select>
            </div>
          </details>
        </div>
      </header>
      {initialNotice ? (
        <p
          role="alert"
          className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100"
        >
          {initialNotice}
        </p>
      ) : null}

      <div
        ref={messageScrollerRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          stickToBottomRef.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < 120;
        }}
        className="flex-1 overflow-y-auto py-4"
      >
        {messages.length === 0 ? (
          <p className="mt-8 text-sm leading-6 text-slate-500 dark:text-zinc-400">
            Ask for a plan, a document, a summary, or help with something you need to get done.
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            {messages.map((message) => (
              <div
                key={message.id}
                className={message.role === 'user' ? 'flex justify-end' : 'flex justify-start'}
              >
                <div
                  className={
                    message.role === 'user'
                      ? 'max-w-[88%] rounded-2xl rounded-br-md bg-indigo-600 px-3 py-2 text-sm text-white shadow-sm sm:max-w-[80%]'
                      : 'max-w-[88%] rounded-2xl rounded-bl-md border border-slate-200 bg-white px-3 py-2 text-sm shadow-sm sm:max-w-[80%] dark:border-zinc-800 dark:bg-zinc-900'
                  }
                >
                  {message.role === 'assistant' ? (
                    <RecallChip sources={recallSourcesOf(message)} />
                  ) : null}
                  {(
                    message.parts as Array<
                      UIMessage['parts'][number] | InlineApprovalPart | InlineBudgetRequestPart
                    >
                  ).map((part, index) =>
                    part.type === 'text' ? (
                      message.role === 'assistant' ? (
                        <MessageMarkdown
                          key={`${message.id}-${index.toString()}`}
                          text={part.text}
                        />
                      ) : (
                        <p
                          key={`${message.id}-${index.toString()}`}
                          className="whitespace-pre-wrap"
                        >
                          {part.text}
                        </p>
                      )
                    ) : part.type === 'approval' ? (
                      <InlineApproval key={part.approvalId} part={part} />
                    ) : part.type === 'budget-request' ? (
                      <InlineBudgetRequest key={part.taskId} part={part} />
                    ) : null,
                  )}
                </div>
              </div>
            ))}
            {status === 'submitted' ? (
              <p className="animate-pulse text-sm text-zinc-500 dark:text-zinc-400">Thinking…</p>
            ) : null}
            {asyncTurn ? (
              <p className="animate-pulse text-sm text-slate-500 dark:text-zinc-400">
                Checking the tools and any required approvals…
              </p>
            ) : null}
            {asyncNote ? (
              <p className="text-xs text-zinc-500 dark:text-zinc-500">{asyncNote}</p>
            ) : null}
            {liveRecall ? <RecallChip sources={liveRecall} /> : null}
          </div>
        )}
      </div>

      {error ? (
        <div className="mb-3 flex items-start justify-between gap-3 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
          <span>{errorText(error)}</span>
          <button
            type="button"
            onClick={clearError}
            className="shrink-0 text-xs underline hover:no-underline"
          >
            dismiss
          </button>
        </div>
      ) : null}

      <form
        ref={formRef}
        onSubmit={(event) => {
          event.preventDefault();
          submitCurrentMessage();
        }}
        className="mobile-safe-bottom flex gap-2 border-t border-slate-200 pt-4 dark:border-zinc-800"
      >
        <textarea
          aria-label="Message"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              formRef.current?.requestSubmit();
            }
          }}
          placeholder="Ask anything…"
          rows={2}
          className="max-h-40 flex-1 resize-none rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-base outline-none transition-shadow placeholder:text-slate-400 focus:border-indigo-400 focus:ring-3 focus:ring-indigo-100 sm:text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        <button
          type="submit"
          disabled={busy || input.trim() === ''}
          className="rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-indigo-700 disabled:opacity-50"
        >
          {busy ? '…' : 'Send'}
        </button>
      </form>
    </div>
  );
}
