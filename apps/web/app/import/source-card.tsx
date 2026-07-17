'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import {
  deleteSourceAction,
  purgeSourceAction,
  reviewSourceAction,
  startImportAction,
} from '@/app/import/actions';
import { btn } from '@/lib/ui';

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

const statusChipClasses: Record<string, string> = {
  pending: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  running: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300',
  done: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  failed: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  purged: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-500',
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
    <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 text-sm font-medium">{view.source}</p>
        <span
          className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${statusChipClasses[view.status] ?? statusChipClasses.pending}`}
        >
          {view.status}
        </span>
      </div>
      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-500">
        {view.workspacePath} · {view.kind} · {view.updatedLabel}
        {view.taskId ? (
          <>
            {' · '}
            <Link
              href={`/tasks/${view.taskId}`}
              className="underline hover:text-zinc-800 dark:hover:text-zinc-200"
            >
              task
            </Link>
          </>
        ) : null}
      </p>

      <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
        {pct !== null
          ? `${view.itemsProcessed}/${view.itemsTotal} windows (${pct}%)`
          : 'not started'}
        {` · ${view.memoriesSaved} memories`}
        {view.quarantinedNow > 0 ? ` · ${view.quarantinedNow} awaiting review` : ''}
      </p>
      {pct !== null && view.status === 'running' ? (
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
          <div className="h-full rounded-full bg-blue-500" style={{ width: `${pct}%` }} />
        </div>
      ) : null}
      {view.error ? (
        <p className="mt-1 text-xs text-red-600 dark:text-red-400">{view.error}</p>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        {view.quarantinedNow > 0 ? (
          <>
            <button
              type="button"
              disabled={pending}
              onClick={() => startTransition(() => reviewSourceAction(view.source, 'approve'))}
              className={outlineButton}
              title="Release every quarantined fact from this source into normal memory"
            >
              Approve all ({view.quarantinedNow})
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
          </>
        ) : null}
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
            title="Re-run this source (already-saved memories are skipped by hash)"
          >
            Re-run
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
                ? `Really purge ${view.memoriesSaved} memories`
                : `Really delete source${view.memoriesSaved > 0 ? ` + ${view.memoriesSaved} memories` : ''}`}
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
                title="Remove every memory this source produced, keep the source for re-running"
              >
                Purge
              </button>
            ) : null}
            <button
              type="button"
              disabled={pending}
              onClick={() => setConfirming('delete')}
              className={dangerOutlineButton}
              title="Remove the source entirely: its memories, the uploaded file, and this entry"
            >
              Delete
            </button>
          </>
        )}
      </div>
      {error ? <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p> : null}
    </div>
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
