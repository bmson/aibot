'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type UIMessage } from 'ai';
import { useEffect, useMemo, useState, useTransition } from 'react';
import { changeConversationModel } from '../actions';
import { MessageMarkdown } from './markdown';

interface ChatClientProps {
  conversationId: string;
  title: string;
  initialMessages: UIMessage[];
  models: { id: string; label: string }[];
  modelOverride: string | null;
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
  return error.message || 'request failed';
}

export function ChatClient({
  conversationId,
  title,
  initialMessages,
  models,
  modelOverride,
}: ChatClientProps) {
  const [input, setInput] = useState('');
  const [fallbackNote, setFallbackNote] = useState<string | null>(null);
  const [isSwitching, startTransition] = useTransition();
  /** Set when the route handed the turn to the executor — we poll until it settles. */
  const [asyncTaskId, setAsyncTaskId] = useState<string | null>(null);
  const [asyncNote, setAsyncNote] = useState<string | null>(null);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: '/api/chat',
        body: { conversationId },
        // Wrap fetch to capture the routing headers set by the chat route.
        fetch: (async (info, init) => {
          const response = await fetch(info, init);
          const modelId = response.headers.get('x-model-id');
          const degraded = response.headers.get('x-model-degraded') === 'true';
          setFallbackNote(degraded && modelId ? `responded with ${modelId} (fallback)` : null);
          setAsyncTaskId(response.headers.get('x-async-task'));
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
    if (!asyncTaskId) return;
    const startedAt = Date.now();
    const TIMEOUT_MS = 5 * 60 * 1000;
    let cancelled = false;

    const settle = (note: string | null, serverMessages?: UIMessage[]) => {
      if (cancelled) return;
      if (serverMessages) setMessages(serverMessages);
      setAsyncNote(note);
      setAsyncTaskId(null);
    };

    const tick = async () => {
      if (cancelled) return;
      try {
        const res = await fetch(
          `/api/chat/status?conversationId=${conversationId}&taskId=${asyncTaskId}`,
        );
        if (res.ok) {
          const data = (await res.json()) as { taskStatus: string; messages: UIMessage[] };
          const last = data.messages.at(-1);
          const answered = last?.role === 'assistant';
          if (
            (data.taskStatus === 'done' ||
              data.taskStatus === 'waiting_approval' ||
              data.taskStatus === 'waiting_budget') &&
            answered
          ) {
            return settle(null, data.messages);
          }
          if (
            data.taskStatus === 'failed' ||
            data.taskStatus === 'needs_attention' ||
            data.taskStatus === 'cancelled'
          ) {
            return settle(
              `the task ${data.taskStatus === 'cancelled' ? 'was cancelled' : `ended ${data.taskStatus}`} — see the Tasks page`,
              data.messages,
            );
          }
        }
      } catch {
        // transient poll failure — keep trying until the timeout
      }
      if (Date.now() - startedAt > TIMEOUT_MS) {
        return settle('still running in the background — the answer will appear on reload');
      }
      if (!cancelled) window.setTimeout(tick, 2500);
    };

    void tick();
    return () => {
      cancelled = true;
    };
  }, [asyncTaskId, conversationId, setMessages]);

  const busy = status === 'submitted' || status === 'streaming' || asyncTaskId !== null;

  return (
    <div className="mx-auto flex h-[calc(100vh-4rem)] max-w-4xl flex-col">
      <header className="flex items-center justify-between gap-4 border-b border-zinc-200 pb-3 dark:border-zinc-800">
        <h1 className="truncate text-lg font-semibold">{title}</h1>
        <div className="flex items-center gap-3">
          {fallbackNote ? (
            <span className="text-xs text-zinc-500 dark:text-zinc-500">{fallbackNote}</span>
          ) : null}
          <select
            aria-label="Model"
            defaultValue={modelOverride ?? ''}
            disabled={isSwitching}
            onChange={(event) => {
              const value = event.target.value;
              startTransition(() => changeConversationModel(conversationId, value || null));
            }}
            className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          >
            <option value="">Auto (role default)</option>
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </select>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto py-4">
        {messages.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Say something to start the conversation.
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
                      ? 'max-w-[80%] rounded-lg bg-zinc-900 px-3 py-2 text-sm text-white dark:bg-zinc-100 dark:text-zinc-900'
                      : 'max-w-[80%] rounded-lg bg-zinc-100 px-3 py-2 text-sm dark:bg-zinc-900'
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
            {asyncTaskId ? (
              <p className="animate-pulse text-sm text-zinc-500 dark:text-zinc-400">
                Running as a task (tools &amp; approvals)…
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
        className="flex gap-2 border-t border-zinc-200 pt-3 dark:border-zinc-800"
      >
        <input
          aria-label="Message"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Message the assistant… (Enter to send)"
          className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900"
        />
        <button
          type="submit"
          disabled={busy || input.trim() === ''}
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
        >
          {busy ? '…' : 'Send'}
        </button>
      </form>
    </div>
  );
}
