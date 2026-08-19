'use client';

import { ArrowUpRight, CircleDollarSign, LoaderCircle } from 'lucide-react';
import Link from 'next/link';
import { useState, useTransition } from 'react';
import { cancelTask, raiseTaskBudgetAndRetry } from '@/app/tasks/actions';
import { btnSm } from '@/lib/ui';
import {
  DecisionActions,
  DecisionCard,
  DecisionReceipt,
  DecisionReceipts,
  useArmedConfirm,
} from './decision-card';

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
  const [approvalArmed, setApprovalArmed] = useArmedConfirm();
  const [pending, startTransition] = useTransition();
  const status = resolution ?? part.status ?? 'pending';

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

  const summary = `Raise this task’s cap to $${part.proposedBudgetUsd.toFixed(2)}`;

  // Once answered this collapses like every other decision. It used to keep its
  // amber card forever, so a spending question you settled days ago went on
  // shouting for attention next to one that genuinely wanted it.
  if (status !== 'pending') {
    return (
      <DecisionReceipts>
        <DecisionReceipt
          outcome={
            status === 'approved' ? 'accepted' : status === 'denied' ? 'dismissed' : 'lapsed'
          }
          summary={summary}
          verdict={
            status === 'approved'
              ? resolution
                ? 'Approved — resuming'
                : 'Approved'
              : status === 'denied'
                ? 'Stopped — task cancelled'
                : 'No longer available'
          }
          live={resolution !== null}
        />
      </DecisionReceipts>
    );
  }

  return (
    <DecisionCard tone="waiting" icon={CircleDollarSign} label="Spending permission needed">
      <div className="min-w-0 break-words text-strong [overflow-wrap:anywhere]">
        <p className="text-sm font-medium">
          Raise this task’s cap from ${part.currentBudgetUsd.toFixed(2)} to $
          {part.proposedBudgetUsd.toFixed(2)}?
        </p>
        <p className="mt-1 text-xs text-muted">
          ${part.spentUsd.toFixed(4)} has been spent. Approval applies only to this task.
        </p>
        <DecisionActions>
          <button type="button" disabled={pending} onClick={approve} className={btnSm.success}>
            {pending ? (
              <LoaderCircle className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
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
            className={btnSm.dangerOutline}
          >
            Stop task
          </button>
          <Link href={`/tasks/${part.taskId}`} className={btnSm.outline}>
            Review task
            <ArrowUpRight className="size-3" aria-hidden="true" />
          </Link>
        </DecisionActions>
        {error ? (
          <p role="alert" className="mt-2 text-xs text-red-700 dark:text-red-300">
            {error}
          </p>
        ) : null}
      </div>
    </DecisionCard>
  );
}
