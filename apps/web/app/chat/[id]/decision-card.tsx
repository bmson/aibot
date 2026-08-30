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
const TONES: Record<DecisionTone, { edge: string; rail: string; chip: string; label: string }> = {
  waiting: {
    edge: 'border-amber-300/80 dark:border-amber-700/70',
    rail: 'bg-amber-400 dark:bg-amber-500',
    chip: 'bg-amber-100 text-amber-800 dark:bg-amber-900/60 dark:text-amber-300',
    label: 'text-amber-800 dark:text-amber-300',
  },
  info: {
    edge: 'border-edge/70',
    rail: 'bg-gradient-to-b from-accent via-accent to-sky-300',
    chip: 'bg-accent/10 text-accent',
    label: 'text-accent',
  },
  quiet: {
    edge: 'border-edge/70',
    rail: 'bg-sky-300 dark:bg-sky-500',
    chip: 'bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300',
    label: 'text-sky-700 dark:text-sky-300',
  },
  system: {
    edge: 'border-edge/70',
    rail: 'bg-edge',
    chip: 'bg-sunken text-muted',
    label: 'text-muted',
  },
};

/**
 * Cards fill the transcript column, just like the native chat. The transcript
 * owns the desktop reading measure; cards should not introduce a second cap.
 */
const CARD_WIDTH = 'min-w-0 w-full max-w-none';

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
      data-decision-card="true"
      data-tone={tone}
      className={`paper relative ${CARD_WIDTH} overflow-hidden rounded-2xl border bg-raised ${styles.edge}`}
    >
      <span
        className={`absolute top-4 bottom-4 left-0 w-0.5 rounded-full ${styles.rail}`}
        aria-hidden="true"
      />
      <div
        data-decision-card-header="true"
        className="flex flex-wrap items-center justify-between gap-2 px-4 pt-4 sm:px-5"
      >
        <p className={`flex min-w-0 items-center gap-2 text-xs font-medium ${styles.label}`}>
          <span
            className={`inline-flex size-6 shrink-0 items-center justify-center rounded-full ${styles.chip}`}
          >
            <Icon className="size-3.5" aria-hidden="true" />
          </span>
          <span className="min-w-0 truncate">{label}</span>
        </p>
        {action}
      </div>
      <div data-decision-card-body="true" className="min-w-0 px-4 pt-3 pb-4 sm:px-5">
        {children}
      </div>
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
