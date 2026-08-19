'use client';

/*
 * Presentational pieces of the chat message stream — day dividers, presence
 * and activity indicators, notice cards, recall provenance — plus the small
 * date/text helpers they share with ChatClient. Everything here is pure
 * props-in/markup-out; the stateful streaming logic stays in chat-client.tsx.
 */
import type { UIMessage } from 'ai';
import {
  Check,
  CircleCheck,
  CircleX,
  Copy,
  Hand,
  History,
  Loader2,
  type LucideIcon,
  MoonStar,
  PauseCircle,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import type { NoticeKind } from '@/lib/chat-notices';
import { focusRing } from '@/lib/ui';
import { toolLabel } from '@/lib/views';
import { DecisionCard, type DecisionTone } from './decision-card';
import { MessageMarkdown } from './markdown';

export interface RecallSource {
  date: string;
  label: string;
}

export function messageText(message: UIMessage): string {
  return message.parts
    .filter(
      (part): part is Extract<UIMessage['parts'][number], { type: 'text' }> => part.type === 'text',
    )
    .map((part) => part.text)
    .join('');
}

/** Persisted send time, carried on message.metadata by the server mappers. */
export function messageDate(message: UIMessage): Date | null {
  const meta = message.metadata as { createdAt?: unknown } | undefined;
  if (meta && typeof meta.createdAt === 'string') {
    const date = new Date(meta.createdAt);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}

/**
 * Chronological order for the rendered log, and the only place order is
 * decided. Everything else — the poll's merge, useChat's own appends — just
 * puts messages in the set; this puts them in sequence.
 *
 * Persisted messages sort by their send time and tie-break on id, exactly as
 * the server ordered them (listMessages: `created_at, id`). Anything the client
 * made itself has no send time yet and no server order to agree with, so it
 * sorts after everything durable, in the order it appeared here. That last part
 * is the fix for a real reversal: the optimistic user turn and the reply
 * streaming in response to it were both undated, so the tie-break ran on two
 * randomly generated ids and the answer could render above the question.
 *
 * `arrivalOrder` is mutated to assign a number to each id on first sight. It
 * only ever grows, so an id's place in the sequence never changes.
 */
export function orderChatLog(
  messages: UIMessage[],
  arrivalOrder: Map<string, number>,
): UIMessage[] {
  for (const message of messages) {
    if (!arrivalOrder.has(message.id)) arrivalOrder.set(message.id, arrivalOrder.size);
  }
  return [...messages].sort((a, b) => {
    const left = messageDate(a)?.getTime() ?? Number.POSITIVE_INFINITY;
    const right = messageDate(b)?.getTime() ?? Number.POSITIVE_INFINITY;
    if (left !== right) return left - right;
    if (Number.isFinite(left)) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    return (arrivalOrder.get(a.id) ?? 0) - (arrivalOrder.get(b.id) ?? 0);
  });
}

/** A message the client made itself — the server has never sent us this id. */
function isProvisional(message: UIMessage, serverIds: Set<string>): boolean {
  return !serverIds.has(message.id);
}

/**
 * Retire the optimistic user turn once its persisted twin is in the log.
 *
 * The client sent the text, so matching on it is reliable, and one durable
 * message retires exactly one local copy — asking the same question twice still
 * shows twice. Safe to run mid-stream: it only ever removes a duplicate of
 * something already on screen.
 */
export function retireProvisionalUserTurns(log: UIMessage[], serverIds: Set<string>): UIMessage[] {
  const durable: string[] = [];
  for (const message of log) {
    if (message.role === 'user' && !isProvisional(message, serverIds)) {
      durable.push(messageText(message).trim());
    }
  }
  if (durable.length === 0) return log;
  return log.filter((message) => {
    if (message.role !== 'user' || !isProvisional(message, serverIds)) return true;
    const at = durable.indexOf(messageText(message).trim());
    if (at === -1) return true;
    durable.splice(at, 1);
    return false;
  });
}

/**
 * Retire a locally streamed reply once its persisted twin is in the log.
 *
 * This used to retire every local reply as soon as ANY durable assistant
 * message arrived, which meant a scheduled brief, a watch firing, or inbound
 * mail mirrored into chat would delete a reply the client was still holding —
 * a message visibly disappearing for no reason the reader could see. The text
 * of a streamed reply and its persisted twin are identical by construction
 * (chat-turn.ts persists exactly what it streamed, correction included), so
 * matching on text names the right one instead of the nearest one.
 *
 * Matching runs against the whole log rather than one poll page, so a twin that
 * landed while the stream was still live is still reconciled on a later tick.
 */
export function retireProvisionalReplies(log: UIMessage[], serverIds: Set<string>): UIMessage[] {
  const durable: string[] = [];
  for (const message of log) {
    if (message.role === 'assistant' && !isProvisional(message, serverIds)) {
      durable.push(messageText(message).trim());
    }
  }
  if (durable.length === 0) return log;
  return log.filter((message) => {
    if (message.role !== 'assistant' || !isProvisional(message, serverIds)) return true;
    const at = durable.indexOf(messageText(message).trim());
    if (at === -1) return true;
    durable.splice(at, 1);
    return false;
  });
}

/*
 * Dates render in the agent's configured timezone, on the server and in the
 * browser alike. They used to be gated behind a `mounted` flag so the browser's
 * own zone could be used safely — which meant every day divider and timestamp
 * was missing from the first paint and appeared a frame later, pushing the
 * whole log down as it did. One zone on both sides makes the first paint the
 * final one.
 */
function dayKey(date: Date, timeZone: string): string {
  // en-CA gives an ISO-shaped YYYY-MM-DD, so day keys compare as strings and
  // the year is the first four characters.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function sameDay(a: Date, b: Date, timeZone: string): boolean {
  return dayKey(a, timeZone) === dayKey(b, timeZone);
}

export function dayLabel(date: Date, now: Date, timeZone: string): string {
  const key = dayKey(date, timeZone);
  const today = dayKey(now, timeZone);
  if (key === today) return 'Today';
  if (key === dayKey(new Date(now.getTime() - 24 * 60 * 60 * 1000), timeZone)) return 'Yesterday';
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'short',
    day: 'numeric',
    ...(key.slice(0, 4) === today.slice(0, 4) ? {} : { year: 'numeric' }),
  }).format(date);
}

