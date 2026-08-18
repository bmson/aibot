'use client';

import { CircleCheck, CircleX, Clock, Lightbulb, LoaderCircle } from 'lucide-react';
import Link from 'next/link';
import { useState, useTransition } from 'react';
import { decideSuggestionInline } from '@/app/suggestions/actions';
import { btnSm } from '@/lib/ui';

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
 * reaches another person. The wording keeps that distinction visible, because a
 * card that reads like an approval trains the owner to skim both.
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

  if (parts.length === 0) return null;

  return (
    <div className="mt-2 rounded-lg border border-subtle bg-surface/60 p-3">
      <div className="mb-2 flex items-center gap-1.5 text-muted text-xs">
        <Lightbulb className="size-3.5 shrink-0" />
        <span>{parts.length === 1 ? 'A suggestion' : `${parts.length} suggestions`}</span>
      </div>
      <ul className="space-y-2">
        {parts.map((part) => {
          const status = statusOf(part);
          const working = busy && active === part.suggestionId;
          const taskId = taskIds[part.suggestionId] ?? part.acceptedTaskId;

          if (status !== 'pending' && status !== 'snoozed') {
            const icon =
              status === 'accepted' ? (
                <CircleCheck className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
              ) : status === 'dismissed' ? (
                <CircleX className="size-3.5 shrink-0 text-muted" />
              ) : (
                <Clock className="size-3.5 shrink-0 text-muted" />
              );
            return (
              <li
                key={part.suggestionId}
                className="flex items-start gap-1.5 text-muted text-xs leading-relaxed"
              >
                {icon}
                <span className="min-w-0">
                  {part.summary}{' '}
                  {status === 'accepted' ? (
                    taskId ? (
                      <Link className="underline underline-offset-2" href={`/tasks/${taskId}`}>
                        working on it
                      </Link>
                    ) : (
                      <span>working on it</span>
                    )
                  ) : status === 'dismissed' ? (
                    <span>— dismissed</span>
                  ) : status === 'expired' ? (
                    <span>— expired</span>
                  ) : (
                    <span>— no longer available</span>
                  )}
                </span>
              </li>
            );
          }

          return (
            <li key={part.suggestionId} className="text-sm leading-relaxed">
              <p className="mb-1.5">{part.summary}</p>
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  className={btnSm.primary}
                  disabled={busy}
                  onClick={() => decide(part.suggestionId, 'accepted')}
                >
                  {working ? <LoaderCircle className="size-3 animate-spin" /> : null}
                  Yes, do it
                </button>
                <button
                  type="button"
                  className={btnSm.outline}
                  disabled={busy}
                  onClick={() => decide(part.suggestionId, 'dismissed')}
                >
                  No thanks
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {error ? <p className="mt-2 text-red-500 text-xs dark:text-red-400">{error}</p> : null}
    </div>
  );
}
