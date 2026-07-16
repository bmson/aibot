'use client';

import { useActionState, useState } from 'react';
import { approveApproval, denyApproval, editAndApprove } from '@/app/approvals/actions';
import type { PendingApprovalView } from '@/lib/views';

const buttonBase =
  'rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed';

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
      <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">{approval.provenance}</p>
      <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-500">
        {approval.requestedLabel} · {approval.expiresLabel}
      </p>
      <details className="mt-2">
        <summary className="cursor-pointer text-xs text-zinc-600 select-none dark:text-zinc-400">
          Payload
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
            <button
              type="submit"
              disabled={editPending}
              className={`${buttonBase} bg-green-600 text-white hover:bg-green-700`}
            >
              {editPending ? 'Approving…' : 'Approve edited'}
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className={`${buttonBase} border border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800`}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="mt-3 flex gap-2">
          <form action={approveApproval.bind(null, approval.id)}>
            <button
              type="submit"
              className={`${buttonBase} bg-green-600 text-white hover:bg-green-700`}
            >
              Approve
            </button>
          </form>
          <form action={denyApproval.bind(null, approval.id)}>
            <button
              type="submit"
              className={`${buttonBase} bg-red-600 text-white hover:bg-red-700`}
            >
              Deny
            </button>
          </form>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className={`${buttonBase} border border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800`}
          >
            Edit &amp; approve
          </button>
        </div>
      )}
    </div>
  );
}
