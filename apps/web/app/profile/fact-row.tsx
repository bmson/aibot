'use client';

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
import { btnSm } from '@/lib/ui';

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
  /** Whether the compile rules put this fact in the owner card right now. */
  inCard: boolean;
  originTrust: string;
  sourceTaskId: string | null;
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
  const [pending, startTransition] = useTransition();

  const confidencePct = Math.round(fact.confidence * 100);

  return (
    <div className="rounded-md border border-zinc-200 px-3 py-2 dark:border-zinc-800">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 text-sm">{fact.content}</p>
        <span className="flex shrink-0 items-center gap-1.5">
          {fact.pinned ? (
            <span className="rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold text-blue-800 dark:bg-blue-950 dark:text-blue-300">
              pinned
            </span>
          ) : fact.inCard ? (
            <span
              className="rounded-full border border-blue-200 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:border-blue-900 dark:text-blue-400"
              title="Auto-selected into the compiled owner card (high importance)"
            >
              in card
            </span>
          ) : null}
          {fact.ownerConfirmed ? (
            <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
              confirmed
            </span>
          ) : null}
          <span
            className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
            title={`Confidence ${confidencePct}%`}
          >
            {confidencePct}%
          </span>
        </span>
      </div>
      <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-500">
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
              onClick={() => startTransition(() => approveQuarantined(fact.id))}
              className={outlineButton}
            >
              Approve
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => startTransition(() => rejectQuarantined(fact.id))}
              className={dangerOutlineButton}
            >
              Reject
            </button>
          </>
        ) : (
          <>
            {!fact.ownerConfirmed ? (
              <button
                type="button"
                disabled={pending}
                onClick={() => startTransition(() => confirmFact(fact.id))}
                className={outlineButton}
              >
                Confirm
              </button>
            ) : null}
            <button
              type="button"
              disabled={pending}
              onClick={() => startTransition(() => setFactPinned(fact.id, !fact.pinned))}
              className={outlineButton}
              title={
                fact.pinned
                  ? 'Remove from the compiled owner card'
                  : 'Always include in the compiled owner card'
              }
            >
              {fact.pinned ? 'Unpin' : 'Pin to card'}
            </button>
            {fact.importance > 1 ? (
              <button
                type="button"
                disabled={pending}
                onClick={() => startTransition(() => demoteFact(fact.id))}
                className={outlineButton}
                title="Minor detail: stays in memory for recall but never auto-appears in the card"
              >
                Demote
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
                  onClick={() => startTransition(() => forgetFact(fact.id))}
                  className={btnSm.danger}
                >
                  Really forget
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
            className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
          {error ? <p className="text-xs text-red-600 dark:text-red-400">{error}</p> : null}
          <div>
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const result = await correctFact(fact.id, draft);
                  if (result.error) setError(result.error);
                  else setEditing(false);
                })
              }
              className={btnSm.primary}
            >
              {pending ? 'Saving…' : 'Save correction'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
