'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type UIMessage } from 'ai';
import { useEffect, useMemo, useState, useTransition } from 'react';
import { btn } from '@/lib/ui';
import { archiveConversation, changeConversationModel, restoreConversation } from '../actions';
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
}

const ASYNC_ACK_TEXT = 'Got it — I’m working on this now. I’ll post the result here.';

function messageText(message: UIMessage): string {
  return message.parts
    .filter(
      (part): part is Extract<UIMessage['parts'][number], { type: 'text' }> => part.type === 'text',
    )
    .map((part) => part.text)
    .join('');
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
}: ChatClientProps) {
  const [input, setInput] = useState('');
  const [fallbackNote, setFallbackNote] = useState<string | null>(null);
  const [isSwitching, startTransition] = useTransition();
  /** Set when the route handed the turn to the executor — we poll until it settles. */
  const [asyncTurn, setAsyncTurn] = useState<{ taskId: string; cursor: string } | null>(
    initialAsyncTurn ?? null,
  );
  const [asyncNote, setAsyncNote] = useState<string | null>(null);

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
              data.taskStatus === 'waiting_budget') &&
            sawAssistant
          ) {
            return settle(null);
          }
          if (
            data.taskStatus === 'failed' ||
            data.taskStatus === 'needs_attention' ||
            data.taskStatus === 'cancelled'
          ) {
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
            <summary className="cursor-pointer list-none rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
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
                className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
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

      <div className="flex-1 overflow-y-auto py-4">
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
                  {message.parts.map((part, index) =>
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
        onSubmit={(event) => {
          event.preventDefault();
          const text = input.trim();
          if (!text || busy) return;
          setInput('');
          void sendMessage({ text });
        }}
        className="flex gap-2 border-t border-slate-200 pt-4 dark:border-zinc-800"
      >
        <input
          aria-label="Message"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Ask anything…"
          className="flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none transition-shadow placeholder:text-slate-400 focus:border-indigo-400 focus:ring-3 focus:ring-indigo-100 dark:border-zinc-700 dark:bg-zinc-900"
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
