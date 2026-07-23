'use client';

import { ArrowUpRight, CircleDollarSign, LoaderCircle } from 'lucide-react';
import Link from 'next/link';
import { useState, useTransition } from 'react';
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
  const [pending, startTransition] = useTransition();
  const status = resolution ?? part.status ?? 'pending';

  const approve = () => {
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

  return (
    <section className="mt-3 ml-3 border-l-2 border-amber-400 py-1 pl-4 text-strong dark:border-amber-600">
      <p className="flex items-center gap-1.5 text-2xs font-semibold tracking-[0.1em] text-amber-700 uppercase dark:text-amber-300">
        <CircleDollarSign className="size-3.5" aria-hidden="true" />
        Spending permission needed
      </p>
      <p className="mt-1 text-sm font-medium">
        Raise this task’s cap from ${part.currentBudgetUsd.toFixed(2)} to $
        {part.proposedBudgetUsd.toFixed(2)}?
      </p>
      <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-300">
        ${part.spentUsd.toFixed(4)} has been spent. Approval applies only to this task.
      </p>
      {status === 'approved' ? (
        <p className="mt-2 text-xs font-medium text-emerald-700 dark:text-emerald-300">
          Approved — work is resuming.
        </p>
      ) : status === 'denied' ? (
        <p className="mt-2 text-xs font-medium text-zinc-600 dark:text-zinc-300">
          Declined — the task was cancelled.
        </p>
      ) : status === 'missing' ? (
        <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
          This request is no longer available.
        </p>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" disabled={pending} onClick={approve} className={btn.success}>
            {pending ? (
              <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" />
            ) : null}
            {pending ? 'Working…' : `Approve $${part.proposedBudgetUsd.toFixed(2)}`}
          </button>
          <button type="button" disabled={pending} onClick={decline} className={btn.dangerOutline}>
            Decline
          </button>
          <Link href={`/tasks/${part.taskId}`} className={btn.outline}>
            Review task
            <ArrowUpRight className="size-3.5" aria-hidden="true" />
          </Link>
        </div>
      )}
      {error ? <p className="mt-2 text-xs text-red-700 dark:text-red-300">{error}</p> : null}
    </section>
  );
}