export function timeLabel(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

export function DayDivider({ label }: { label: string }) {
  // Generous vertical air: dividers are chapter breaks, not rules on a form.
  // The hairlines fade toward the edges so the floating chip carries the date.
  // The chip is tonal rather than raised — a date is a quiet waypoint, and an
  // outlined, shadowed pill competed with the cards the assistant actually places.
  return (
    <div className="flex items-center gap-4 pt-7 pb-3 [div:first-child>&]:pt-1">
      <span aria-hidden="true" className="h-px flex-1 bg-gradient-to-r from-transparent to-edge" />
      <span className="rounded-full bg-sunken/80 px-2.5 py-1 font-mono text-xs font-medium tracking-[0.08em] text-muted uppercase">
        {label}
      </span>
      <span aria-hidden="true" className="h-px flex-1 bg-gradient-to-l from-transparent to-edge" />
    </div>
  );
}

/**
 * The assistant's "I'm here" signal, now that the message stream carries no
 * avatar: a small accent orb drawing breath inside an expanding halo. Still for
 * reduced motion — the label beside it already says what's happening.
 */
function PresenceOrb() {
  return (
    <span aria-hidden="true" className="relative mt-1.5 inline-flex size-2 shrink-0">
      <span className="absolute inset-0 rounded-full bg-accent motion-safe:animate-[orb-halo_2s_ease-out_infinite]" />
      <span className="relative inline-flex size-2 rounded-full bg-accent motion-safe:animate-[orb-breathe_2s_ease-in-out_infinite]" />
    </span>
  );
}

/**
 * Copy a reply, and the time it landed — revealed on hover where hover exists.
 * Touch devices keep the compact row visible so copy is discoverable there too.
 */
export function MessageActions({
  text,
  date,
  timeZone,
}: {
  text: string;
  date: Date | null;
  timeZone: string;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    if (state === 'idle') return;
    const timer = window.setTimeout(() => setState('idle'), 1800);
    return () => window.clearTimeout(timer);
  }, [state]);

  if (text === '') return null;

  const copy = async () => {
    try {
      // Undefined outside a secure context — say so rather than doing nothing.
      if (!navigator.clipboard) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      setState('failed');
    }
  };

  return (
    <div className="msg-actions mt-1.5 flex items-center gap-2 opacity-0 motion-safe:transition-opacity focus-within:opacity-100 group-hover/msg:opacity-100">
      <button
        type="button"
        onClick={() => void copy()}
        title={state === 'failed' ? 'Your browser blocked clipboard access' : 'Copy this reply'}
        className={`inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs font-medium motion-safe:transition-colors ${focusRing} ${
          state === 'failed'
            ? 'text-red-600 dark:text-red-400'
            : state === 'copied'
              ? 'text-emerald-600 dark:text-emerald-400'
              : 'text-muted hover:bg-sunken hover:text-strong'
        }`}
      >
        {state === 'copied' ? (
          <Check className="size-3" aria-hidden="true" />
        ) : (
          <Copy className="size-3" aria-hidden="true" />
        )}
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Could not copy' : 'Copy'}
      </button>
      {date ? (
        <span title={date.toLocaleString()} className="text-xs text-muted">
          {timeLabel(date, timeZone)}
        </span>
      ) : null}
    </div>
  );
}

