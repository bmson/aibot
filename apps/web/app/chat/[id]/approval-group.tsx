'use client';

import { ArrowUpRight, Hand } from 'lucide-react';
import Link from 'next/link';
import { useState, useTransition } from 'react';
import { resolveApprovalInline } from '@/app/approvals/actions';
import { btnSm } from '@/lib/ui';
import { ApprovalRow, type InlineApprovalPart, type RowResolution } from './inline-approval';

/**
 * All approval parts of one assistant message rendered as a single card
 * instead of a stack of near-identical ones: pending rows keep per-row
 * Approve/Decline controls, while settled rows collapse to one-line receipts
 * so resolved ceremony stops dominating the log.
 */
export function ApprovalGroup({ parts }: { parts: InlineApprovalPart[] }) {
  const [resolutions, setResolutions] = useState<Record<string, RowResolution>>({});
  const [error, setError] = useState<string | null>(null);
  const [activeResolution, setActiveResolution] = useState<{
    approvalId: string;
    decision: 'approved' | 'denied';
  } | null>(null);
  const [busy, startTransition] = useTransition();

  const statusOf = (part: InlineApprovalPart) =>
    resolutions[part.approvalId] ?? part.status ?? 'pending';
  const pendingParts = parts.filter((part) => statusOf(part) === 'pending');
  const allSettled = pendingParts.length === 0;

  const resolveOne = (approvalId: string, decision: 'approved' | 'denied') => {
    if (busy) return;
    setActiveResolution({ approvalId, decision });
    startTransition(async () => {
      try {
        const result = await resolveApprovalInline(approvalId, decision);
        if (result.ok) {
          setResolutions((prev) => ({ ...prev, [approvalId]: decision }));
          setError(null);
        } else {
          setError(result.error ?? 'This approval could not be resolved.');
        }
      } catch {
        setError('This approval could not be resolved. Try again.');
      } finally {
        setActiveResolution(null);
      }
    });
  };

  if (allSettled) {
    // Resolved ceremony collapses into a quiet receipt strip.
    return (
      <div className="min-w-0 max-w-3xl rounded-xl bg-sunken/45 px-4 py-2 ring-1 ring-edge/50">
        {parts.map((part) => (
          <ApprovalRow
            key={part.approvalId}
            part={part}
            resolution={resolutions[part.approvalId]}
            busy={busy && activeResolution?.approvalId === part.approvalId}
            busyDecision={activeResolution?.decision ?? null}
            disabled={busy}
            detailsOpenByDefault={false}
            onResolve={resolveOne}
          />
        ))}
      </div>
    );
  }

  // A decision the assistant placed in the conversation: a real card with an
  // amber header band, not loose text on the timeline.
  return (
    <section className="min-w-0 max-w-3xl overflow-hidden rounded-xl bg-raised ring-1 ring-amber-300/80 dark:ring-amber-700/70">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-200/70 bg-amber-50/80 px-4 py-2.5 dark:border-amber-900/60 dark:bg-amber-950/40">
        <p className="flex min-w-0 items-center gap-1.5 font-mono text-xs font-medium tracking-[0.08em] text-amber-800 uppercase dark:text-amber-300">
          <Hand className="size-3.5 shrink-0" aria-hidden="true" />
          {pendingParts.length > 1
            ? `${pendingParts.length} decisions waiting`
            : 'Your decision is needed'}
        </p>
        <span className="flex items-center gap-2">
          <Link href="/approvals" className={btnSm.outline}>
            Review all
            <ArrowUpRight className="size-3" aria-hidden="true" />
          </Link>
        </span>
      </div>
      <div className="px-4 pt-2 pb-3">
        <p className="text-xs text-muted">The assistant paused here before taking action.</p>
        <div className="mt-1 divide-y divide-edge/70">
          {parts.map((part) => (
            <ApprovalRow
              key={part.approvalId}
              part={part}
              resolution={resolutions[part.approvalId]}
              busy={busy && activeResolution?.approvalId === part.approvalId}
              busyDecision={activeResolution?.decision ?? null}
              disabled={busy}
              detailsOpenByDefault={pendingParts.length === 1 && statusOf(part) === 'pending'}
              onResolve={resolveOne}
            />
          ))}
        </div>
        {error ? (
          <p role="alert" className="mt-2 text-xs text-red-700 dark:text-red-300">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
