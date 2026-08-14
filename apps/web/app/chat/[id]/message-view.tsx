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
  MoonStar,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { eventCardClass, focusRing } from '@/lib/ui';
import { toolLabel } from '@/lib/views';
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

// Chat renders times in the browser's timezone — it's a live surface the owner
// is looking at right now, unlike the server-rendered dashboards which use the
// agent timezone. Labels are gated behind `mounted` to avoid SSR/client drift.
export function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function dayLabel(date: Date, now: Date): string {
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

export function timeLabel(date: Date): string {
  return new Intl.DateTimeFormat('en-US', {
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
      <span className="rounded-full bg-sunken/80 px-2.5 py-1 font-mono text-2xs font-medium tracking-[0.08em] text-muted uppercase">
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
export function MessageActions({ text, date }: { text: string; date: Date | null }) {
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
        className={`inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-2xs font-medium motion-safe:transition-colors ${focusRing} ${
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
        <span title={date.toLocaleString()} className="text-2xs text-muted">
          {timeLabel(date)}
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
        <span className="block text-[13px] leading-5 text-muted motion-safe:animate-[shimmer-text_2.2s_linear_infinite] motion-safe:bg-[linear-gradient(90deg,var(--content-muted),var(--content-strong),var(--content-muted))] motion-safe:bg-[length:200%_100%] motion-safe:bg-clip-text motion-safe:text-transparent">
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
 * Core's response contract blanked an unverifiable reply and substituted this
 * deterministic copy — render it as a system notice, not assistant prose, so
 * honesty enforcement stops reading like the assistant talking strangely.
 */
export function ContractNotice({ text }: { text: string }) {
  // Narrower than a reply: it's an aside about the conversation, so it should
  // not span the full column like the assistant's own speech.
  return (
    <div className={`${eventCardClass} max-w-xl`}>
      <div className="flex items-center gap-2.5 border-b border-edge/60 bg-sunken/40 px-4 py-2">
        <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-sunken text-muted">
          <ShieldCheck className="size-3.5" aria-hidden="true" />
        </span>
        <p className="font-mono text-2xs font-medium tracking-[0.08em] text-muted uppercase">
          System check
        </p>
      </div>
      <div className="px-4 py-3">
        <p className="break-words text-[13px] leading-5 text-muted [overflow-wrap:anywhere]">
          {text}
        </p>
        <details className="mt-2">
          <summary className="disclosure flex items-center gap-2 cursor-pointer text-2xs text-muted select-none">
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
export function AssistantUpdate({ text, sources }: { text: string; sources: RecallSource[] }) {
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
          edge: 'border-l-sky-400 dark:border-l-sky-600',
          chip: 'bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300',
          label: 'text-sky-700 dark:text-sky-300',
        }
      : {
          edge: 'border-l-accent/70',
          chip: 'bg-accent/10 text-accent',
          label: 'text-accent',
        };

  return (
    <section className={`${eventCardClass} border-l-[3px] ${tone.edge}`}>
      <div className="min-w-0 px-4 py-3">
        <div className="mb-2 flex items-center gap-2.5">
          <span
            className={`inline-flex size-6 shrink-0 items-center justify-center rounded-md ${tone.chip}`}
          >
            <Icon className="size-3.5" aria-hidden="true" />
          </span>
          <p className={`font-mono text-2xs font-medium tracking-[0.08em] uppercase ${tone.label}`}>
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
      aria-label="Work trail"
    >
      <p className="mb-2 font-mono text-2xs font-medium tracking-[0.08em] text-muted uppercase">
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