/**
 * One presence row for every "assistant is busy" state — the pre-stream think,
 * the async hand-off, and live tool work — so they read as one voice instead of
 * three different indicators. The label shimmers while motion is allowed;
 * reduced-motion readers get plain muted text.
 */
export function PresenceRow({
  phase,
  activity,
}: {
  phase: 'thinking' | 'starting' | 'working';
  activity: Array<{ toolName: string; status: string; step: number }>;
}) {
  const label =
    phase === 'thinking' ? 'Thinking…' : phase === 'starting' ? 'Starting the work…' : 'Working…';
  return (
    <div role="status" aria-live="polite" className="flex w-full min-w-0 items-start gap-2.5">
      <PresenceOrb />
      <div className="min-w-0 flex-1">
        <span className="block text-sm leading-5 text-muted motion-safe:animate-[shimmer-text_2.2s_linear_infinite] motion-safe:bg-[linear-gradient(90deg,var(--content-muted),var(--content-strong),var(--content-muted))] motion-safe:bg-[length:200%_100%] motion-safe:bg-clip-text motion-safe:text-transparent">
          {label}
        </span>
        {activity.length > 0 ? (
          <div className="mt-2.5">
            <ActivityTrail activity={activity} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Everything the runtime says ABOUT the work rather than in reply to you: the
 * honesty check replacing an unverifiable draft, a task parking itself until a
 * budget resets, a task that cannot continue without the owner. Each is a
 * statement of state, so each gets the same card the decisions get — never
 * assistant prose, which is what made "I'm pausing here…" read as small talk.
 */
const NOTICE_PRESENTATION = {
  'response-contract': { tone: 'system', icon: ShieldCheck, label: 'System check' },
  parked: { tone: 'system', icon: PauseCircle, label: 'Paused — resumes on its own' },
  'needs-attention': { tone: 'waiting', icon: TriangleAlert, label: 'Needs you' },
} as const satisfies Record<NoticeKind, { tone: DecisionTone; icon: LucideIcon; label: string }>;

export function NoticeCard({ kind, text }: { kind: NoticeKind; text: string }) {
  const { tone, icon, label } = NOTICE_PRESENTATION[kind];
  return (
    <DecisionCard tone={tone} icon={icon} label={label}>
      <div
        className={`break-words text-sm leading-6 [overflow-wrap:anywhere] ${
          kind === 'response-contract' ? 'text-muted' : 'text-strong'
        }`}
      >
        <MessageMarkdown text={text} />
      </div>
      {kind === 'response-contract' ? (
        <details className="mt-2">
          <summary className="disclosure flex items-center gap-2 cursor-pointer text-xs text-muted select-none">
            Why am I seeing this?
          </summary>
          <p className="mt-1 max-w-prose text-xs leading-4 text-muted">
            The assistant only reports actions backed by a completed tool result. This notice
            replaced a reply that claimed more than the evidence supported — nothing was sent or
            changed outside this chat.
          </p>
        </details>
      ) : null}
    </DecisionCard>
  );
}

/**
 * Proactive notifications are part of the assistant's activity stream, not a
 * conversational reply. Give them a compact editorial treatment so a string
 * of updates remains scannable without hiding any of the original detail.
 */
export function AssistantUpdate({ text, sources }: { text: string; sources: RecallSource[] }) {
  const attention = /(?:⚠️|anomaly|waiting for you|needs? (?:your )?attention)/i.test(text);
  const reflection = /(?:🌙|while you slept|reflected)/i.test(text);
  const tone: DecisionTone = attention ? 'waiting' : reflection ? 'quiet' : 'info';
  const icon = attention ? TriangleAlert : reflection ? MoonStar : Sparkles;
  const label = attention ? 'Needs attention' : reflection ? 'Quiet update' : 'Update';
  return (
    <DecisionCard tone={tone} icon={icon} label={label}>
      <RecallNote sources={sources} />
      <div className="break-words text-sm leading-6 text-strong [overflow-wrap:anywhere]">
        <MessageMarkdown text={text} />
      </div>
    </DecisionCard>
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
      aria-label="Work trail"
    >
      <p className="mb-2 font-mono text-xs font-medium tracking-[0.08em] text-muted uppercase">
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
            <span className="min-w-0 flex-1 break-words text-sm text-strong [overflow-wrap:anywhere]">
              {toolLabel(item.toolName)}
            </span>
            <span className="shrink-0 text-xs text-muted">
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
export function recallSourcesOf(message: UIMessage): RecallSource[] {
  for (const part of message.parts as Array<{
    type?: string;
    sources?: unknown;
  }>) {
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
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
  }).format(date);
}

/** The "recalled from earlier" affordance: what auto-recall drew on for a turn. */
export function RecallNote({ sources }: { sources: RecallSource[] }) {
  if (sources.length === 0) return null;
  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted">
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

export function decodeRecallHeader(value: string | null): RecallSource[] | null {
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
export function errorText(error: Error): string {
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
