'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import {
  approveAndRemember,
  approveApproval,
  denyApproval,
  editAndApprove,
} from '@/app/approvals/actions';
import { btn } from '@/lib/ui';
import type { PendingApprovalView } from '@/lib/views';

export function ApprovalCard({ approval }: { approval: PendingApprovalView }) {
  const [editing, setEditing] = useState(false);
  const [editState, editAction, editPending] = useActionState(editAndApprove, { error: null });

  return (
    <div className="rounded-lg border border-amber-300/70 bg-amber-50/60 p-4 dark:border-amber-900/70 dark:bg-amber-950/20">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium">{approval.summary}</p>
        <span className="shrink-0 rounded bg-amber-200 px-1.5 py-0.5 font-mono text-xs font-semibold text-amber-900 dark:bg-amber-900 dark:text-amber-200">
          {approval.shortCode}
        </span>
      </div>
      <p className="mt-2 text-xs leading-5 text-slate-700 dark:text-zinc-300">
        <span className="font-medium">Why I’m asking:</span> {approval.reason}
      </p>
      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-500">
        {approval.provenance} ·{' '}
        <Link href={`/tasks/${approval.taskId}`} className="underline hover:no-underline">
          view activity
        </Link>
      </p>
      <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-500">
        {approval.requestedLabel} · {approval.expiresLabel}
      </p>
      {approval.voiceFlag ? (
        <div className="mt-2 rounded-md border border-amber-500 bg-amber-100 px-2.5 py-1.5 dark:border-amber-600 dark:bg-amber-900/50">
          <p className="text-xs font-semibold text-amber-900 dark:text-amber-200">
            <span aria-hidden="true">⚠ </span>Voice rewrite failed fact-check — original draft shown
          </p>
          <p className="mt-0.5 text-xs text-amber-800 dark:text-amber-300">{approval.voiceFlag}</p>
        </div>
      ) : null}
      <details className="mt-2">
        <summary className="cursor-pointer text-xs text-zinc-600 select-none dark:text-zinc-400">
          Review exact details
        </summary>
        <pre className="mt-1 overflow-x-auto rounded bg-zinc-100 p-2 font-mono text-xs dark:bg-zinc-900">
          {approval.payloadJson}
        </pre>
      </details>

      {editing ? (
        <form action={editAction} className="mt-3">
          <input type="hidden" name="approvalId" value={approval.id} />
          <textarea
            name="payload"
            rows={8}
            defaultValue={editState.raw ?? approval.payloadJson}
            spellCheck={false}
            className="w-full rounded-md border border-zinc-300 bg-white p-2 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900"
          />
          {editState.error ? (
            <p className="mt-1 text-xs text-red-600 dark:text-red-400">{editState.error}</p>
          ) : null}
          <div className="mt-2 flex gap-2">
            <button type="submit" disabled={editPending} className={btn.success}>
              {editPending ? 'Approving…' : 'Approve edited'}
            </button>
            <button type="button" onClick={() => setEditing(false)} className={btn.outline}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <form action={approveApproval.bind(null, approval.id)}>
            <button type="submit" className={btn.success}>
              Approve
            </button>
          </form>
          <form action={denyApproval.bind(null, approval.id)}>
            <button type="submit" className={btn.danger}>
              Deny
            </button>
          </form>
          <button type="button" onClick={() => setEditing(true)} className={btn.outline}>
            Edit details
          </button>
          {approval.rememberLabel ? (
            <form action={approveAndRemember.bind(null, approval.id)}>
              <button type="submit" className={btn.outline}>
                {approval.rememberLabel}
              </button>
            </form>
          ) : null}
        </div>
      )}
    </div>
  );
}
