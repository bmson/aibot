'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type UIMessage } from 'ai';
import {
  ArrowDown,
  ArrowUp,
  CalendarDays,
  CircleCheck,
  CircleX,
  Hand,
  History,
  Inbox,
  Loader2,
  MoonStar,
  Route,
  ShieldCheck,
  Sparkles,
  Square,
  TriangleAlert,
  Zap,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useTransition } from 'react';
import { AvatarMark } from '@/app/brand-mark';
import { hasContractNoticePart, isApprovalProseNotice, isContractNotice } from '@/lib/chat-notices';
import { eventCardClass, focusRing } from '@/lib/ui';
import { SubmitButton } from '@/lib/ui-client';
import { toolLabel } from '@/lib/views';
import { archiveConversation, changeConversationModel, restoreConversation } from '../actions';
import { ApprovalGroup } from './approval-group';
import type { InlineApprovalPart } from './inline-approval';
import { InlineBudgetRequest, type InlineBudgetRequestPart } from './inline-budget-request';
import { MessageMarkdown } from './markdown';

interface ChatClientProps {
  conversationId: string;
  title: string;
  /** The assistant's display name — the chat header shows who you're talking to. */
  agentName: string;
  initialMessages: UIMessage[];
  models: { id: string; label: string }[];
  modelOverride: string | null;
  goalTitle?: string;
  /** A task created by the goal form before this page opened. */
  initialAsyncTurn?: { taskId: string; cursor: string };
  archived: boolean;
  /** The one forever thread at /chat — it needs no title header of its own. */
  isPrimary: boolean;
  canArchive: boolean;
  initialNotice?: string;
  /** Pre-fills the composer (e.g. an "ask about this document" deep-link). */
  initialInput?: string;
}

const ASYNC_ACK_TEXT = 'Got it — I’m working on this now. I’ll post the result here.';

/**
 * Composer slash commands. Typing "/" lists them so nobody has to know the
 * vocabulary up front; picking one completes it into the composer, where the
 * command's own palette (e.g. /model) takes over.
 */
const SLASH_COMMANDS = [
  { command: '/model', hint: 'Switch which model answers this chat', icon: Sparkles },
] as const;

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
  // Generous vertical air: dividers are chapter breaks, not rules on a form.
  // The hairlines fade toward the edges so the floating chip carries the date.
  return (
    <div aria-hidden="true" className="flex items-center gap-4 pt-7 pb-3 [div:first-child>&]:pt-1">
      <span className="h-px flex-1 bg-gradient-to-r from-transparent to-edge" />
      <span className="rounded-full bg-raised px-3 py-1 text-2xs font-semibold tracking-[0.08em] text-muted uppercase shadow-[0_1px_2px_rgb(23_25_35/0.05)] ring-1 ring-edge/70">
        {label}
      </span>
      <span className="h-px flex-1 bg-gradient-to-l from-transparent to-edge" />
    </div>
  );
}

/**
 * One presence row for every "assistant is busy" state — the pre-stream think,
 * the async hand-off, and live tool work — so they read as one voice instead of
 * three different indicators. The label shimmers while motion is allowed;
 * reduced-motion readers get plain muted text.
 */
