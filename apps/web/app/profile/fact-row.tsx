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
import {
  Badge,
  btnSm,
  cardFooterClass,
  cardShellClass,
  InfoGrid,
  InfoItem,
  textareaClass,
} from '@/lib/ui';

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
    <article className={cardShellClass}>
      <div className="grid min-w-0 gap-3 p-4">
        <p className="min-w-0 break-words text-[14px] leading-6 text-strong [overflow-wrap:anywhere]">
          {fact.content}
        </p>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {fact.pinned ? (
            <Badge tone="blue" size="xs">
              Pinned
            </Badge>
          ) : fact.inCard ? (
            <Badge
              tone="blue"
              size="xs"
              title="Auto-selected into the compiled owner card (high importance)"
            >
              In profile
            </Badge>
          ) : null}
          {fact.ownerConfirmed ? (
            <Badge tone="green" size="xs">
              Verified
            </Badge>
          ) : null}
          {!quarantine && !fact.organized ? (
            <Badge
              tone="violet"
              size="xs"
              title="This fact has not been checked for repetition or conflicts yet."
            >
              Cleanup pending
            </Badge>
          ) : null}
          {!quarantine && fact.importance <= 1 ? (
            <Badge tone="neutral" size="xs">
              Minor detail
            </Badge>
          ) : null}
          {fact.validityLabel ? (
            <span className="text-2xs text-muted">{fact.validityLabel}</span>
          ) : null}
          {fact.sourceTaskId ? (
            <Link
              href={`/tasks/${fact.sourceTaskId}`}
              className="text-2xs font-medium text-muted underline hover:text-strong"
            >
              View source
            </Link>
          ) : null}
        </div>
        <InfoGrid className="sm:grid-cols-4">
          <InfoItem label={quarantine ? 'Source' : 'About'}>
            {quarantine ? `${fact.originTrust} source` : fact.subjectLabel || 'You'}
          </InfoItem>
          <InfoItem label="Type">{fact.kind}</InfoItem>
          <InfoItem label="Topic">{fact.domain || 'General'}</InfoItem>
          <InfoItem label="Confidence">{confidencePct}%</InfoItem>
        </InfoGrid>
        <p className="text-2xs text-muted">Saved {fact.createdLabel}</p>
      </div>

      <footer className={cardFooterClass}>
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
      </footer>

      {editing ? (
        <div className="flex flex-col gap-2 border-t border-edge p-4">
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
    </article>
  );
}
