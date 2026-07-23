'use client';

import { LoaderCircle } from 'lucide-react';
import Link from 'next/link';
import { useState, useTransition } from 'react';
import {
  approveQuarantined,
  confirmFact,
  correctFact,
  demoteFact,
  forgetFact,
  rejectQuarantined,
  setFactPinned,
} from '@/app/profile/actions';
import { btnSm, textareaClass } from '@/lib/ui';

/** Plain-serializable fact view, built server-side in page.tsx. */
export interface FactView {
  id: string;
  content: string;
  kind: string;
  domain: string;
  confidence: number;
  importance: number;
  ownerConfirmed: boolean;
  pinned: boolean;
  organized: boolean;
  /** Whether the compile rules put this fact in the owner card right now. */
  inCard: boolean;
  originTrust: string;
  sourceTaskId: string | null;
  subjectLabel?: string | null;
  createdLabel: string;
  validityLabel: string;
}

const outlineButton = btnSm.outline;
const dangerOutlineButton = btnSm.dangerOutline;

export function FactRow({ fact, quarantine = false }: { fact: FactView; quarantine?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [confirmingForget, setConfirmingForget] = useState(false);
  const [draft, setDraft] = useState(fact.content);
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const confidencePct = Math.round(fact.confidence * 100);
  const runAction = (name: string, action: () => Promise<unknown>) => {
    setPendingAction(name);
    startTransition(async () => {
      try {
        await action();
      } finally {
        setPendingAction(null);
      }
    });
  };
  const pendingIcon = (
    <LoaderCircle className="size-3 motion-safe:animate-spin" aria-hidden="true" />
  );

  return (
    <div className="rounded-xl bg-sunken/55 px-3 py-3">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 text-sm">{fact.content}</p>
        <span className="flex shrink-0 items-center gap-1.5">
          {fact.pinned ? (
            <span className="rounded-full bg-blue-100 px-1.5 py-0.5 text-2xs font-semibold text-blue-800 dark:bg-blue-950 dark:text-blue-300">
              pinned
            </span>
          ) : fact.inCard ? (
            <span
              className="rounded-full border border-blue-200 px-1.5 py-0.5 text-2xs font-medium text-blue-700 dark:border-blue-900 dark:text-blue-400"
              title="Auto-selected into the compiled owner card (high importance)"
            >
              in card
            </span>
          ) : null}
          {fact.ownerConfirmed ? (
            <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-2xs font-semibold text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
              confirmed
            </span>
          ) : null}
          {!quarantine && !fact.organized ? (
            <span
              className="rounded-full bg-violet-100 px-1.5 py-0.5 text-2xs font-medium text-violet-700 dark:bg-violet-950 dark:text-violet-300"
              title="This fact has not been checked for repetition or conflicts yet."
            >
              cleanup pending
            </span>
          ) : null}
          <span
            className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-2xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
            title={`Confidence ${confidencePct}%`}
          >
            {confidencePct}%
          </span>
        </span>
      </div>
      <p className="mt-1 text-2xs text-zinc-500 dark:text-zinc-500">
        {fact.subjectLabel ? `${fact.subjectLabel} · ` : ''}
        {fact.kind}
        {fact.domain ? ` · ${fact.domain}` : ''}
        {!quarantine && fact.importance <= 1 ? ' · minor' : ''}
        {fact.validityLabel ? ` · ${fact.validityLabel}` : ''}
        {` · ${fact.createdLabel}`}
        {quarantine ? ` · from ${fact.originTrust} source` : ''}
        {fact.sourceTaskId ? (
          <>
            {' · '}
            <Link
              href={`/tasks/${fact.sourceTaskId}`}
              className="underline hover:text-zinc-800 dark:hover:text-zinc-200"
            >
              source
            </Link>
          </>
        ) : null}
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {quarantine ? (
          <>
            <button
              type="button"
              disabled={pending}
              onClick={() => runAction('approve', () => approveQuarantined(fact.id))}
              className={outlineButton}
            >
              {pendingAction === 'approve' ? pendingIcon : null}
              {pendingAction === 'approve' ? 'Approving…' : 'Approve'}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => runAction('reject', () => rejectQuarantined(fact.id))}
              className={dangerOutlineButton}
            >
              {pendingAction === 'reject' ? pendingIcon : null}
              {pendingAction === 'reject' ? 'Rejecting…' : 'Reject'}
            </button>
          </>
        ) : (
          <>
            {!fact.ownerConfirmed ? (
              <button
                type="button"
                disabled={pending}
                onClick={() => runAction('confirm', () => confirmFact(fact.id))}
                className={outlineButton}
              >
                {pendingAction === 'confirm' ? pendingIcon : null}
                {pendingAction === 'confirm' ? 'Confirming…' : 'Confirm'}
              </button>
            ) : null}
            <button
              type="button"
              disabled={pending}
              onClick={() => runAction('pin', () => setFactPinned(fact.id, !fact.pinned))}
              className={outlineButton}
              title={
                fact.pinned
                  ? 'Remove from the compiled owner card'
                  : 'Always include in the compiled owner card'
              }
            >
              {pendingAction === 'pin' ? pendingIcon : null}
              {pendingAction === 'pin'
                ? fact.pinned
                  ? 'Unpinning…'
                  : 'Pinning…'
                : fact.pinned
                  ? 'Unpin'
                  : 'Pin to card'}
            </button>
            {fact.importance > 1 ? (
              <button
                type="button"
                disabled={pending}
                onClick={() => runAction('demote', () => demoteFact(fact.id))}
                className={outlineButton}
                title="Minor detail: stays in memory for recall but never auto-appears in the card"
              >
                {pendingAction === 'demote' ? pendingIcon : null}
                {pendingAction === 'demote' ? 'Demoting…' : 'Demote'}
              </button>
            ) : null}
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                setEditing((v) => !v);
                setError(null);
              }}
              className={outlineButton}
            >
              {editing ? 'Close' : 'Correct'}
            </button>
            {confirmingForget ? (
              <>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => runAction('forget', () => forgetFact(fact.id))}
                  className={btnSm.danger}
                >
                  {pendingAction === 'forget' ? pendingIcon : null}
                  {pendingAction === 'forget' ? 'Forgetting…' : 'Really forget'}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingForget(false)}
                  className={outlineButton}
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                disabled={pending}
                onClick={() => setConfirmingForget(true)}
                className={dangerOutlineButton}
                title="Deletes the fact and tombstones it so it can never be re-extracted"
              >
                Forget
              </button>
            )}
          </>
        )}
      </div>

      {editing ? (
        <div className="mt-2 flex flex-col gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={2}
            className={textareaClass}
          />
          {error ? <p className="text-xs text-red-600 dark:text-red-400">{error}</p> : null}
          <div>
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                runAction('save', async () => {
                  const result = await correctFact(fact.id, draft);
                  if (result.error) setError(result.error);
                  else setEditing(false);
                })
              }
              className={btnSm.primary}
            >
              {pendingAction === 'save' ? pendingIcon : null}
              {pendingAction === 'save' ? 'Saving…' : 'Save correction'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
