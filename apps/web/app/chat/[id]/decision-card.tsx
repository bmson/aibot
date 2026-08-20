'use client';

/*
 * The one card language for anything the assistant PLACED in the log rather
 * than said: an approval, a spending request, a suggestion, a park notice, a
 * system check. These used to be five hand-rolled shells with five radii, five
 * header treatments and two button scales, so a decision looked like a
 * different kind of object depending on which code path produced it. Radius,
 * border, band, width, and the settled receipt all live here now; callers
 * supply a tone, a label, and their own body.
 */
import { CircleCheck, CircleX, Clock, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { microLabelClass } from '@/lib/ui';

/**
 * `waiting` is the only tone that means "nothing moves until you answer" — it
 * is deliberately the only amber one, so amber in the log always means the same
 * thing. `info` is the assistant offering something, `quiet` a background
 * update, `system` the runtime talking about itself.
 */
export type DecisionTone = 'waiting' | 'info' | 'quiet' | 'system';

/**
 * The outline is a border, not a ring. A ring is an outset shadow, so on a
 * phone — where these cards run the full width of the column — its left and
 * right pixel falls outside the chat log's box and is clipped away by that
 * scroller's overflow-x, leaving the card open-sided. A border is inside the
 * box, so it survives at any width.
 */
const TONES: Record<DecisionTone, { edge: string; band: string; chip: string; label: string }> = {
  waiting: {
    edge: 'border-amber-300/80 dark:border-amber-700/70',
    band: 'border-amber-200/70 bg-amber-50/80 dark:border-amber-900/60 dark:bg-amber-950/40',
    chip: 'bg-amber-100 text-amber-800 dark:bg-amber-900/60 dark:text-amber-300',
    label: 'text-amber-800 dark:text-amber-300',
  },
  info: {
    edge: 'border-edge/70',
    band: 'border-edge/60 bg-sunken/40',
    chip: 'bg-accent/10 text-accent',
    label: 'text-accent',
  },
  quiet: {
    edge: 'border-edge/70',
    band: 'border-edge/60 bg-sunken/40',
    chip: 'bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300',
    label: 'text-sky-700 dark:text-sky-300',
  },
  system: {
    edge: 'border-edge/70',
    band: 'border-edge/60 bg-sunken/40',
    chip: 'bg-sunken text-muted',
    label: 'text-muted',
  },
};

/**
 * Nothing in the log is wider than the assistant's own bubble cap, so a card
 * and a reply sit on one measure instead of the card reaching past it.
 */
const CARD_WIDTH = 'min-w-0 w-full max-w-2xl';

export function DecisionCard({
  tone,
  icon: Icon,
  label,
  action,
  children,
}: {
  tone: DecisionTone;
  icon: LucideIcon;
  /** The structural micro-label in the band — what kind of thing this is. */
  label: string;
  /** Optional trailing control in the band (a "Review all" link, say). */
  action?: ReactNode;
  children: ReactNode;
}) {
  const styles = TONES[tone];
  return (
    // `paper` is what tells the chat's green stage to hand this card back the
    // page's own ink and accent — see conversation.css. Everything the
    // assistant PLACES in the log is paper; only its speech is stage-side.
    <section
      className={`paper ${CARD_WIDTH} overflow-hidden rounded-xl border bg-raised ${styles.edge}`}
    >
      <div
        className={`flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5 ${styles.band}`}
      >
        <p className={`flex min-w-0 items-center gap-2.5 ${microLabelClass} ${styles.label}`}>
          <span
            className={`inline-flex size-6 shrink-0 items-center justify-center rounded-md ${styles.chip}`}
          >
            <Icon className="size-3.5" aria-hidden="true" />
          </span>
          <span className="min-w-0 truncate">{label}</span>
        </p>
        {action}
      </div>
      <div className="min-w-0 px-4 py-3">{children}</div>
    </section>
  );
}

/** The row wrapper every card's controls share, so their spacing cannot drift. */
export function DecisionActions({ children }: { children: ReactNode }) {
  return <div className="mt-3 flex flex-wrap items-center gap-2">{children}</div>;
}

/**
 * What a decision leaves behind once it is answered. Settled ceremony should
 * stop competing with live conversation, so every card collapses to the same
 * one-liner rather than each inventing its own aftermath.
 */
export type ReceiptOutcome = 'accepted' | 'declined' | 'dismissed' | 'lapsed';

const RECEIPT_ICON: Record<ReceiptOutcome, { Icon: LucideIcon; className: string }> = {
  accepted: { Icon: CircleCheck, className: 'text-emerald-600 dark:text-emerald-400' },
  declined: { Icon: CircleX, className: 'text-red-500 dark:text-red-400' },
  dismissed: { Icon: CircleX, className: 'text-muted' },
  lapsed: { Icon: Clock, className: 'text-muted' },
};

export function DecisionReceipt({
  outcome,
  summary,
  verdict,
  title,
  live,
}: {
  outcome: ReceiptOutcome;
  summary: string;
  /** The short past-tense word: "Approved", "Declined", "Expired". */
  verdict: string;
  title?: string;
  /** Announce it — this one was just answered here, not read back from the row. */
  live?: boolean;
}) {
  const { Icon, className } = RECEIPT_ICON[outcome];
  return (
    <p
      role={live ? 'status' : undefined}
      title={title}
      className="flex min-w-0 items-center gap-1.5 py-0.5 text-xs text-muted"
    >
      <Icon className={`size-3.5 shrink-0 ${className}`} aria-hidden="true" />
      <span className="min-w-0 truncate">{summary}</span>
      <span className="shrink-0 font-medium text-muted">· {verdict}</span>
    </p>
  );
}

/** Where settled receipts live once a card has nothing left to ask. */
export function DecisionReceipts({ children }: { children: ReactNode }) {
  return (
    <div className={`paper ${CARD_WIDTH} rounded-xl border border-edge/50 bg-raised px-4 py-2`}>
      {children}
    </div>
  );
}

/**
 * Approve-then-confirm, shared by the approval rows and the spending request so
 * the two cannot drift apart. Arming lapses on its own — a button left mid-arm
 * must not still be one click from acting minutes later.
 */
export function useArmedConfirm(resetMs = 3000): [boolean, (armed: boolean) => void] {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), resetMs);
    return () => window.clearTimeout(timer);
  }, [armed, resetMs]);
  return [armed, setArmed];
}
