'use client';

import { Lightbulb, LoaderCircle } from 'lucide-react';
import Link from 'next/link';
import { useState, useTransition } from 'react';
import { decideSuggestionInline, snoozeSuggestionInline } from '@/app/suggestions/actions';
import { btnSm } from '@/lib/ui';
import { DecisionActions, DecisionCard, DecisionReceipt, DecisionReceipts } from './decision-card';

export type SuggestionStatus =
  | 'pending'
  | 'accepted'
  | 'dismissed'
  | 'snoozed'
  | 'expired'
  | 'missing';

export interface InlineSuggestionPart {
  type: 'suggestion';
  suggestionId: string;
  summary: string;
  proposedAction: string;
  status?: SuggestionStatus;
  acceptedTaskId?: string;
}

/**
 * "I noticed X — want me to Y?" with a one-tap yes.
 *
 * Deliberately not an approval card. An approval says "this is about to
 * happen, stop it if you want"; this says "nothing is happening, shall it?".
 * Accepting does not perform the action — it creates the work, which then runs
 * the normal pipeline and will still raise its own approval for anything that
 * reaches another person. It shares the card shell so the log reads as one
 * surface, but never the amber tone, because a card that looks like an
 * approval trains the owner to skim both.
 */
export function SuggestionCard({ parts }: { parts: InlineSuggestionPart[] }) {
  const [resolved, setResolved] = useState<Record<string, SuggestionStatus>>({});
  const [taskIds, setTaskIds] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();

  const statusOf = (part: InlineSuggestionPart): SuggestionStatus =>
    resolved[part.suggestionId] ?? part.status ?? 'pending';

  const decide = (suggestionId: string, decision: 'accepted' | 'dismissed') => {
    if (busy) return;
    setActive(suggestionId);
    startTransition(async () => {
      try {
        const result = await decideSuggestionInline(suggestionId, decision);
        if (result.ok) {
          setResolved((prev) => ({ ...prev, [suggestionId]: decision }));
          if (result.taskId) {
            setTaskIds((prev) => ({ ...prev, [suggestionId]: result.taskId as string }));
          }
          setError(null);
        } else {
          setError(result.error ?? 'This suggestion could not be updated.');
        }
      } catch {
        setError('This suggestion could not be updated. Try again.');
      } finally {
        setActive(null);
      }
    });
  };

  const snooze = (suggestionId: string) => {
    if (busy) return;
    setActive(suggestionId);
    startTransition(async () => {
      try {
        const result = await snoozeSuggestionInline(suggestionId);
        if (result.ok) {
          setResolved((prev) => ({ ...prev, [suggestionId]: 'snoozed' }));
          setError(null);
        } else {
          setError(result.error ?? 'This suggestion could not be updated.');
        }
      } catch {
        setError('This suggestion could not be updated. Try again.');
      } finally {
        setActive(null);
      }
    });
  };

  if (parts.length === 0) return null;

  // Only a live question renders open. A hydrated 'snoozed' means the snooze
  // is still sleeping (an elapsed one already came back as 'pending'), so it
  // settles to a receipt instead of re-asking what the owner just put down.
  const isOpen = (part: InlineSuggestionPart) => statusOf(part) === 'pending';
  const openParts = parts.filter(isOpen);

  const receiptOf = (part: InlineSuggestionPart) => {
    const status = statusOf(part);
    const taskId = taskIds[part.suggestionId] ?? part.acceptedTaskId;
    return (
      <div key={part.suggestionId} className="flex min-w-0 items-center gap-1.5">
        <DecisionReceipt
          outcome={
            status === 'accepted' ? 'accepted' : status === 'dismissed' ? 'dismissed' : 'lapsed'
          }
          summary={part.summary}
          verdict={
            status === 'accepted'
              ? 'Working on it'
              : status === 'dismissed'
                ? 'Dismissed'
                : status === 'snoozed'
                  ? 'Snoozed'
                  : status === 'expired'
                    ? 'Expired'
                    : 'No longer available'
          }
          live={resolved[part.suggestionId] !== undefined}
        />
        {status === 'accepted' && taskId ? (
          <Link
            href={`/tasks/${taskId}`}
            className="shrink-0 text-xs text-muted underline underline-offset-2"
          >
            View
          </Link>
        ) : null}
      </div>
    );
  };

  if (openParts.length === 0) {
    return <DecisionReceipts>{parts.map(receiptOf)}</DecisionReceipts>;
  }

  return (
    <DecisionCard
      tone="info"
      icon={Lightbulb}
      label={parts.length === 1 ? 'A suggestion' : `${parts.length.toString()} suggestions`}
    >
      <ul className="flex flex-col gap-3">
        {parts.map((part) => {
          if (!isOpen(part)) return <li key={part.suggestionId}>{receiptOf(part)}</li>;
          const working = busy && active === part.suggestionId;
          return (
            <li key={part.suggestionId} className="min-w-0 text-sm leading-relaxed">
              <p className="break-words [overflow-wrap:anywhere]">{part.summary}</p>
              <DecisionActions>
                <button
                  type="button"
                  className={btnSm.primary}
                  disabled={busy}
                  onClick={() => decide(part.suggestionId, 'accepted')}
                >
                  {working ? (
                    <LoaderCircle
                      className="size-3.5 motion-safe:animate-spin"
                      aria-hidden="true"
                    />
                  ) : null}
                  Yes, do it
                </button>
                <button
                  type="button"
                  className={btnSm.outline}
                  disabled={busy}
                  onClick={() => snooze(part.suggestionId)}
                >
                  Later
                </button>
                <button
                  type="button"
                  className={btnSm.outline}
                  disabled={busy}
                  onClick={() => decide(part.suggestionId, 'dismissed')}
                >
                  No thanks
                </button>
              </DecisionActions>
            </li>
          );
        })}
      </ul>
      {error ? (
        <p role="alert" className="mt-2 text-xs text-red-700 dark:text-red-300">
          {error}
        </p>
      ) : null}
    </DecisionCard>
  );
}
