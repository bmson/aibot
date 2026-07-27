'use client';

import { ArrowUpRight, Hand, LoaderCircle } from 'lucide-react';
import Link from 'next/link';
import { useState, useTransition } from 'react';
import { resolveApprovalInline, resolveApprovalsInline } from '@/app/approvals/actions';
import { btnSm } from '@/lib/ui';
import { ApprovalRow, type InlineApprovalPart, type RowResolution } from './inline-approval';

/**
 * All approval parts of one assistant message rendered as a single card
 * instead of a stack of near-identical ones: pending rows keep per-row
 * Approve/Decline (plus "Approve all" when several wait), settled rows
 * collapse to one-line receipts so resolved ceremony stops dominating the log.
 */
export function ApprovalGroup({ parts }: { parts: InlineApprovalPart[] }) {
  const [resolutions, setResolutions] = useState<Record<string, RowResolution>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();

  const statusOf = (part: InlineApprovalPart) =>
    resolutions[part.approvalId] ?? part.status ?? 'pending';
  const pendingParts = parts.filter((part) => statusOf(part) === 'pending');
  const allSettled = pendingParts.length === 0;

  const resolveOne = (approvalId: string, decision: 'approved' | 'denied') => {
    startTransition(async () => {
      const result = await resolveApprovalInline(approvalId, decision);
      if (result.ok) {
        setResolutions((prev) => ({ ...prev, [approvalId]: decision }));
        setError(null);
      } else {
        setError(result.error ?? 'This approval could not be resolved.');
      }
    });
  };

  const approveAll = () => {
    const ids = pendingParts.map((part) => part.approvalId);
    startTransition(async () => {
      const { failures } = await resolveApprovalsInline(ids, 'approved');
      const failed = new Set(failures.map((failure) => failure.approvalId));
      setResolutions((prev) => {
        const next = { ...prev };
        for (const id of ids) {
          if (!failed.has(id)) next[id] = 'approved';
        }
        return next;
      });
      setError(
        failures.length > 0
          ? `${failures.length} of ${ids.length} could not be approved — check the Approvals page.`
          : null,
      );
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
            busy={busy}
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
    <section className="min-w-0 max-w-3xl overflow-hidden rounded-xl bg-raised shadow-[0_1px_2px_rgb(23_25_35/0.05)] ring-1 ring-amber-300/80 dark:ring-amber-700/70">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-200/70 bg-amber-50/80 px-4 py-2.5 dark:border-amber-900/60 dark:bg-amber-950/40">
        <p className="flex min-w-0 items-center gap-1.5 text-2xs font-semibold tracking-[0.1em] text-amber-800 uppercase dark:text-amber-300">
          <Hand className="size-3.5 shrink-0" aria-hidden="true" />
          {pendingParts.length > 1
            ? `${pendingParts.length} decisions waiting`
            : 'Your decision is needed'}
        </p>
        <span className="flex items-center gap-2">
          {pendingParts.length > 1 ? (
            <button type="button" disabled={busy} onClick={approveAll} className={btnSm.success}>
              {busy ? (
                <LoaderCircle className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
              ) : null}
              {busy ? 'Working…' : 'Approve all'}
            </button>
          ) : null}
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
              busy={busy}
              detailsOpenByDefault={pendingParts.length === 1 && statusOf(part) === 'pending'}
              onResolve={resolveOne}
            />
          ))}
        </div>
        {error ? <p className="mt-2 text-xs text-red-700 dark:text-red-300">{error}</p> : null}
      </div>
    </section>
  );
}
