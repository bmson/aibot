'use client';

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
    return (
      <div className="rounded-xl border border-edge bg-sunken/60 px-3 py-1.5">
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

  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/30">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-2xs font-semibold tracking-[0.12em] text-amber-700 uppercase dark:text-amber-300">
          {pendingParts.length > 1
            ? `${pendingParts.length} actions need your approval`
            : 'Approval needed'}
        </p>
        <span className="flex items-center gap-2">
          {pendingParts.length > 1 ? (
            <button type="button" disabled={busy} onClick={approveAll} className={btnSm.success}>
              {busy ? 'Working…' : 'Approve all'}
            </button>
          ) : null}
          <Link href="/approvals" className={btnSm.outline}>
            Review
          </Link>
        </span>
      </div>
      <div className="mt-1 divide-y divide-amber-200/70 dark:divide-amber-900/40">
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
  );
}
