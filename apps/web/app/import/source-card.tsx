'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import {
  deleteSourceAction,
  purgeSourceAction,
  reviewSourceAction,
  startImportAction,
} from '@/app/import/actions';
import {
  Badge,
  type BadgeTone,
  btn,
  cardBodyClass,
  cardFooterChromeClass,
  cardHeaderClass,
  cardShellClass,
  cardTitleClass,
  InfoGrid,
  InfoItem,
} from '@/lib/ui';

/** Plain-serializable source view built in page.tsx. */
export interface SourceView {
  source: string;
  workspacePath: string;
  kind: string;
  status: string;
  itemsTotal: number | null;
  itemsProcessed: number;
  memoriesSaved: number;
  quarantinedNow: number;
  taskId: string | null;
  error: string | null;
  updatedLabel: string;
}

const outlineButton = btn.outline;
const dangerOutlineButton = btn.dangerOutline;
const dangerButton = btn.danger;

// Import keeps its own labels (Importing/Complete/Removed read better here than
// the generic task vocabulary), rendered through the shared Badge tones.
const statusTone: Record<string, BadgeTone> = {
  pending: 'neutral',
  running: 'blue',
  done: 'green',
  failed: 'red',
  purged: 'muted',
};

const statusLabels: Record<string, string> = {
  pending: 'Queued',
  running: 'Importing',
  done: 'Complete',
  failed: 'Needs attention',
  purged: 'Removed',
};

export function SourceCard({ view }: { view: SourceView }) {
  const [confirming, setConfirming] = useState<'purge' | 'delete' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const pct =
    view.itemsTotal && view.itemsTotal > 0
      ? Math.min(100, Math.round((view.itemsProcessed / view.itemsTotal) * 100))
      : null;
  const rerunnable = view.status === 'done' || view.status === 'failed' || view.status === 'purged';

  return (
    <article className={cardShellClass}>
      <div className={cardBodyClass}>
        <div className={cardHeaderClass}>
          <div className="min-w-0">
            <h3 className={`truncate ${cardTitleClass}`}>{view.source}</h3>
            <p className="mt-0.5 text-xs text-muted">{view.updatedLabel}</p>
          </div>
          <Badge tone={statusTone[view.status] ?? 'neutral'}>
            {statusLabels[view.status] ?? 'Queued'}
          </Badge>
        </div>

        <InfoGrid className="sm:grid-cols-3">
          <InfoItem label="Processed">
            {pct !== null ? `${view.itemsProcessed} of ${view.itemsTotal}` : 'Waiting'}
          </InfoItem>
          <InfoItem label="Memories">{view.memoriesSaved}</InfoItem>
          <InfoItem label="Needs review">{view.quarantinedNow}</InfoItem>
        </InfoGrid>
        {pct !== null && view.status === 'running' ? (
          <div>
            <div className="flex items-center justify-between gap-3 text-xs text-muted">
              <span>Import progress</span>
              <span>{pct}%</span>
            </div>
            <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-sunken">
              <div className="h-full rounded-full bg-blue-500" style={{ width: `${pct}%` }} />
            </div>
          </div>
        ) : null}
        {view.error ? (
          <p className="rounded-xl bg-red-50 px-3 py-2.5 text-xs leading-5 text-red-700 dark:bg-red-950/35 dark:text-red-300">
            {view.error}
          </p>
        ) : null}

        {view.quarantinedNow > 0 ? (
          <div className="grid gap-3 rounded-xl bg-amber-50 px-3 py-3 dark:bg-amber-950/25 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
            <div>
              <p className="text-[13px] font-semibold text-amber-900 dark:text-amber-200">
                Review what this import learned
              </p>
              <p className="mt-0.5 text-xs leading-5 text-amber-800 dark:text-amber-300">
                {view.quarantinedNow} memories are held back until you approve or reject them.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={pending}
                onClick={() => startTransition(() => reviewSourceAction(view.source, 'approve'))}
                className={outlineButton}
                title="Release every quarantined fact from this source into normal memory"
              >
                Approve all
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => startTransition(() => reviewSourceAction(view.source, 'reject'))}
                className={dangerOutlineButton}
                title="Delete and tombstone every quarantined fact from this source"
              >
                Reject all
              </button>
            </div>
          </div>
        ) : null}
        {error ? <p className="text-xs text-red-600 dark:text-red-400">{error}</p> : null}
      </div>

      <details className={`${cardFooterChromeClass} text-xs`}>
        <summary className="cursor-pointer font-medium text-muted">File and actions</summary>
        <p className="mt-2 break-words text-muted [overflow-wrap:anywhere]">
          {view.workspacePath} · {view.kind}
          {view.taskId ? (
            <>
              {' · '}
              <Link
                href={`/tasks/${view.taskId}`}
                className="underline hover:text-zinc-800 dark:hover:text-zinc-200"
              >
                View task
              </Link>
            </>
          ) : null}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {rerunnable ? (
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const result = await startImportAction(view.workspacePath, view.source);
                  if (result.error) setError(result.error);
                })
              }
              className={outlineButton}
              title="Import this file again; memories already saved are skipped"
            >
              Import again
            </button>
          ) : null}
          {confirming ? (
            <>
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  startTransition(() =>
                    confirming === 'purge'
                      ? purgeSourceAction(view.source)
                      : deleteSourceAction(view.source),
                  )
                }
                className={dangerButton}
              >
                {confirming === 'purge'
                  ? `Remove ${view.memoriesSaved} memories`
                  : `Delete import${view.memoriesSaved > 0 ? ` and ${view.memoriesSaved} memories` : ''}`}
              </button>
              <button type="button" onClick={() => setConfirming(null)} className={outlineButton}>
                Cancel
              </button>
            </>
          ) : (
            <>
              {view.status !== 'purged' && view.memoriesSaved > 0 ? (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => setConfirming('purge')}
                  className={dangerOutlineButton}
                  title="Remove the memories from this import but keep its file"
                >
                  Remove memories
                </button>
              ) : null}
              <button
                type="button"
                disabled={pending}
                onClick={() => setConfirming('delete')}
                className={dangerOutlineButton}
                title="Remove this import, its memories, and the uploaded file"
              >
                Delete import
              </button>
            </>
          )}
        </div>
      </details>
    </article>
  );
}

/** Start button for a workspace import/ file with no source row yet. */
export function StartImportButton({ path, suggestedTag }: { path: string; suggestedTag: string }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <span className="flex items-center gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await startImportAction(path, suggestedTag);
            if (result.error) setError(result.error);
          })
        }
        className={outlineButton}
      >
        {pending ? 'Starting…' : 'Start import'}
      </button>
      {error ? <span className="text-xs text-red-600 dark:text-red-400">{error}</span> : null}
    </span>
  );
}
