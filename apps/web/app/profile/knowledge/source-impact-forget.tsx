'use client';

import type { KnowledgeSourceImpact } from '@assistant/application';
import { LoaderCircle, Trash2 } from 'lucide-react';
import { useState, useTransition } from 'react';
import { forgetKnowledgeMemory, loadKnowledgeSourceImpact } from '@/app/profile/knowledge/actions';
import { btnSm } from '@/lib/ui';

/**
 * Forgetting the source is deliberately a two-step conversation: first show
 * its graph impact, then let the owner make the irreversible choice with the
 * evidence in view. This is shared vocabulary with the map's evidence rail.
 */
export function SourceImpactForget({ memoryId }: { memoryId: string }) {
  const [impact, setImpact] = useState<KnowledgeSourceImpact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<'preview' | 'forget' | null>(null);
  const [pending, startTransition] = useTransition();

  const preview = () => {
    setError(null);
    setAction('preview');
    startTransition(async () => {
      try {
        const nextImpact = await loadKnowledgeSourceImpact(memoryId);
        if (!nextImpact) {
          setError('This source is no longer available. Refresh the cleanup list and try again.');
          return;
        }
        setImpact(nextImpact);
      } catch {
        setError('Could not load this source’s impact. Try again.');
      } finally {
        setAction(null);
      }
    });
  };

  const forget = () => {
    setError(null);
    setAction('forget');
    startTransition(async () => {
      try {
        await forgetKnowledgeMemory(memoryId);
        setImpact(null);
      } catch {
        setError('Could not forget this source. Try again.');
      } finally {
        setAction(null);
      }
    });
  };

  if (impact) {
    return (
      <div
        className="basis-full rounded-xl border border-danger/30 bg-danger/5 p-3"
        aria-live="polite"
      >
        <p className="text-sm font-semibold text-strong">Forget this source knowledge?</p>
        <p className="mt-1 text-xs leading-5 text-muted">
          Removes {impact.activeConnectionCount} active connection
          {impact.activeConnectionCount === 1 ? '' : 's'} and {impact.orphanedItems.length} item
          {impact.orphanedItems.length === 1 ? '' : 's'} that would no longer be connected.
          {impact.retiredProjectionCount > 0
            ? ` It also clears ${impact.retiredProjectionCount} retired derived projection${impact.retiredProjectionCount === 1 ? '' : 's'}.`
            : ''}{' '}
          The source text is tombstoned so it is not learned again verbatim.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" disabled={pending} className={btnSm.danger} onClick={forget}>
            {action === 'forget' ? (
              <LoaderCircle className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
            ) : (
              <Trash2 className="size-3.5" aria-hidden="true" />
            )}
            {action === 'forget' ? 'Forgetting…' : 'Forget knowledge'}
          </button>
          <button
            type="button"
            disabled={pending}
            className={btnSm.outline}
            onClick={() => setImpact(null)}
          >
            Cancel
          </button>
        </div>
        {error ? <p className="mt-2 text-xs text-danger">{error}</p> : null}
      </div>
    );
  }

  return (
    <>
      <button type="button" disabled={pending} className={btnSm.dangerOutline} onClick={preview}>
        {action === 'preview' ? (
          <LoaderCircle className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
        ) : null}
        {action === 'preview' ? 'Checking impact…' : 'Forget…'}
      </button>
      {error ? <p className="basis-full text-xs text-danger">{error}</p> : null}
    </>
  );
}
