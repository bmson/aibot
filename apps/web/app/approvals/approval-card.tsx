'use client';

import {
  ArrowUpRight,
  CalendarDays,
  Check,
  CircleHelp,
  FileText,
  Globe2,
  Mail,
  MessageSquareText,
  PencilLine,
  ShieldCheck,
  TriangleAlert,
  X,
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

const actionLabels = {
  email: 'Email',
  calendar: 'Calendar change',
  message: 'Message',
  document: 'Document change',
  browser: 'Browser action',
  action: 'External action',
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
  const actionLabel = actionLabels[approval.actionKind];

  return (
    <article className="overflow-hidden rounded-2xl border border-edge bg-raised shadow-[0_1px_2px_rgb(23_25_35/0.06)] motion-safe:transition-shadow hover:shadow-[0_10px_30px_rgb(23_25_35/0.08)]">
      <div className="p-4 sm:p-5">
        <div className="flex items-start gap-3">
          <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-2xl bg-accent/10 text-accent">
            <ActionIcon className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-accent">{actionLabel} · waiting for you</p>
            <h3 className="mt-1 text-[15px] leading-6 font-semibold tracking-[-0.015em]">
              {approval.summary}
            </h3>
            <p className="mt-1 text-xs leading-5 text-muted">
              {approval.provenance} ·{' '}
              <Link
                href={`/tasks/${approval.taskId}`}
                className="inline-flex items-center gap-0.5 font-medium hover:text-strong"
              >
                View activity
                <ArrowUpRight className="size-3" aria-hidden="true" />
              </Link>
            </p>
            <p className="text-xs leading-5 text-muted">
              {approval.requestedLabel} · {approval.expiresLabel}
            </p>
          </div>
          <span
            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-sunken px-2 py-1 font-mono text-2xs font-medium text-muted"
            title="Reference code: a short identifier you can use to recognize this request in chat, text messages, and activity."
          >
            Ref {approval.shortCode}
            <CircleHelp className="size-3" aria-hidden="true" />
          </span>
        </div>
        {approval.voiceFlag ? (
          <div className="mt-4 rounded-xl bg-amber-100/80 px-3 py-2.5 dark:bg-amber-950/45">
            <p className="flex items-center gap-1 text-xs font-semibold text-amber-900 dark:text-amber-200">
              <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
              Voice rewrite failed fact-check — original draft shown
            </p>
            <p className="mt-0.5 text-xs text-amber-800 dark:text-amber-300">
              {approval.voiceFlag}
            </p>
          </div>
        ) : null}
        {approval.fields.length > 0 && (!compact || approval.fields.length <= 5) ? (
          <dl className="mt-4 divide-y divide-edge/75 border-y border-edge/75 text-[13px]">
            {approval.fields.map((f) => (
              <div key={f.label} className="grid gap-1 py-2.5 sm:grid-cols-[6rem_1fr] sm:gap-3">
                <dt className="font-medium text-muted">{f.label}</dt>
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
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1">
          <details>
            <summary className="cursor-pointer text-xs font-medium text-muted select-none">
              Why AI Bot paused
            </summary>
            <p className="mt-2 max-w-[72ch] text-xs leading-5 text-muted">{approval.reason}</p>
          </details>
          <details>
            <summary className="cursor-pointer text-xs font-medium text-muted select-none">
              Technical details
            </summary>
            <pre className="mt-2 overflow-x-auto rounded-lg bg-sunken p-3 font-mono text-xs">
              {approval.payloadJson}
            </pre>
          </details>
        </div>
      </div>

      {approval.expired ? (
        <p className="border-t border-edge bg-sunken/55 px-4 py-3 text-[13px] font-medium text-muted sm:px-5">
          This request has expired. Open its activity if you still want the assistant to try again.
        </p>
      ) : editing ? (
        <form action={editAction} className="border-t border-edge bg-sunken/45 p-4 sm:p-5">
          <input type="hidden" name="approvalId" value={approval.id} />
          <label htmlFor={`approval-payload-${approval.id}`} className="text-[13px] font-medium">
            Edit the exact request
          </label>
          <p className="mt-1 text-xs text-muted">
            This is the technical payload AI Bot will use after approval.
          </p>
          <textarea
            id={`approval-payload-${approval.id}`}
            name="payload"
            rows={8}
            defaultValue={editState.raw ?? approval.payloadJson}
            spellCheck={false}
            className="mt-3 w-full rounded-xl border border-edge bg-raised p-3 font-mono text-xs outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
          />
          {editState.error ? (
            <p className="mt-1 text-xs text-red-600 dark:text-red-400">{editState.error}</p>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="submit" disabled={editPending} className={btn.success}>
              <Check className="size-4" aria-hidden="true" />
              {editPending ? 'Approving…' : 'Approve edited request'}
            </button>
            <button type="button" onClick={() => setEditing(false)} className={btn.outline}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="grid grid-cols-2 items-center gap-2 border-t border-edge bg-sunken/45 p-3.5 sm:flex sm:flex-wrap sm:px-5 sm:py-4">
          <form action={approveApproval.bind(null, approval.id)} className="min-w-0">
            <SubmitButton variant="success" pendingLabel="Approving…" className="w-full sm:w-auto">
              <Check className="size-4" aria-hidden="true" />
              Approve and continue
            </SubmitButton>
          </form>
          <form action={denyApproval.bind(null, approval.id)} className="min-w-0">
            <ConfirmButton
              variant="dangerOutline"
              pendingLabel="Declining…"
              confirmLabel="Confirm decline"
              className="w-full sm:w-auto"
            >
              <X className="size-4" aria-hidden="true" />
              Decline
            </ConfirmButton>
          </form>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className={`${btn.outline} col-span-2 w-full sm:w-auto`}
          >
            <PencilLine className="size-4" aria-hidden="true" />
            Edit request
          </button>
          {approval.rememberLabel ? (
            <form
              action={approveAndRemember.bind(null, approval.id)}
              className="col-span-2 sm:col-auto"
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
