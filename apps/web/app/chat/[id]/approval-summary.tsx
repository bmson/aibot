'use client';

import { ArrowUpRight, Hand } from 'lucide-react';
import Link from 'next/link';
import type { ApprovalSummaryOutcome, ApprovalSummaryPart } from '@/lib/chat-notices';
import { btnSm } from '@/lib/ui';
import { DecisionCard, DecisionReceipt, DecisionReceipts } from './decision-card';

/** The settled wording for one answered approval, in the shared receipt language. */
function receiptFor(outcome: ApprovalSummaryOutcome) {
  switch (outcome.status) {
    case 'approved':
      return { result: 'accepted' as const, verdict: 'Approved' };
    case 'denied':
      return { result: 'declined' as const, verdict: 'Declined' };
    case 'expired':
      return { result: 'lapsed' as const, verdict: 'Expired' };
    default:
      return { result: 'dismissed' as const, verdict: 'No longer available' };
  }
}

/** One dashboard mirror per parked task; exact action payload stays on Approvals. */
export function ApprovalSummaryCard({ summary }: { summary: ApprovalSummaryPart }) {
  const outcomes = summary.outcomes ?? [];
  // `pendingCount` is the hydrated truth. Without it — a legacy row hydration
  // could not resolve — fall back to the count frozen into the part.
  const pending = summary.pendingCount ?? summary.approvalCount;

  // Answered, so the log should show the decision rather than keep asking for
  // it. Settled decisions collapse to the same one-liner every other card
  // collapses to, instead of holding the amber "waiting" shell open.
  if (pending === 0 && outcomes.length > 0) {
    return (
      <DecisionReceipts>
        {outcomes.map((outcome) => {
          const { result, verdict } = receiptFor(outcome);
          return (
            <DecisionReceipt
              key={outcome.id}
              outcome={result}
              summary={outcome.summary || summary.purpose}
              verdict={verdict}
            />
          );
        })}
      </DecisionReceipts>
    );
  }

  const countLabel = `${pending} ${pending === 1 ? 'action is' : 'actions are'} waiting for review.`;
  // Some answered, some not: say so, so the count cannot read as "nothing has
  // happened" when the owner knows they answered one.
  const answered = outcomes.length - pending;
  const answeredLabel = answered > 0 ? ` ${answered} already answered.` : '';

  return (
    <DecisionCard
      tone="waiting"
      icon={Hand}
      label="Approval needed to continue"
      action={
        <Link href="/approvals" className={btnSm.outline}>
          Review approvals
          <ArrowUpRight className="size-3" aria-hidden="true" />
        </Link>
      }
    >
      <p className="text-sm font-medium text-strong">{summary.purpose}</p>
      <p className="mt-1.5 text-xs text-muted">
        {countLabel}
        {answeredLabel}
      </p>
    </DecisionCard>
  );
}
