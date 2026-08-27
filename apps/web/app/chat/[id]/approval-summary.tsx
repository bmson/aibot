'use client';

import { ArrowUpRight, Hand } from 'lucide-react';
import Link from 'next/link';
import type { ApprovalSummaryPart } from '@/lib/chat-notices';
import { btnSm } from '@/lib/ui';
import { DecisionCard } from './decision-card';

/** One dashboard mirror per parked task; exact action payload stays on Approvals. */
export function ApprovalSummaryCard({ summary }: { summary: ApprovalSummaryPart }) {
  const countLabel = `${summary.approvalCount} ${summary.approvalCount === 1 ? 'action is' : 'actions are'} waiting for review.`;

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
      <p className="mt-1.5 text-xs text-muted">{countLabel}</p>
    </DecisionCard>
  );
}
