'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { resolveApprovalInline } from '@/app/approvals/actions';
import type { InlineApprovalDetail, InlineApprovalStatus } from '@/lib/chat-approval-parts';
import { btn } from '@/lib/ui';

export interface InlineApprovalPart {
  type: 'approval';
  approvalId: string;
  shortCode: string;
  summary: string;
  status?: InlineApprovalStatus;
  details?: InlineApprovalDetail[];
}

export function InlineApproval({ part }: { part: InlineApprovalPart }) {
  const [resolution, setResolution] = useState<'approved' | 'denied' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const currentResolution =
    resolution ??
    (part.status === 'approved' || part.status === 'denied' || part.status === 'expired'
      ? part.status
      : null);

  const resolve = (decision: 'approved' | 'denied') => {
    startTransition(async () => {
      const result = await resolveApprovalInline(part.approvalId, decision);
      if (result.ok) {
        setResolution(decision);
        setError(null);
      } else {
        setError(result.error ?? 'This approval could not be resolved.');
      }
    });
  };

  return (
    <div className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-zinc-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-zinc-100">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold tracking-[0.12em] text-amber-700 uppercase dark:text-amber-300">
            Approval needed
          </p>
          <p className="mt-1 text-sm font-medium">{part.summary}</p>
        </div>
        <span className="rounded bg-amber-200 px-1.5 py-0.5 font-mono text-xs font-semibold text-amber-900 dark:bg-amber-900 dark:text-amber-200">
          {part.shortCode}
        </span>
      </div>
      {part.details && part.details.length > 0 ? (
        <details
          open={!currentResolution && part.status !== 'missing'}
          className="mt-3 rounded-lg border border-amber-200 bg-white/70 p-2.5 dark:border-amber-900 dark:bg-zinc-950/50"
        >
          <summary className="cursor-pointer text-[10px] font-semibold tracking-[0.1em] text-zinc-500 uppercase dark:text-zinc-400">
            Exact details
          </summary>
          <dl className="mt-2 flex max-h-64 flex-col gap-2 overflow-y-auto">
            {part.details.map((detail, index) => (
              <div key={`${detail.label}-${index.toString()}`}>
                <dt className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">
                  {detail.label}
                </dt>
                <dd className="mt-0.5 break-words whitespace-pre-wrap text-xs text-zinc-800 dark:text-zinc-200">
                  {detail.value}
                </dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
      {currentResolution ? (
        <p className="mt-2 text-xs font-medium text-zinc-600 dark:text-zinc-300">
          {currentResolution === 'approved'
            ? 'Approved — work is resuming.'
            : currentResolution === 'expired'
              ? 'Expired — this action was not run.'
              : 'Declined.'}
        </p>
      ) : part.status === 'missing' ? (
        <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
          This approval is no longer available.
        </p>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={() => resolve('approved')}
            className={btn.success}
          >
            {pending ? 'Working…' : 'Approve'}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => resolve('denied')}
            className={btn.dangerOutline}
          >
            Decline
          </button>
          <Link href="/approvals" className={btn.outline}>
            Review details
          </Link>
        </div>
      )}
      {error ? <p className="mt-2 text-xs text-red-700 dark:text-red-300">{error}</p> : null}
    </div>
  );
}
