'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type UIMessage } from 'ai';
import {
  ChevronDown,
  CircleCheck,
  CircleX,
  Hand,
  History,
  Loader2,
  ShieldCheck,
  Square,
  Zap,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { isApprovalProseNotice, isContractNotice } from '@/lib/chat-notices';
import { btn, btnSm, focusRing } from '@/lib/ui';
import { toolLabel } from '@/lib/views';
import { archiveConversation, changeConversationModel, restoreConversation } from '../actions';
import { ApprovalGroup } from './approval-group';
import type { InlineApprovalPart } from './inline-approval';
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

/** Persisted send time, carried on message.metadata by the server mappers. */
function messageDate(message: UIMessage): Date | null {
  const meta = message.metadata as { createdAt?: unknown } | undefined;
  if (meta && typeof meta.createdAt === 'string') {
    const date = new Date(meta.createdAt);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}

// Chat renders times in the browser's timezone — it's a live surface the owner
// is looking at right now, unlike the server-rendered dashboards which use the
// agent timezone. Labels are gated behind `mounted` to avoid SSR/client drift.
function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function dayLabel(date: Date, now: Date): string {
  if (sameDay(date, now)) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return 'Yesterday';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  }).format(date);
}

function timeLabel(date: Date): string {
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(date);
}

function DayDivider({ label }: { label: string }) {
  return (
    <div aria-hidden="true" className="flex items-center gap-3 py-1">
      <span className="h-px flex-1 bg-edge" />
      <span className="text-2xs font-medium text-muted">{label}</span>
      <span className="h-px flex-1 bg-edge" />
    </div>
  );
}

/** Three-dot typing indicator; reduced-motion users get static text instead. */
function TypingDots() {
  return (
    <div className="flex justify-start">
      <div className="rounded-2xl rounded-bl-md border border-edge bg-raised px-3 py-2.5 shadow-sm">
        <span className="sr-only">The assistant is thinking</span>
        <span aria-hidden="true" className="hidden items-center gap-1 motion-safe:flex">
          <span className="size-1.5 animate-bounce rounded-full bg-zinc-400 [animation-delay:-0.3s] dark:bg-zinc-500" />
          <span className="size-1.5 animate-bounce rounded-full bg-zinc-400 [animation-delay:-0.15s] dark:bg-zinc-500" />
          <span className="size-1.5 animate-bounce rounded-full bg-zinc-400 dark:bg-zinc-500" />
        </span>
        <span aria-hidden="true" className="text-sm text-muted motion-safe:hidden">
          Thinking…
        </span>
      </div>
    </div>
  );
}

/**
 * Core's response contract blanked an unverifiable reply and substituted this
 * deterministic copy — render it as a system notice, not assistant prose, so
 * honesty enforcement stops reading like the assistant talking strangely.
 */
function ContractNotice({ text }: { text: string }) {
  return (
    <div className="flex justify-start">
      <div className="max-w-[88%] rounded-xl border border-edge bg-sunken/60 px-3 py-2 sm:max-w-[80%]">
        <p className="flex items-center gap-1.5 text-2xs font-semibold tracking-[0.08em] text-muted uppercase">
          <ShieldCheck className="size-3.5 shrink-0" aria-hidden="true" />
          Honesty check
        </p>
        <p className="mt-1 text-xs leading-5 text-zinc-600 dark:text-zinc-300">{text}</p>
        <details className="mt-1">
          <summary className="cursor-pointer text-2xs text-muted select-none">
            Why am I seeing this?
          </summary>
          <p className="mt-1 max-w-prose text-2xs leading-4 text-muted">
            The assistant only reports actions backed by a completed tool result. This notice
            replaced a reply that claimed more than the evidence supported — nothing was sent or
            changed outside this chat.
          </p>
        </details>
      </div>
    </div>
  );
}