function PresenceRow({
  name,
  phase,
  activity,
}: {
  name: string;
  phase: 'thinking' | 'starting' | 'working';
  activity: Array<{ toolName: string; status: string; step: number }>;
}) {
  const label =
    phase === 'thinking' ? 'Thinking…' : phase === 'starting' ? 'Starting the work…' : 'Working…';
  return (
    <div className="flex w-full max-w-3xl items-start gap-3">
      <AvatarMark name={name} size="sm" active />
      <div className="min-w-0 flex-1 pt-1">
        <span className="sr-only">The assistant is working</span>
        <span
          aria-hidden="true"
          className="text-[13px] text-muted motion-safe:animate-[shimmer-text_2.2s_linear_infinite] motion-safe:bg-[linear-gradient(90deg,var(--content-muted),var(--content-strong),var(--content-muted))] motion-safe:bg-[length:200%_100%] motion-safe:bg-clip-text motion-safe:text-transparent"
        >
          {label}
        </span>
        {activity.length > 0 ? (
          <div className="mt-2">
            <ActivityTrail activity={activity} />
          </div>
        ) : null}
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
    <div className={`${eventCardClass} max-w-3xl sm:ml-9`}>
      <div className="flex items-center gap-2.5 border-b border-edge/60 bg-sunken/40 px-4 py-2">
        <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-sunken text-muted">
          <ShieldCheck className="size-3.5" aria-hidden="true" />
        </span>
        <p className="text-2xs font-semibold tracking-[0.08em] text-muted uppercase">
          System check
        </p>
      </div>
      <div className="px-4 py-3">
        <p className="break-words text-[13px] leading-5 text-zinc-600 [overflow-wrap:anywhere] dark:text-zinc-300">
          {text}
        </p>
        <details className="mt-2">
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

/**
 * Proactive notifications are part of the assistant's activity stream, not a
 * conversational reply. Give them a compact editorial treatment so a string
 * of updates remains scannable without hiding any of the original detail.
 */
function AssistantUpdate({ text, sources }: { text: string; sources: RecallSource[] }) {
  const attention = /(?:⚠️|anomaly|waiting for you|needs? (?:your )?attention)/i.test(text);
  const reflection = /(?:🌙|while you slept|reflected)/i.test(text);
  const Icon = attention ? TriangleAlert : reflection ? MoonStar : Sparkles;
  const label = attention ? 'Needs attention' : reflection ? 'Quiet update' : 'Update';
  const tone = attention
    ? {
        edge: 'border-l-amber-400 dark:border-l-amber-600',
        chip: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
        label: 'text-amber-700 dark:text-amber-300',
      }
    : reflection
      ? {
          edge: 'border-l-violet-400 dark:border-l-violet-600',
          chip: 'bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300',
          label: 'text-violet-700 dark:text-violet-300',
        }
      : {
          edge: 'border-l-accent/70',
          chip: 'bg-accent/10 text-accent',
          label: 'text-accent',
        };

  return (
    <section className={`${eventCardClass} max-w-3xl border-l-[3px] sm:ml-9 ${tone.edge}`}>
      <div className="min-w-0 px-4 py-3">
        <div className="mb-2 flex items-center gap-2.5">
          <span
            className={`inline-flex size-6 shrink-0 items-center justify-center rounded-md ${tone.chip}`}
          >
            <Icon className="size-3.5" aria-hidden="true" />
          </span>
          <p className={`text-2xs font-semibold tracking-[0.1em] uppercase ${tone.label}`}>
            {label}
          </p>
        </div>
        <RecallNote sources={sources} />
        <div className="break-words text-[14px] leading-6 text-strong [overflow-wrap:anywhere]">
          <MessageMarkdown text={text} />
        </div>
      </div>
    </section>
  );
}

/** Live tool activity as a small work trail — events are not chat bubbles. */
function ActivityTrail({
  activity,
}: {
  activity: Array<{ toolName: string; status: string; step: number }>;
}) {
  if (activity.length === 0) return null;
  return (
    <section
      className="min-w-0 max-w-full rounded-xl bg-sunken/50 px-4 py-3 ring-1 ring-edge/50"
      aria-label="AI Bot activity"
    >
      <p className="mb-2 text-2xs font-semibold tracking-[0.1em] text-muted uppercase">
        Work trail
      </p>
      <ol className="space-y-2">
        {activity.map((item) => (
          <li key={`${item.step}-${item.toolName}`} className="flex min-w-0 items-center gap-2.5">
            {item.status === 'succeeded' ? (
              <CircleCheck
                className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
                aria-hidden="true"
              />
            ) : item.status === 'failed' || item.status === 'denied' ? (
              <CircleX
                className="size-3.5 shrink-0 text-red-500 dark:text-red-400"
                aria-hidden="true"
              />
            ) : item.status === 'awaiting_approval' ? (
              <Hand
                className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400"
                aria-hidden="true"
              />
            ) : (
              <Loader2
                className="size-3.5 shrink-0 text-accent motion-safe:animate-spin"
                aria-hidden="true"
              />
            )}
            <span className="min-w-0 flex-1 break-words text-[13px] text-strong [overflow-wrap:anywhere]">
              {toolLabel(item.toolName)}
            </span>
            <span className="shrink-0 text-2xs text-muted">
              {item.status === 'succeeded'
                ? 'Done'
                : item.status === 'awaiting_approval'
                  ? 'Waiting for you'
                  : item.status === 'failed' || item.status === 'denied'
                    ? 'Stopped'
                    : 'Working'}
            </span>
          </li>
        ))}
      </ol>
    </section>
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
function RecallNote({ sources }: { sources: RecallSource[] }) {
  if (sources.length === 0) return null;
  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-2xs text-muted">
      <History className="size-3 shrink-0" aria-hidden="true" />
      <span className="font-medium">Drawing on</span>
      {sources.map((source, index) => (
        <span
          key={`${source.date}-${index.toString()}`}
          className="inline-block max-w-56 truncate align-bottom"
          title={`From ${source.date} — ${source.label}`}
        >
          {index > 0 ? '· ' : ''}
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
  agentName,
  initialMessages,
  models,
  modelOverride,
  goalTitle,
  initialAsyncTurn,
  archived,
  isPrimary,
  canArchive,
  initialNotice,
  initialInput,
}: ChatClientProps) {
  const [input, setInput] = useState(initialInput ?? '');
  const [fallbackNote, setFallbackNote] = useState<string | null>(null);
  const [isSwitching, startTransition] = useTransition();
  const [selectedModel, setSelectedModel] = useState(modelOverride);
  const [modelError, setModelError] = useState<string | null>(null);
  /** Keyboard cursor into the /model palette (arrow keys move it, Enter picks). */
  const [modelHighlight, setModelHighlight] = useState(0);
  /** Whether the scroller is pinned near the bottom (drives the jump pill). */
  const [atBottom, setAtBottom] = useState(true);
  /** New messages that arrived while scrolled up (the pill shows a dot). */
  const [unseenCount, setUnseenCount] = useState(0);
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messageScrollerRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const previousMessageCountRef = useRef(initialMessages.length);
  /** Messages present at mount render static; only genuinely new ones animate in. */
  const initialMessageIdsRef = useRef<Set<string> | null>(null);
  initialMessageIdsRef.current ??= new Set(initialMessages.map((message) => message.id));

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

  useEffect(() => {
    setSelectedModel(modelOverride);
  }, [modelOverride]);

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
  const displayTitle = title === 'Untitled' ? 'New conversation' : title;
  const notificationMode = displayTitle.toLowerCase() === 'notifications';
  const commandInput = input.trimStart();
  const modelCommandOpen = /^\/model(?:\s.*)?$/i.test(commandInput);
  const modelQuery = modelCommandOpen
    ? commandInput
        .replace(/^\/model\s*/i, '')
        .trim()
        .toLowerCase()
    : '';
  const modelOptions = useMemo(
    () =>
      [
        { id: null, label: 'Auto', detail: 'Use the best model for the request' },
        ...models.map((model) => ({ ...model, detail: model.id })),
      ].filter(
        (model) =>
          modelQuery === '' ||
          model.label.toLowerCase().includes(modelQuery) ||
          model.detail.toLowerCase().includes(modelQuery),
      ),
    [models, modelQuery],
  );
  const selectedModelLabel =
    selectedModel === null
      ? 'Auto'
      : (models.find((model) => model.id === selectedModel)?.label ?? selectedModel);

  // The "/" affordance: a bare slash token lists the available commands, so
  // nobody has to already know "/model". Once the token completes into a real
  // command, that command's own palette takes over (modelCommandOpen above).
  const slashToken =
    /^\/\S*$/.test(commandInput) && !modelCommandOpen ? commandInput.slice(1).toLowerCase() : null;
  const commandMatches =
    slashToken !== null
      ? SLASH_COMMANDS.filter((entry) => entry.command.slice(1).startsWith(slashToken))
      : [];
  const commandPaletteOpen = commandMatches.length > 0;
  const [commandHighlight, setCommandHighlight] = useState(0);
  // Clamp instead of resetting via effect — the list is tiny and refilters
  // on every keystroke, so an out-of-range cursor just snaps to the end.
  const safeCommandHighlight = Math.min(commandHighlight, Math.max(0, commandMatches.length - 1));

  const completeCommand = (command: string) => {
    setInput(command);
    textareaRef.current?.focus();
  };

  // Opening the palette (or refiltering it) lands the cursor on the current
  // model, or the top match when it's filtered out.
  useEffect(() => {
    if (!modelCommandOpen) return;
    const selectedIndex = modelOptions.findIndex((model) => model.id === selectedModel);
    setModelHighlight(selectedIndex >= 0 ? selectedIndex : 0);
  }, [modelCommandOpen, modelOptions, selectedModel]);

  // Keep the highlighted option in view as the arrows walk the list.
  useEffect(() => {
    if (!modelCommandOpen) return;
    document.getElementById(`model-option-${modelHighlight}`)?.scrollIntoView({ block: 'nearest' });
  }, [modelCommandOpen, modelHighlight]);

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      const scroller = messageScrollerRef.current;
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  });

  // A message landed while the reader was scrolled up — count it so the jump
  // pill can show there's something new below.
  useEffect(() => {
    if (messages.length > previousMessageCountRef.current && !stickToBottomRef.current) {
      setUnseenCount((count) => count + (messages.length - previousMessageCountRef.current));
    }
    previousMessageCountRef.current = messages.length;
  }, [messages.length]);

  // Grow the composer with its content, up to the CSS max-height cap. `input`
  // is the trigger; the new height is read from the DOM, not from `input`.
  // biome-ignore lint/correctness/useExhaustiveDependencies: input drives the re-measure
  useLayoutEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = '0px';
    element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
  }, [input]);

  const jumpToLatest = () => {
    stickToBottomRef.current = true;
    setAtBottom(true);
    setUnseenCount(0);
    const scroller = messageScrollerRef.current;
    if (!scroller) return;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: reduceMotion ? 'auto' : 'smooth' });
  };

  const submitCurrentMessage = () => {
    const text = input.trim();
    if (!text || busy) return;
    // Slash commands are local composer controls, never conversation messages.
    if (/^\/model(?:\s.*)?$/i.test(text)) return;
    if (commandPaletteOpen) return;
    stickToBottomRef.current = true;
    setInput('');
    setLiveRecall(null);
    void sendMessage({ text });
  };

  const chooseModel = (modelId: string | null) => {
    if (isSwitching) return;
    setModelError(null);
    startTransition(async () => {
      try {
        await changeConversationModel(conversationId, modelId);
        setSelectedModel(modelId);
        setInput('');
      } catch {
        setModelError('Could not switch models. Try again.');
      }
    });
  };

  return (
    <div className="mx-auto flex h-[calc(100dvh-6.5rem)] w-full min-w-0 max-w-5xl flex-col lg:h-[calc(100vh-5rem)]">
      {/* The primary thread is the whole surface — it needs no title. Side and
          goal chats keep a slim header so you know which one you're in. */}
      {!isPrimary ? (
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-edge pb-3">
          <div className="min-w-0">
            <h1
              className="truncate font-display text-lg font-semibold tracking-[-0.03em]"
              title={displayTitle}
            >
              {displayTitle}
            </h1>
            {goalTitle ? (
              <p className="mt-0.5 truncate text-xs text-muted">Working toward: {goalTitle}</p>
            ) : null}
            {archived ? (
              <p className="mt-0.5 text-xs text-muted">
                Archived — sending a message restores this chat.
              </p>
            ) : null}
          </div>
          {archived || canArchive ? (
            <div className="flex min-w-0 items-center gap-2">
              {archived ? (
                <form action={restoreConversation.bind(null, conversationId)}>
                  <SubmitButton variant="outline" pendingLabel="Restoring…">
                    Restore
                  </SubmitButton>
                </form>
              ) : canArchive ? (
                <form action={archiveConversation.bind(null, conversationId)}>
                  <SubmitButton variant="outline" pendingLabel="Archiving…">
                    Archive
                  </SubmitButton>
                </form>
              ) : null}
            </div>
          ) : null}
        </header>
      ) : null}
      {initialNotice ? (
        <div
          role="alert"
          className="mt-3 border-l-2 border-amber-400 py-1 pl-4 text-[13px] leading-5 text-amber-900 dark:border-amber-700 dark:text-amber-100"
        >
          {initialNotice}
        </div>
      ) : null}

      <div
        ref={messageScrollerRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          const bottom = element.scrollHeight - element.scrollTop - element.clientHeight < 120;
          stickToBottomRef.current = bottom;
          setAtBottom(bottom);
          if (bottom) setUnseenCount(0);
        }}
        className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto py-6 sm:py-8"
      >
        {messages.length === 0 ? (
          <div className="mx-auto mt-8 flex max-w-xl flex-col items-center text-center sm:mt-14">
            <span className="inline-flex size-12 items-center justify-center rounded-2xl bg-sunken text-accent">
              <Sparkles className="size-5" aria-hidden="true" />
            </span>
            <p className="mt-4 font-display text-2xl font-semibold tracking-[-0.035em] text-strong">
              What should we move forward?
            </p>
            {/* A small hand-drawn stroke that sketches itself in under the
                greeting — the page's one flourish. Static for reduced motion. */}
            <svg aria-hidden="true" viewBox="0 0 140 10" fill="none" className="mt-2 h-2.5 w-36">
              <path
                d="M3 7 C 28 3, 55 8.5, 82 5 S 125 3.5, 137 5.5"
                stroke="var(--accent)"
                strokeOpacity="0.65"
                strokeWidth="2.5"
                strokeLinecap="round"
                className="[stroke-dasharray:160] [stroke-dashoffset:160] motion-safe:animate-[draw-in_700ms_ease-out_250ms_forwards] motion-reduce:[stroke-dashoffset:0]"
              />
            </svg>
            <p className="mt-2 max-w-md text-[15px] leading-6 text-muted">
              Start with an outcome. AI Bot can research, plan, draft, schedule, and keep following
              up when the work takes time.
            </p>
            <div className="mt-6 grid w-full gap-2 sm:grid-cols-3">
              {[
                {
                  text: 'Summarize my unread email',
                  label: 'Clear the inbox',
                  icon: Inbox,
                },
                {
                  text: 'What’s on my calendar this week?',
                  label: 'Review the week',
                  icon: CalendarDays,
                },
                {
                  text: 'Draft a plan for my next trip',
                  label: 'Plan a trip',
                  icon: Route,
                },
              ].map((suggestion, index) => {
                const SuggestionIcon = suggestion.icon;
                return (
                  <button
                    key={suggestion.text}
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      stickToBottomRef.current = true;
                      setAtBottom(true);
                      void sendMessage({ text: suggestion.text });
                    }}
                    style={{ animationDelay: `${index * 60}ms` }}
                    className={`mobile-touch-target flex min-h-20 flex-col items-start justify-between rounded-2xl bg-raised p-3 text-left shadow-[0_1px_2px_rgb(23_25_35/0.06)] ring-1 ring-edge/60 motion-safe:animate-[presence-arrive_320ms_ease-out_both] motion-safe:transition-[transform,box-shadow] hover:-translate-y-0.5 hover:shadow-[0_8px_24px_rgb(23_25_35/0.10)] active:translate-y-0 disabled:opacity-60 ${focusRing}`}
                  >
                    <SuggestionIcon className="size-4 text-accent" aria-hidden="true" />
                    <span className="mt-3 text-[13px] font-medium text-strong">
                      {suggestion.label}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="flex min-w-0 flex-col">
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
                (hasContractNoticePart(parts) || isContractNotice(fullText));
              const date = messageDate(message);
              const previousDate =
                messageIndex > 0 ? messageDate(messages[messageIndex - 1] as UIMessage) : null;
              const showDivider =
                mounted && date !== null && (previousDate === null || !sameDay(previousDate, date));
              const nextMessage = messages[messageIndex + 1];
              const showTime =
                mounted &&
                date !== null &&
                (notificationMode || !nextMessage || nextMessage.role !== message.role);
              const recallSources = recallSourcesOf(message);
              const hasBubble = visibleTextParts.length > 0 && !isNotice;
              const isNewMessage = !initialMessageIdsRef.current?.has(message.id);
              const previousMessage = messageIndex > 0 ? messages[messageIndex - 1] : undefined;
              // A "run" is a streak of turns from the same speaker — the avatar
              // shows once at the top and the follow-ons tuck in under it.
              const startsRun =
                !previousMessage || previousMessage.role !== message.role || showDivider;
              const streamingCaret =
                status === 'streaming' &&
                message.role === 'assistant' &&
                messageIndex === messages.length - 1;
              return (
                <div
                  key={message.id}
                  className={`flex min-w-0 flex-col gap-2 first:mt-0 ${startsRun ? 'mt-7' : 'mt-2'} ${
                    isNewMessage ? 'motion-safe:animate-[message-in_220ms_ease-out]' : ''
                  }`}
                >
                  {showDivider && date ? <DayDivider label={dayLabel(date, new Date())} /> : null}
                  {isNotice ? (
                    <ContractNotice text={fullText} />
                  ) : notificationMode && message.role === 'assistant' && hasBubble ? (
                    <AssistantUpdate text={fullText} sources={recallSources} />
                  ) : hasBubble ? (
                    <div
                      className={
                        message.role === 'user' ? 'flex justify-end' : 'flex justify-start'
                      }
                    >
                      {message.role === 'assistant' ? (
                        <div className="flex w-full max-w-3xl items-start gap-3">
                          {startsRun ? (
                            <AvatarMark name={agentName} size="sm" className="mt-1.5" />
                          ) : (
                            <span aria-hidden="true" className="w-6 shrink-0" />
                          )}
                          {/* The reply is speech, so it gets a bubble: raised
                              and outlined against the canvas, sized to fit. */}
                          <div className="min-w-0 flex-1">
                            <div
                              className={`w-fit min-w-0 max-w-full rounded-2xl bg-raised px-4 py-3 text-[15px] leading-6 shadow-[0_1px_2px_rgb(23_25_35/0.05)] ring-1 ring-edge/60 ${
                                startsRun ? 'rounded-tl-md' : ''
                              } ${streamingCaret ? 'chat-caret' : ''}`}
                            >
                              <RecallNote sources={recallSources} />
                              {visibleTextParts.map((part, index) => (
                                <MessageMarkdown
                                  key={`${message.id}-${index.toString()}`}
                                  text={part.text}
                                />
                              ))}
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div className="min-w-0 max-w-[88%] rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-[14px] leading-5 text-white shadow-sm sm:max-w-[76%]">
                          {visibleTextParts.map((part, index) => (
                            <p
                              key={`${message.id}-${index.toString()}`}
                              className="break-words whitespace-pre-wrap [overflow-wrap:anywhere]"
                            >
                              {part.text}
                            </p>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : null}
                  {approvalParts.length > 0 ? <ApprovalGroup parts={approvalParts} /> : null}
                  {budgetParts.map((part) => (
                    <InlineBudgetRequest key={part.taskId} part={part} />
                  ))}
                  {showTime && date ? (
                    <p
                      title={date.toLocaleString()}
                      className={`text-2xs text-muted ${
                        message.role === 'user' ? 'self-end' : 'ml-9 self-start'
                      }`}
                    >
                      {timeLabel(date)}
                    </p>
                  ) : null}
                </div>
              );
            })}
            {status === 'submitted' ? (
              <div className="mt-5">
                <PresenceRow name={agentName} phase="thinking" activity={[]} />
              </div>
            ) : asyncTurn ? (
              <div className="mt-5">
                <PresenceRow
                  name={agentName}
                  phase={activity.length > 0 ? 'working' : 'starting'}
                  activity={activity}
                />
              </div>
            ) : null}
            {asyncNote ? <p className="mt-3 text-xs text-muted">{asyncNote}</p> : null}
            {liveRecall ? <RecallNote sources={liveRecall} /> : null}
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
        className="mobile-safe-bottom sticky bottom-0 min-w-0 border-t border-edge bg-surface/95 pt-3 backdrop-blur sm:pb-3 relative"
      >
        {!atBottom && messages.length > 0 ? (
          <div className="pointer-events-none absolute inset-x-0 -top-14 flex justify-center">
            <button
              type="button"
              onClick={jumpToLatest}
              aria-label="Jump to latest"
              className={`pointer-events-auto mobile-touch-target inline-flex h-9 items-center gap-1.5 rounded-full bg-raised px-3.5 text-xs font-medium text-strong shadow-[0_4px_16px_rgb(23_25_35/0.14)] ring-1 ring-edge motion-safe:animate-[pop-in_140ms_ease-out] ${focusRing}`}
            >
              <ArrowDown className="size-3.5" aria-hidden="true" />
              Jump to latest
              {unseenCount > 0 ? (
                <span aria-hidden="true" className="size-1.5 rounded-full bg-accent" />
              ) : null}
            </button>
          </div>
        ) : null}
        {commandPaletteOpen ? (
          <section
            aria-label="Commands"
            className="mb-2 min-w-0 overflow-hidden rounded-2xl bg-raised shadow-[0_6px_24px_rgb(23_25_35/0.08)] ring-1 ring-edge motion-safe:animate-[pop-in_120ms_ease-out]"
          >
            <div className="flex min-w-0 items-center justify-between gap-3 border-b border-edge px-4 py-2.5">
              <p className="text-[13px] font-semibold text-strong">Commands</p>
              <span className="hidden shrink-0 text-2xs text-muted sm:block">
                ↑↓ choose · Enter complete · Esc dismiss
              </span>
            </div>
            <div id="command-listbox" role="listbox" aria-label="Commands" className="p-1.5">
              {commandMatches.map((entry, index) => {
                const highlighted = index === safeCommandHighlight;
                const EntryIcon = entry.icon;
                return (
                  <button
                    key={entry.command}
                    id={`command-option-${index}`}
                    type="button"
                    role="option"
                    aria-selected={highlighted}
                    onMouseMove={() => setCommandHighlight(index)}
                    onClick={() => completeCommand(entry.command)}
                    className={`mobile-touch-target flex min-h-11 w-full min-w-0 items-center gap-3 rounded-xl px-3 py-2 text-left motion-safe:transition-colors ${focusRing} ${
                      highlighted ? 'bg-sunken text-strong' : 'text-strong hover:bg-sunken'
                    }`}
                  >
                    <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
                      <EntryIcon className="size-3.5" aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-[13px] font-medium">
                        {entry.command}
                      </span>
                      <span className="block truncate text-2xs text-muted">{entry.hint}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        ) : null}
        {modelCommandOpen ? (
          <section
            aria-label="Choose response model"
            className="mb-2 min-w-0 overflow-hidden rounded-2xl bg-raised shadow-[0_6px_24px_rgb(23_25_35/0.08)] ring-1 ring-edge motion-safe:animate-[pop-in_120ms_ease-out]"
          >
            <div className="flex min-w-0 items-center justify-between gap-3 border-b border-edge px-4 py-3">
              <div className="min-w-0">
                <p className="text-[13px] font-semibold text-strong">Response model</p>
                <p className="truncate text-2xs text-muted">Currently {selectedModelLabel}</p>
              </div>
              {isSwitching ? (
                <span className="inline-flex shrink-0 items-center gap-1.5 text-2xs text-muted">
                  <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                  Switching…
                </span>
              ) : (
                <span className="hidden shrink-0 text-2xs text-muted sm:block">
                  ↑↓ choose · Enter select · Esc close
                </span>
              )}
            </div>
            <div
              id="model-listbox"
              role="listbox"
              aria-label="Response model"
              className="max-h-56 overflow-y-auto p-1.5"
            >
              {modelOptions.length > 0 ? (
                modelOptions.map((model, index) => {
                  const active = selectedModel === model.id;
                  const highlighted = index === modelHighlight;
                  return (
                    <button
                      key={model.id ?? 'auto'}
                      id={`model-option-${index}`}
                      type="button"
                      role="option"
                      aria-selected={active}
                      disabled={isSwitching}
                      onMouseMove={() => setModelHighlight(index)}
                      onClick={() => chooseModel(model.id)}
                      className={`mobile-touch-target flex min-h-11 w-full min-w-0 items-center gap-3 rounded-xl px-3 py-2 text-left motion-safe:transition-colors ${focusRing} ${
                        active
                          ? 'bg-accent/10 text-accent'
                          : highlighted
                            ? 'bg-sunken text-strong'
                            : 'text-strong hover:bg-sunken'
                      } ${active && highlighted ? 'ring-1 ring-accent/40' : ''}`}
                    >
                      <span
                        aria-hidden="true"
                        className={`size-2 shrink-0 rounded-full ${
                          active ? 'bg-accent' : 'bg-edge'
                        }`}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium">
                          {model.label}
                        </span>
                        <span className="block truncate text-2xs text-muted">{model.detail}</span>
                      </span>
                    </button>
                  );
                })
              ) : (
                <p className="px-3 py-4 text-center text-[13px] text-muted">
                  No models match “{modelQuery}”
                </p>
              )}
            </div>
            {modelError ? (
              <p role="alert" className="border-t border-edge px-4 py-2 text-xs text-red-700">
                {modelError}
              </p>
            ) : null}
          </section>
        ) : null}
        <div
          data-testid="chat-composer-surface"
          className="min-w-0 overflow-hidden rounded-2xl bg-raised shadow-[0_6px_24px_rgb(23_25_35/0.08)] ring-1 ring-edge motion-safe:transition-shadow focus-within:shadow-[0_10px_32px_rgb(91_92_226/0.12)] focus-within:ring-accent/40"
        >
          <textarea
            ref={textareaRef}
            aria-label="Message"
            aria-controls={
              modelCommandOpen
                ? 'model-listbox'
                : commandPaletteOpen
                  ? 'command-listbox'
                  : undefined
            }
            aria-activedescendant={
              modelCommandOpen
                ? `model-option-${modelHighlight}`
                : commandPaletteOpen
                  ? `command-option-${safeCommandHighlight}`
                  : undefined
            }
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              // While the /model palette is open the arrows drive it, Enter picks
              // the highlighted model, and Escape closes it — so none of those
              // reach the send handler.
              if (modelCommandOpen) {
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  setModelHighlight((h) =>
                    modelOptions.length ? (h + 1) % modelOptions.length : 0,
                  );
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  setModelHighlight((h) =>
                    modelOptions.length ? (h - 1 + modelOptions.length) % modelOptions.length : 0,
                  );
                } else if (
                  event.key === 'Enter' &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  const choice = modelOptions[modelHighlight];
                  if (choice && !isSwitching) chooseModel(choice.id);
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  setInput('');
                }
                return;
              }
              // The "/" palette: arrows move the cursor, Enter or Tab complete
              // the highlighted command, Escape dismisses.
              if (commandPaletteOpen) {
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  setCommandHighlight((h) => (h + 1) % commandMatches.length);
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  setCommandHighlight(
                    (h) => (h - 1 + commandMatches.length) % commandMatches.length,
                  );
                } else if (
                  event.key === 'Tab' ||
                  (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing)
                ) {
                  event.preventDefault();
                  const choice = commandMatches[safeCommandHighlight];
                  if (choice) completeCommand(choice.command);
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  setInput('');
                }
                return;
              }
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                formRef.current?.requestSubmit();
              }
            }}
            placeholder="Ask anything… type / for commands"
            rows={1}
            className="block max-h-40 min-h-12 w-full min-w-0 resize-none border-0 bg-transparent px-4 pt-3 pb-2 text-base outline-none placeholder:text-muted/70 sm:text-sm"
          />
          <div className="flex min-w-0 items-center justify-between gap-2 border-t border-edge/70 px-2 py-2">
            <button
              data-testid="chat-autonomy-mode"
              type="button"
              aria-pressed={autonomous}
              aria-label={
                autonomous
                  ? 'Autonomous mode on. Tap to ask before acting.'
                  : 'Ask before acting. Tap to turn on autonomous mode.'
              }
              onClick={() => setAutonomous((value) => !value)}
              title="Autonomous mode acts without asking for each routine approval. Sensitive steps and budget caps still require permission."
              className={`inline-flex h-10 min-w-0 items-center gap-1.5 rounded-xl px-3 text-xs font-medium motion-safe:transition-[background-color,color,transform] motion-safe:active:translate-y-px ${focusRing} ${
                autonomous
                  ? 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300'
                  : 'bg-sunken text-muted hover:text-strong'
              }`}
            >
              <Zap className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{autonomous ? 'Autonomous on' : 'Ask first'}</span>
              <span className="sr-only">
                . Sensitive steps including unknown recipients and logged-in browsing still ask, and
                budget caps still apply.
              </span>
            </button>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setInput('/model');
                  textareaRef.current?.focus();
                }}
                aria-label={`Response model: ${selectedModelLabel}. Tap to change.`}
                title="Switch response model"
                className={`hidden h-10 items-center gap-1.5 rounded-xl px-3 text-xs font-medium text-muted motion-safe:transition-colors hover:bg-sunken hover:text-strong sm:inline-flex ${focusRing}`}
              >
                <Sparkles className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="max-w-[14ch] truncate">{selectedModelLabel}</span>
              </button>
              {status === 'submitted' || status === 'streaming' ? (
                <button
                  type="button"
                  onClick={() => stop()}
                  title="Stop generating"
                  className={`inline-flex h-10 shrink-0 items-center gap-1.5 rounded-xl border border-edge bg-raised px-4 text-sm font-medium text-strong motion-safe:animate-[pop-in_120ms_ease-out] motion-safe:transition-colors hover:bg-sunken active:bg-sunken/80 ${focusRing}`}
                >
                  <Square className="size-3 fill-current" aria-hidden="true" />
                  Stop
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={busy || input.trim() === '' || modelCommandOpen || commandPaletteOpen}
                  aria-label={asyncTurn ? 'Working on your request' : 'Send'}
                  className={`inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-accent text-white shadow-sm motion-safe:transition-[transform,background-color,box-shadow] hover:bg-accent-hover hover:shadow-[0_5px_14px_rgb(91_92_226/0.35)] motion-safe:hover:scale-105 motion-safe:active:scale-95 disabled:opacity-50 disabled:shadow-sm motion-safe:disabled:hover:scale-100 ${focusRing}`}
                >
                  {asyncTurn ? (
                    <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" />
                  ) : (
                    <ArrowUp className="size-4" aria-hidden="true" />
                  )}
                </button>
              )}
            </div>
          </div>
        </div>
        <span aria-live="polite" className="sr-only">
          {modelCommandOpen && modelOptions[modelHighlight]
            ? `${modelOptions[modelHighlight].label}, ${modelOptions[modelHighlight].detail}`
            : commandPaletteOpen && commandMatches[safeCommandHighlight]
              ? `${commandMatches[safeCommandHighlight].command}, ${commandMatches[safeCommandHighlight].hint}`
              : ''}
        </span>
        {fallbackNote ? (
          <p className="px-1 pt-2 pb-1 text-right text-2xs text-muted">{fallbackNote}</p>
        ) : null}
      </form>
    </div>
  );
}
