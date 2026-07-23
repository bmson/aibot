'use client';

import {
  CalendarDays,
  FileText,
  Globe2,
  Mail,
  MessageSquareText,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';
import Link from 'next/link';
import { useActionState, useState } from 'react';
import {
  approveAndRemember,
  approveApproval,
  denyApproval,
  editAndApprove,
} from '@/app/approvals/actions';
import { btn } from '@/lib/ui';
import { ConfirmButton, SubmitButton } from '@/lib/ui-client';
import type { PendingApprovalView } from '@/lib/views';

const actionIcons = {
  email: Mail,
  calendar: CalendarDays,
  message: MessageSquareText,
  document: FileText,
  browser: Globe2,
  action: ShieldCheck,
} as const;

export function ApprovalCard({
  approval,
  compact = false,
}: {
  approval: PendingApprovalView;
  compact?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [editState, editAction, editPending] = useActionState(editAndApprove, { error: null });
  const ActionIcon = actionIcons[approval.actionKind];

  return (
    <article className="rounded-2xl border border-amber-200/80 bg-amber-50/65 p-4 shadow-[0_1px_2px_rgb(23_25_35/0.04)] dark:border-amber-900/60 dark:bg-amber-950/18">
      <div className="flex items-start gap-3">
        <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
          <ActionIcon className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] leading-6 font-semibold tracking-[-0.01em]">
            {approval.summary}
          </p>
          <p className="mt-1 text-xs leading-5 text-muted">
            {approval.provenance} ·{' '}
            <Link href={`/tasks/${approval.taskId}`} className="font-medium hover:underline">
              view activity
            </Link>
          </p>
          <p className="text-xs leading-5 text-muted">
            {approval.requestedLabel} · {approval.expiresLabel}
          </p>
        </div>
        <span className="shrink-0 rounded bg-amber-200 px-1.5 py-0.5 font-mono text-xs font-semibold text-amber-900 dark:bg-amber-900 dark:text-amber-200">
          {approval.shortCode}
        </span>
      </div>
      {approval.voiceFlag ? (
        <div className="mt-2 rounded-md border border-amber-500 bg-amber-100 px-2.5 py-1.5 dark:border-amber-600 dark:bg-amber-900/50">
          <p className="flex items-center gap-1 text-xs font-semibold text-amber-900 dark:text-amber-200">
            <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
            Voice rewrite failed fact-check — original draft shown
          </p>
          <p className="mt-0.5 text-xs text-amber-800 dark:text-amber-300">{approval.voiceFlag}</p>
        </div>
      ) : null}
      {approval.fields.length > 0 && (!compact || approval.fields.length <= 5) ? (
        <dl className="mt-3 rounded-xl bg-white/65 p-3 text-[13px] dark:bg-zinc-950/35">
          {approval.fields.map((f) => (
            <div key={f.label} className="flex gap-2 py-0.5">
              <dt className="w-20 shrink-0 font-medium text-zinc-500 dark:text-zinc-400">
                {f.label}
              </dt>
              <dd
                className={
                  f.block
                    ? 'min-w-0 flex-1 whitespace-pre-wrap break-words leading-5 text-strong'
                    : 'min-w-0 flex-1 break-words leading-5 text-strong'
                }
              >
                {f.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      <details className="mt-3">
        <summary className="cursor-pointer text-xs font-medium text-muted select-none">
          Why this needs approval
        </summary>
        <p className="mt-2 max-w-[72ch] text-xs leading-5 text-muted">{approval.reason}</p>
      </details>
      <details className="mt-2">
        <summary className="cursor-pointer text-xs font-medium text-muted select-none">
          Review exact details
        </summary>
        <pre className="mt-2 overflow-x-auto rounded-lg bg-sunken p-3 font-mono text-xs">
          {approval.payloadJson}
        </pre>
      </details>

      {approval.expired ? (
        <p className="mt-4 rounded-xl bg-sunken/70 px-3 py-2 text-[13px] font-medium text-muted">
          This request has expired. Open its activity if you still want the assistant to try again.
        </p>
      ) : editing ? (
        <form action={editAction} className="mt-3">
          <input type="hidden" name="approvalId" value={approval.id} />
          <textarea
            name="payload"
            rows={8}
            defaultValue={editState.raw ?? approval.payloadJson}
            spellCheck={false}
            className="w-full rounded-xl border border-edge bg-raised p-3 font-mono text-xs outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
          />
          {editState.error ? (
            <p className="mt-1 text-xs text-red-600 dark:text-red-400">{editState.error}</p>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="submit" disabled={editPending} className={btn.success}>
              {editPending ? 'Approving…' : 'Approve edited'}
            </button>
            <button type="button" onClick={() => setEditing(false)} className={btn.outline}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="mt-4 grid grid-cols-3 items-center gap-2 sm:flex sm:flex-wrap">
          <form action={approveApproval.bind(null, approval.id)}>
            <SubmitButton variant="success" pendingLabel="Approving…" className="w-full sm:w-auto">
              Approve
            </SubmitButton>
          </form>
          <form action={denyApproval.bind(null, approval.id)}>
            <ConfirmButton
              variant="danger"
              pendingLabel="Declining…"
              confirmLabel="Confirm decline"
              className="w-full sm:w-auto"
            >
              Decline
            </ConfirmButton>
          </form>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className={`${btn.outline} w-full sm:w-auto`}
          >
            Edit details
          </button>
          {approval.rememberLabel ? (
            <form
              action={approveAndRemember.bind(null, approval.id)}
              className="col-span-3 sm:col-auto"
            >
              <SubmitButton variant="outline" className="w-full sm:w-auto">
                {approval.rememberLabel}
              </SubmitButton>
            </form>
          ) : null}
        </div>
      )}
    </article>
  );
}
