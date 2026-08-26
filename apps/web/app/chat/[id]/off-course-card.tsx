'use client';

import { Route } from 'lucide-react';
import { focusRing } from '@/lib/ui';
import { DecisionCard } from './decision-card';

/**
 * The honesty guard on the tool-less chat path flagged the reply above: the
 * turn was routed as conversation, so nothing it claimed to check or change
 * actually ran. The text stays — it had already streamed — and this card
 * carries the trust state plus the fix: resend the same request through the
 * real executor, where the tools are.
 *
 * The button is unarmed, like a quick-reply chip: rerunning the owner's own
 * request in the owner's own chat is no more consequential than having typed
 * it twice.
 */
export function OffCourseCard({
  active,
  onRunForReal,
}: {
  /** False while another turn is in flight — a stale rerun can't jump the queue. */
  active: boolean;
  onRunForReal?: () => void;
}) {
  return (
    <DecisionCard tone="system" icon={Route} label="Answered without checking">
      <p className="max-w-prose text-sm leading-6 text-muted">
        That reply came from memory, not from your accounts — no lookup or action actually ran, so
        don&rsquo;t take anything it claimed as checked or done.
      </p>
      {onRunForReal ? (
        <div className="mt-3">
          <button
            type="button"
            disabled={!active}
            onClick={onRunForReal}
            className={`inline-flex h-8 items-center rounded-full border border-accent/30 px-3.5 text-xs font-medium text-accent motion-safe:transition-colors hover:bg-accent/10 active:bg-accent/15 disabled:cursor-not-allowed disabled:opacity-50 ${focusRing}`}
          >
            Run it for real
          </button>
        </div>
      ) : null}
    </DecisionCard>
  );
}