/** Live tool activity for an executor turn, as readable chips instead of mono text. */
function ActivityChips({
  activity,
}: {
  activity: Array<{ toolName: string; status: string; step: number }>;
}) {
  if (activity.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {activity.map((item) => (
        <span
          key={`${item.step}-${item.toolName}`}
          className="inline-flex items-center gap-1.5 rounded-full border border-edge bg-raised px-2.5 py-1 text-2xs font-medium text-zinc-600 dark:text-zinc-300"
        >
          {item.status === 'succeeded' ? (
            <CircleCheck
              className="size-3 shrink-0 text-emerald-600 dark:text-emerald-400"
              aria-hidden="true"
            />
          ) : item.status === 'failed' || item.status === 'denied' ? (
            <CircleX
              className="size-3 shrink-0 text-red-500 dark:text-red-400"
              aria-hidden="true"
            />
          ) : item.status === 'awaiting_approval' ? (
            <Hand
              className="size-3 shrink-0 text-amber-600 dark:text-amber-400"
              aria-hidden="true"
            />
          ) : (
            <Loader2
              className="size-3 shrink-0 text-muted motion-safe:animate-spin"
              aria-hidden="true"
            />
          )}
          {toolLabel(item.toolName)}
        </span>
      ))}
    </div>
  );
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

/** "2026-07-12" → "Jul 12" (falls back to the raw string on parse failure). */
function friendlyRecallDate(isoDay: string): string {
  const date = new Date(`${isoDay}T00:00:00`);
  if (Number.isNaN(date.getTime())) return isoDay;
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(date);
}

/** The "recalled from earlier" affordance: what auto-recall drew on for a turn. */
function RecallChip({ sources }: { sources: RecallSource[] }) {
  if (sources.length === 0) return null;
  return (
    <div className="mb-1.5 flex flex-wrap items-center gap-1 text-2xs text-muted">
      <History className="size-3 shrink-0" aria-hidden="true" />
      <span className="font-medium">Remembered:</span>
      {sources.map((source, index) => (
        <span
          key={`${source.date}-${index.toString()}`}
          className="inline-block max-w-56 truncate rounded bg-sunken px-1.5 py-0.5 align-bottom"
          title={`From ${source.date} — ${source.label}`}
        >
          {friendlyRecallDate(source.date)} — {source.label}
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
  const [activity, setActivity] = useState<
    Array<{ toolName: string; status: string; step: number }>
  >([]);
  /** Live provenance for the current streaming turn (the persisted part covers reloads). */
  const [liveRecall, setLiveRecall] = useState<RecallSource[] | null>(null);
  /** "Autonomous" composer toggle: this turn runs free-range (approve-once). */
  const [autonomous, setAutonomous] = useState(false);
  const autonomousRef = useRef(false);
  autonomousRef.current = autonomous;
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
          // Read the toggle through a ref so the memoized transport always sees
          // its current value without re-creating on every keystroke.
          return {
            body: {
              ...body,
              autonomous: autonomousRef.current,
              messages: latestUser ? [latestUser] : [],
            },
          };
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

  const { messages, sendMessage, setMessages, status, error, clearError, stop } = useChat({
    id: conversationId,
    messages: initialMessages,
    transport,
  });

  // Timestamps and day dividers use the browser timezone, so they render only
  // after mount — the server-rendered HTML must not bake in the server's zone.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  // Model-picker popover: closes on outside pointerdown, Escape, or selection.
  const [modelOpen, setModelOpen] = useState(false);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!modelOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!modelMenuRef.current?.contains(event.target as Node)) setModelOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setModelOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [modelOpen]);

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
      setActivity([]);
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
            activity?: Array<{ toolName: string; status: string; step: number }>;
          };
          setActivity(data.activity ?? []);
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
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 pb-4 dark:border-zinc-800">
        <div className="min-w-0">
          <p className="text-2xs font-semibold tracking-[0.14em] text-indigo-700 uppercase dark:text-indigo-300">
            Chat
          </p>
          <h1 className="mt-1 truncate text-xl font-semibold tracking-[-0.03em]">{title}</h1>
          {goalTitle ? (
            <p className="mt-1 truncate text-xs text-zinc-500 dark:text-zinc-400">
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
          <div ref={modelMenuRef} className="relative">
            <button
              type="button"
              aria-haspopup="true"
              aria-expanded={modelOpen}
              onClick={() => setModelOpen((open) => !open)}
              className={`inline-flex items-center gap-1 rounded-lg border border-edge bg-raised px-2.5 py-1.5 text-xs font-medium text-zinc-600 motion-safe:transition-colors hover:bg-sunken dark:text-zinc-300 ${focusRing}`}
            >
              Model
              <ChevronDown
                className={`size-3.5 motion-safe:transition-transform ${modelOpen ? 'rotate-180' : ''}`}
                aria-hidden="true"
              />
            </button>
            {modelOpen ? (
              <div className="absolute top-full right-0 z-10 mt-2 w-56 rounded-xl border border-edge bg-raised p-2 shadow-lg motion-safe:animate-[pop-in_120ms_ease-out]">
                <label
                  htmlFor="conversation-model"
                  className="px-1 text-2xs font-semibold tracking-[0.12em] text-zinc-500 uppercase dark:text-zinc-400"
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
                    setModelOpen(false);
                  }}
                  className="mt-1 w-full rounded-lg border border-edge bg-raised px-2 py-1.5 text-base sm:text-sm"
                >
                  <option value="">Auto</option>
                  {models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.label}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
          </div>
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
          <div className="mx-auto mt-12 flex max-w-md flex-col items-center gap-3 text-center">
            <p className="text-base font-medium text-strong">What can I get moving for you?</p>
            <p className="text-sm leading-6 text-muted">
              Ask for a plan, a document, research — or hand me something to chase down.
            </p>
            <div className="mt-1 flex flex-wrap justify-center gap-2">
              {[
                'Summarize my unread email',
                'What’s on my calendar this week?',
                'Draft a plan for my next trip',
              ].map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => setInput(suggestion)}
                  className={btnSm.outline}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {messages.map((message, messageIndex) => {
              const parts = message.parts as Array<
                UIMessage['parts'][number] | InlineApprovalPart | InlineBudgetRequestPart
              >;
              const approvalParts = parts.filter(
                (part): part is InlineApprovalPart => part.type === 'approval',
              );
              const budgetParts = parts.filter(
                (part): part is InlineBudgetRequestPart => part.type === 'budget-request',
              );
              const textParts = parts.filter(
                (part): part is Extract<UIMessage['parts'][number], { type: 'text' }> =>
                  part.type === 'text',
              );
              // The grouped card repeats the executor's prose approval list —
              // hide the duplicate text, never the persisted message itself.
              const visibleTextParts =
                approvalParts.length > 0
                  ? textParts.filter((part) => !isApprovalProseNotice(part.text))
                  : textParts;
              const fullText = visibleTextParts
                .map((part) => part.text)
                .join('')
                .trim();
              const isNotice =
                message.role === 'assistant' &&
                approvalParts.length === 0 &&
                budgetParts.length === 0 &&
                fullText !== '' &&
                isContractNotice(fullText);
              const date = messageDate(message);
              const previousDate =
                messageIndex > 0 ? messageDate(messages[messageIndex - 1] as UIMessage) : null;
              const showDivider =
                mounted && date !== null && (previousDate === null || !sameDay(previousDate, date));
              const nextMessage = messages[messageIndex + 1];
              const showTime =
                mounted && date !== null && (!nextMessage || nextMessage.role !== message.role);
              const recallSources = recallSourcesOf(message);
              const hasBubble = visibleTextParts.length > 0 && !isNotice;
              return (
                <div key={message.id} className="flex flex-col gap-2">
                  {showDivider && date ? <DayDivider label={dayLabel(date, new Date())} /> : null}
                  {isNotice ? (
                    <ContractNotice text={fullText} />
                  ) : hasBubble ? (
                    <div
                      className={
                        message.role === 'user' ? 'flex justify-end' : 'flex justify-start'
                      }
                    >
                      <div
                        className={
                          message.role === 'user'
                            ? 'max-w-[88%] rounded-2xl rounded-br-md bg-accent px-3 py-2 text-sm text-white shadow-sm sm:max-w-[80%]'
                            : 'max-w-[88%] rounded-2xl rounded-bl-md border border-edge bg-raised px-3 py-2 text-sm shadow-sm sm:max-w-[80%]'
                        }
                      >
                        {message.role === 'assistant' ? (
                          <RecallChip sources={recallSources} />
                        ) : null}
                        {visibleTextParts.map((part, index) =>
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
                          ),
                        )}
                      </div>
                    </div>
                  ) : null}
                  {approvalParts.length > 0 ? <ApprovalGroup parts={approvalParts} /> : null}
                  {budgetParts.map((part) => (
                    <InlineBudgetRequest key={part.taskId} part={part} />
                  ))}
                  {showTime && date ? (
                    <p
                      className={`text-2xs text-muted ${
                        message.role === 'user' ? 'self-end' : 'self-start'
                      }`}
                    >
                      {timeLabel(date)}
                    </p>
                  ) : null}
                </div>
              );
            })}
            {status === 'submitted' ? <TypingDots /> : null}
            {asyncTurn ? (
              <div className="flex flex-col gap-2">
                <p className="text-sm text-muted motion-safe:animate-pulse">Working on it…</p>
                <ActivityChips activity={activity} />
              </div>
            ) : null}
            {asyncNote ? <p className="text-xs text-muted">{asyncNote}</p> : null}
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
        className="mobile-safe-bottom flex flex-col gap-2 border-t border-zinc-200 pt-4 dark:border-zinc-800"
      >
        <div className="flex items-end gap-2">
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
            className="max-h-40 flex-1 resize-none rounded-xl border border-edge bg-raised px-3 py-2.5 text-base outline-none placeholder:text-zinc-400 focus:border-accent focus:ring-3 focus:ring-accent/15 motion-safe:transition-shadow sm:text-sm"
          />
          {status === 'submitted' || status === 'streaming' ? (
            <button
              type="button"
              onClick={() => stop()}
              title="Stop generating"
              className={`inline-flex items-center gap-1.5 rounded-xl border border-edge bg-raised px-4 py-2.5 text-sm font-medium text-zinc-700 motion-safe:transition-colors hover:bg-sunken dark:text-zinc-300 ${focusRing}`}
            >
              <Square className="size-3 fill-current" aria-hidden="true" />
              Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={busy || input.trim() === ''}
              className={`rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white shadow-sm motion-safe:transition-colors hover:bg-accent-hover disabled:opacity-50 ${focusRing}`}
            >
              Send
            </button>
          )}
        </div>
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            aria-pressed={autonomous}
            onClick={() => setAutonomous((value) => !value)}
            title="Run this request free-range: I act without asking for each approval. Sensitive steps (memory from web content, unknown recipients, logged-in browsing, networked code) still ask, and budget caps still apply."
            className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-2xs font-medium motion-safe:transition-colors ${focusRing} ${
              autonomous
                ? 'border-amber-400 bg-amber-100 text-amber-900 dark:border-amber-600 dark:bg-amber-950 dark:text-amber-300'
                : 'border-edge text-muted hover:bg-sunken'
            }`}
          >
            <Zap className="size-3" aria-hidden="true" />
            Autonomous
            <span className="sr-only">
              — act without asking me to approve each step; sensitive steps and budget caps still
              apply
            </span>
          </button>
          <span className="hidden text-2xs text-muted sm:block">
            Enter to send · Shift+Enter for a new line
          </span>
        </div>
      </form>
    </div>
  );
}
