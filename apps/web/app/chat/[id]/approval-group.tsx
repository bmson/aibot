'use client';

import { ArrowUpRight, Hand } from 'lucide-react';
import Link from 'next/link';
import { useState, useTransition } from 'react';
import { resolveApprovalInline } from '@/app/approvals/actions';
import { btnSm } from '@/lib/ui';
import { DecisionCard, DecisionReceipts } from './decision-card';
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

  const rows = parts.map((part) => (
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
  ));

  // Resolved ceremony collapses into a quiet receipt strip.
  if (allSettled) return <DecisionReceipts>{rows}</DecisionReceipts>;

  return (
    <DecisionCard
      tone="waiting"
      icon={Hand}
      label={
        pendingParts.length > 1
          ? `${pendingParts.length} decisions waiting`
          : 'Your decision is needed'
      }
      action={
        <Link href="/approvals" className={btnSm.outline}>
          Review all
          <ArrowUpRight className="size-3" aria-hidden="true" />
        </Link>
      }
    >
      <p className="text-xs text-muted">The assistant paused here before taking action.</p>
      <div className="mt-1 divide-y divide-edge/70">{rows}</div>
      {error ? (
        <p role="alert" className="mt-2 text-xs text-red-700 dark:text-red-300">
          {error}
        </p>
      ) : null}
    </DecisionCard>
  );
}
