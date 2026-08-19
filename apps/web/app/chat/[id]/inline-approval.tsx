'use client';

import type { InlineApprovalDetail, InlineApprovalStatus } from '@assistant/application/chat';
import { Check, CircleHelp, LoaderCircle, X } from 'lucide-react';
import { btnSm } from '@/lib/ui';
import { DecisionActions, DecisionReceipt, useArmedConfirm } from './decision-card';

export interface InlineApprovalPart {
  type: 'approval';
  approvalId: string;
  shortCode: string;
  summary: string;
  status?: InlineApprovalStatus;
  details?: InlineApprovalDetail[];
}

/** What the group decided about a row in this session, layered over the server status. */
export type RowResolution = 'approved' | 'denied' | undefined;

/**
 * One approval inside an <ApprovalGroup>. Presentational: the group owns all
 * server calls and resolution state so per-row buttons stay coherent. Pending
 * rows carry actions; settled rows collapse to the shared receipt.
 */
export function ApprovalRow({
  part,
  resolution,
  busy,
  busyDecision,
  disabled,
  detailsOpenByDefault,
  onResolve,
}: {
  part: InlineApprovalPart;
  resolution: RowResolution;
  busy: boolean;
  busyDecision: 'approved' | 'denied' | null;
  disabled: boolean;
  detailsOpenByDefault: boolean;
  onResolve: (approvalId: string, decision: 'approved' | 'denied') => void;
}) {
  const status: InlineApprovalStatus = resolution ?? part.status ?? 'pending';
  const [approvalArmed, setApprovalArmed] = useArmedConfirm();

  if (status !== 'pending') {
    // Answered here a moment ago, rather than read back from the row: say so,
    // and say the work is moving again.
    const justNow = resolution !== undefined;
    return (
      <DecisionReceipt
        outcome={
          status === 'approved'
            ? 'accepted'
            : status === 'denied'
              ? 'declined'
              : status === 'expired'
                ? 'lapsed'
                : 'dismissed'
        }
        summary={part.summary}
        verdict={
          status === 'approved'
            ? justNow
              ? 'Approved — resuming'
              : 'Approved'
            : status === 'denied'
              ? 'Declined'
              : status === 'expired'
                ? 'Expired'
                : 'No longer available'
        }
        title={`${part.shortCode} · ${part.summary}`}
        live={justNow}
      />
    );
  }

  return (
    <div className="py-2">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 break-words text-sm font-medium [overflow-wrap:anywhere]">
          {part.summary}
        </p>
        <span
          className="inline-flex shrink-0 items-center gap-1 rounded-full bg-sunken px-2 py-1 font-mono text-xs font-medium text-muted"
          title="Reference code used for this same request in chat, notifications, and activity."
        >
          Ref {part.shortCode}
          <CircleHelp className="size-3" aria-hidden="true" />
        </span>
      </div>
      {part.details && part.details.length > 0 ? (
        <details open={detailsOpenByDefault} className="mt-2 border-y border-edge py-2.5">
          <summary className="disclosure flex items-center gap-2 cursor-pointer font-mono text-xs font-medium tracking-[0.08em] text-muted uppercase select-none">
            Exact details
          </summary>
          <dl className="mt-2 flex max-h-64 flex-col gap-2 overscroll-contain overflow-y-auto">
            {part.details.map((detail, index) => (
              <div key={`${detail.label}-${index.toString()}`}>
                <dt className="text-xs font-medium text-muted">{detail.label}</dt>
                <dd className="mt-0.5 text-xs break-words whitespace-pre-wrap text-strong [overflow-wrap:anywhere]">
                  {detail.value}
                </dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
      <DecisionActions>
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            if (approvalArmed) {
              setApprovalArmed(false);
              onResolve(part.approvalId, 'approved');
            } else {
              setApprovalArmed(true);
            }
          }}
          className={btnSm.success}
        >
          {busy && busyDecision === 'approved' ? (
            <LoaderCircle className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
          ) : (
            <Check className="size-3.5" aria-hidden="true" />
          )}
          {busy && busyDecision === 'approved'
            ? 'Approving…'
            : approvalArmed
              ? 'Confirm approval'
              : 'Approve and continue'}
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onResolve(part.approvalId, 'denied')}
          className={btnSm.dangerOutline}
        >
          {busy && busyDecision === 'denied' ? (
            <LoaderCircle className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
          ) : (
            <X className="size-3.5" aria-hidden="true" />
          )}
          {busy && busyDecision === 'denied' ? 'Declining…' : 'Decline'}
        </button>
      </DecisionActions>
    </div>
  );
}
