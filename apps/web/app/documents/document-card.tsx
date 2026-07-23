'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { purgeDocumentAction } from './actions';

export interface DocumentCardView {
  id: string;
  title: string;
  mime: string;
  source: string;
  trust: string;
  status: string;
  extractor: string;
  chunkCount: number;
  bytesLabel: string;
  error: string | null;
  createdLabel: string;
  askHref: string;
}

const STATUS: Record<string, { label: string; className: string }> = {
  ready: {
    label: 'Ready',
    className: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  },
  extracting: {
    label: 'Reading…',
    className: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200',
  },
  pending: {
    label: 'Queued',
    className: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  },
  unsupported: {
    label: 'Unsupported',
    className: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  },
  failed: {
    label: 'Failed',
    className: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200',
  },
};

export function DocumentCard({ doc }: { doc: DocumentCardView }) {
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const status = STATUS[doc.status] ?? STATUS.pending;
  // A queued heavy format (scan/office/audio) waits for the document processor.
  const waitingForProcessor = doc.status === 'pending' && doc.extractor === 'pending_processor';

  return (
    <div className="rounded-md border border-zinc-200 px-3 py-2.5 dark:border-zinc-800">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{doc.title}</p>
          <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
            {doc.bytesLabel} ·{' '}
            {doc.source === 'email'
              ? 'from an attachment'
              : doc.source === 'drive'
                ? 'from Drive'
                : 'uploaded'}{' '}
            · {doc.createdLabel}
            {doc.status === 'ready'
              ? ` · ${doc.chunkCount} passage${doc.chunkCount === 1 ? '' : 's'}`
              : ''}
            {doc.trust !== 'owner' ? ' · third-party' : ''}
          </p>
        </div>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-2xs font-medium ${status?.className ?? ''}`}
        >
          {status?.label}
        </span>
      </div>

      {waitingForProcessor ? (
        <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
          Waiting for the document processor to read this format.
        </p>
      ) : null}
      {doc.status === 'failed' && doc.error ? (
        <p className="mt-2 text-xs text-red-700 dark:text-red-300">{doc.error}</p>
      ) : null}

      <div className="mt-2.5 flex items-center gap-2">
        {doc.status === 'ready' ? (
          <Link
            href={doc.askHref}
            className="rounded-md border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
          >
            Ask about this
          </Link>
        ) : null}
        {confirming ? (
          <>
            <button
              type="button"
              disabled={pending}
              onClick={() => startTransition(() => purgeDocumentAction(doc.id))}
              className="rounded-md bg-red-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
            >
              {pending ? 'Deleting…' : 'Confirm delete'}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => setConfirming(false)}
              className="rounded-md border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-900"
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="rounded-md border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-900"
          >
            Delete
          </button>
        )}
      </div>
    </div>
  );
}
