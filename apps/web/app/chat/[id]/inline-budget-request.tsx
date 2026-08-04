'use client';

import { ArrowUpRight, CircleDollarSign, LoaderCircle } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState, useTransition } from 'react';
import { cancelTask, raiseTaskBudgetAndRetry } from '@/app/tasks/actions';
import { btn } from '@/lib/ui';

export type InlineBudgetRequestStatus = 'pending' | 'approved' | 'denied' | 'missing';

export interface InlineBudgetRequestPart {
  type: 'budget-request';
  taskId: string;
  currentBudgetUsd: number;
  proposedBudgetUsd: number;
  spentUsd: number;
  reason?: string;
  status?: InlineBudgetRequestStatus;
}

export function InlineBudgetRequest({ part }: { part: InlineBudgetRequestPart }) {
  const [resolution, setResolution] = useState<'approved' | 'denied' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approvalArmed, setApprovalArmed] = useState(false);
  const [pending, startTransition] = useTransition();
  const status = resolution ?? part.status ?? 'pending';

  useEffect(() => {
    if (!approvalArmed) return;
    const timer = window.setTimeout(() => setApprovalArmed(false), 3000);
    return () => window.clearTimeout(timer);
  }, [approvalArmed]);

  const approve = () => {
    if (!approvalArmed) {
      setApprovalArmed(true);
      return;
    }
    setApprovalArmed(false);
    startTransition(async () => {
      try {
        const formData = new FormData();
        formData.set('budgetUsdLimit', part.proposedBudgetUsd.toFixed(2));
        await raiseTaskBudgetAndRetry(part.taskId, formData);
        setResolution('approved');
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'The budget increase could not be approved.');
      }
    });
  };

  const decline = () => {
    startTransition(async () => {
      try {
        await cancelTask(part.taskId);
        setResolution('denied');
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'The task could not be cancelled.');
      }
    });
  };

  // Same card language as pending approvals: an amber-banded object the
  // assistant placed in the conversation, waiting on the owner.
  return (
    <section className="min-w-0 max-w-3xl overflow-hidden rounded-xl bg-raised shadow-[0_1px_2px_rgb(23_25_35/0.05)] ring-1 ring-amber-300/80 dark:ring-amber-700/70">
      <div className="flex items-center gap-1.5 border-b border-amber-200/70 bg-amber-50/80 px-4 py-2.5 dark:border-amber-900/60 dark:bg-amber-950/40">
        <CircleDollarSign
          className="size-3.5 shrink-0 text-amber-800 dark:text-amber-300"
          aria-hidden="true"
        />
        <p className="font-mono text-2xs font-medium tracking-[0.08em] text-amber-800 uppercase dark:text-amber-300">
          Spending permission needed
        </p>
      </div>
      <div className="min-w-0 break-words px-4 py-3 text-strong [overflow-wrap:anywhere]">
        <p className="text-sm font-medium">
          Raise this task’s cap from ${part.currentBudgetUsd.toFixed(2)} to $
          {part.proposedBudgetUsd.toFixed(2)}?
        </p>
        <p className="mt-1 text-xs text-muted">
          ${part.spentUsd.toFixed(4)} has been spent. Approval applies only to this task.
        </p>
        {status === 'approved' ? (
          <p
            role="status"
            className="mt-2 text-xs font-medium text-emerald-700 dark:text-emerald-300"
          >
            Approved — work is resuming.
          </p>
        ) : status === 'denied' ? (
          <p role="status" className="mt-2 text-xs font-medium text-muted">
            Stopped — the task was cancelled.
          </p>
        ) : status === 'missing' ? (
          <p className="mt-2 text-xs text-muted">This request is no longer available.</p>
        ) : (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" disabled={pending} onClick={approve} className={btn.success}>
              {pending ? (
                <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" />
              ) : null}
              {pending
                ? 'Working…'
                : approvalArmed
                  ? `Confirm $${part.proposedBudgetUsd.toFixed(2)}`
                  : `Approve $${part.proposedBudgetUsd.toFixed(2)}`}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={decline}
              className={btn.dangerOutline}
            >
              Stop task
            </button>
            <Link href={`/tasks/${part.taskId}`} className={btn.outline}>
              Review task
              <ArrowUpRight className="size-3.5" aria-hidden="true" />
            </Link>
          </div>
        )}
        {error ? (
          <p role="alert" className="mt-2 text-xs text-red-700 dark:text-red-300">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
