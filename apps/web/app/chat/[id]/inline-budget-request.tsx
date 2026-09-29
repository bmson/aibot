'use client';

import { ArrowUpRight, Check, CircleDollarSign, X } from 'lucide-react';
import Link from 'next/link';
import { useState, useTransition } from 'react';
import { cancelTask, raiseTaskBudgetAndRetry } from '@/app/tasks/actions';
import { btnSm } from '@/lib/ui';
import { ConfirmButton } from '@/lib/ui-client';
import { DecisionActions, DecisionCard, DecisionReceipt, DecisionReceipts } from './decision-card';

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
  const [activeDecision, setActiveDecision] = useState<'approved' | 'denied' | null>(null);
  const [pending, startTransition] = useTransition();
  const status = resolution ?? part.status ?? 'pending';

  const approve = () => {
    setActiveDecision('approved');
    startTransition(async () => {
      try {
        const formData = new FormData();
        formData.set('budgetUsdLimit', part.proposedBudgetUsd.toFixed(2));
        await raiseTaskBudgetAndRetry(part.taskId, formData);
        setResolution('approved');
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'The budget increase could not be approved.');
      } finally {
        setActiveDecision(null);
      }
    });
  };

  const decline = () => {
    setActiveDecision('denied');
    startTransition(async () => {
      try {
        await cancelTask(part.taskId);
        setResolution('denied');
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'The task could not be cancelled.');
      } finally {
        setActiveDecision(null);
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
          {/* The same pair, in the same order, with the same ask-twice as every
              approval in the log: this is an approval, of money. */}
          <ConfirmButton
            variant="primary"
            size="sm"
            disabled={pending}
            pending={pending && activeDecision === 'approved'}
            pendingLabel="Approving…"
            confirmLabel="Approve?"
            onConfirm={approve}
          >
            <Check aria-hidden="true" />
            Approve ${part.proposedBudgetUsd.toFixed(2)}
          </ConfirmButton>
          {/* Declining cancels the task outright, so it asks twice like every
              other action that stops work — it used to fire on one click. */}
          <ConfirmButton
            variant="dangerOutline"
            size="sm"
            disabled={pending}
            pending={pending && activeDecision === 'denied'}
            pendingLabel="Stopping…"
            confirmLabel="Stop task?"
            onConfirm={decline}
          >
            <X aria-hidden="true" />
            Stop task
          </ConfirmButton>
          <Link href={`/tasks/${part.taskId}`} className={btnSm.outline}>
            Review task
            <ArrowUpRight aria-hidden="true" />
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
