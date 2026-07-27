'use client';

import type { InlineApprovalDetail, InlineApprovalStatus } from '@assistant/application/chat';
import { Check, CircleCheck, CircleHelp, CircleX, Clock, LoaderCircle, X } from 'lucide-react';
import { btnSm } from '@/lib/ui';

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
 * server calls and resolution state so "Approve all" and per-row buttons stay
 * coherent. Pending rows carry actions; settled rows collapse to a receipt.
 */
export function ApprovalRow({
  part,
  resolution,
  busy,
  detailsOpenByDefault,
  onResolve,
}: {
  part: InlineApprovalPart;
  resolution: RowResolution;
  busy: boolean;
  detailsOpenByDefault: boolean;
  onResolve: (approvalId: string, decision: 'approved' | 'denied') => void;
}) {
  const status: InlineApprovalStatus = resolution ?? part.status ?? 'pending';

  if (status !== 'pending') {
    const justNow = resolution !== undefined;
    const icon =
      status === 'approved' ? (
        <CircleCheck className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
      ) : status === 'denied' ? (
        <CircleX className="size-3.5 shrink-0 text-red-500 dark:text-red-400" />
      ) : (
        <Clock className="size-3.5 shrink-0 text-muted" />
      );
    const word =
      status === 'approved'
        ? justNow
          ? 'Approved — resuming'
          : 'Approved'
        : status === 'denied'
          ? 'Declined'
          : status === 'expired'
            ? 'Expired'
            : 'No longer available';
    return (
      <p
        className="flex min-w-0 items-center gap-1.5 py-0.5 text-xs text-zinc-600 dark:text-zinc-300"
        title={`${part.shortCode} · ${part.summary}`}
      >
        {icon}
        <span className="min-w-0 truncate">{part.summary}</span>
        <span className="shrink-0 font-medium text-muted">· {word}</span>
      </p>
    );
  }

  return (
    <div className="py-2">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 break-words text-sm font-medium [overflow-wrap:anywhere]">
          {part.summary}
        </p>
        <span
          className="inline-flex shrink-0 items-center gap-1 rounded-full bg-sunken px-2 py-1 font-mono text-2xs font-medium text-muted"
          title="Reference code used for this same request in chat, notifications, and activity."
        >
          Ref {part.shortCode}
          <CircleHelp className="size-3" aria-hidden="true" />
        </span>
      </div>
      {part.details && part.details.length > 0 ? (
        <details open={detailsOpenByDefault} className="mt-2 border-y border-edge py-2.5">
          <summary className="disclosure flex items-center gap-2 cursor-pointer text-2xs font-semibold tracking-[0.1em] text-zinc-500 uppercase select-none dark:text-zinc-400">
            Exact details
          </summary>
          <dl className="mt-2 flex max-h-64 flex-col gap-2 overscroll-contain overflow-y-auto">
            {part.details.map((detail, index) => (
              <div key={`${detail.label}-${index.toString()}`}>
                <dt className="text-2xs font-medium text-zinc-500 dark:text-zinc-400">
                  {detail.label}
                </dt>
                <dd className="mt-0.5 text-xs break-words whitespace-pre-wrap text-zinc-800 [overflow-wrap:anywhere] dark:text-zinc-200">
                  {detail.value}
                </dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => onResolve(part.approvalId, 'approved')}
          className={btnSm.success}
        >
          {busy ? (
            <LoaderCircle className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
          ) : (
            <Check className="size-3.5" aria-hidden="true" />
          )}
          {busy ? 'Working…' : 'Approve and continue'}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onResolve(part.approvalId, 'denied')}
          className={btnSm.dangerOutline}
        >
          <X className="size-3.5" aria-hidden="true" />
          Decline
        </button>
      </div>
    </div>
  );
}
