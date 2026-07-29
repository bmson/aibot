'use client';

import { LoaderCircle } from 'lucide-react';
import Link from 'next/link';
import { type ReactNode, useState, useTransition } from 'react';
import {
  approveQuarantined,
  confirmFact,
  correctFact,
  forgetFact,
  type ProminenceLevel,
  rejectQuarantined,
  setFactProminence,
} from '@/app/profile/actions';
import {
  Badge,
  btnSm,
  cardFooterClass,
  cardShellClass,
  focusRing,
  MetaLine,
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
  /** Owner facts can auto-surface by importance; person facts only via pin. */
  aboutOwner: boolean;
  originTrust: string;
  sourceTaskId: string | null;
  subjectLabel?: string | null;
  createdLabel: string;
  validityLabel: string;
}

const PROMINENCE_OPTIONS: Array<{ level: ProminenceLevel; label: string; hint: string }> = [
  {
    level: 'always',
    label: 'Always',
    hint: 'Always kept in the assistant’s profile summary, in every conversation.',
  },
  {
    level: 'auto',
    label: 'When relevant',
    hint: 'The assistant decides — important facts surface on their own; the rest are recalled when they matter.',
  },
  {
    level: 'minor',
    label: 'Minor',
    hint: 'A small detail — kept for recall but never featured in the profile summary.',
  },
];

function prominenceOf(fact: FactView): ProminenceLevel {
  if (fact.pinned) return 'always';
  if (fact.importance <= 1) return 'minor';
  return 'auto';
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
            <Badge tone="accent" size="xs">
              Pinned
            </Badge>
          ) : fact.inCard ? (
            <Badge
              tone="accent"
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
              tone="neutral"
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
        {/* A fact is a sentence with provenance, not a form — the old
            About/Type/Topic/Confidence grid made every memory read as a mini
            dashboard. One quiet line carries the same facts. */}
        <MetaLine
          segments={[
            // The owner reads as "You" whether or not the row carries their
            // contact name — the library was showing "You" and the owner's name
            // for the same person depending on which query loaded the fact.
            quarantine
              ? `From ${/^[aeiou]/i.test(fact.originTrust) ? 'an' : 'a'} ${fact.originTrust} source`
              : `About ${fact.aboutOwner || !fact.subjectLabel ? 'you' : fact.subjectLabel}`,
            fact.kind,
            fact.domain || 'General',
            `${confidencePct}% confident`,
            `Saved ${fact.createdLabel}`,
          ]}
        />
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
            <ProminenceControl
              fact={fact}
              pending={pending}
              pendingAction={pendingAction}
              pendingIcon={pendingIcon}
              onSelect={(level) =>
                runAction(`prominence:${level}`, () => setFactProminence(fact.id, level))
              }
            />
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

/**
 * One control for how prominently the assistant uses a fact, replacing the old
 * pin/demote pair. Owner facts offer all three levels; a person's facts only
 * ever reach the profile summary by pinning, so "Minor" (which only suppresses
 * auto-surfacing) is hidden for them — it would change nothing.
 */
function ProminenceControl({
  fact,
  pending,
  pendingAction,
  pendingIcon,
  onSelect,
}: {
  fact: FactView;
  pending: boolean;
  pendingAction: string | null;
  pendingIcon: ReactNode;
  onSelect: (level: ProminenceLevel) => void;
}) {
  const current = prominenceOf(fact);
  const options = fact.aboutOwner
    ? PROMINENCE_OPTIONS
    : PROMINENCE_OPTIONS.filter((option) => option.level !== 'minor');

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <span className="text-2xs font-medium text-muted">In conversations</span>
      {/* biome-ignore lint/a11y/useSemanticElements: a toolbar-style segmented
          control, not a form fieldset; each option is an aria-pressed button. */}
      <div
        role="group"
        aria-label="How prominently the assistant uses this fact"
        className="inline-flex rounded-lg bg-sunken/70 p-0.5"
      >
        {options.map((option) => {
          const active = option.level === current;
          const isPending = pendingAction === `prominence:${option.level}`;
          return (
            <button
              key={option.level}
              type="button"
              disabled={pending}
              aria-pressed={active}
              title={option.hint}
              onClick={() => onSelect(option.level)}
              className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-2xs font-medium motion-safe:transition-colors ${focusRing} ${
                active
                  ? 'bg-raised text-strong shadow-sm'
                  : 'text-muted hover:text-strong disabled:hover:text-muted'
              }`}
            >
              {isPending ? pendingIcon : null}
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
