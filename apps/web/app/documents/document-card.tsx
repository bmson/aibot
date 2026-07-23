'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { btnSm } from '@/lib/ui';
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
    <div className="rounded-2xl bg-raised p-4 shadow-[0_1px_2px_rgb(23_25_35/0.06)]">
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
          <Link href={doc.askHref} className={btnSm.outline}>
            Ask about this
          </Link>
        ) : null}
        {confirming ? (
          <>
            <button
              type="button"
              disabled={pending}
              onClick={() => startTransition(() => purgeDocumentAction(doc.id))}
              className={btnSm.danger}
            >
              {pending ? 'Deleting…' : 'Confirm delete'}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => setConfirming(false)}
              className={btnSm.outline}
            >
              Cancel
            </button>
          </>
        ) : (
          <button type="button" onClick={() => setConfirming(true)} className={btnSm.dangerOutline}>
            Delete
          </button>
        )}
      </div>
    </div>
  );
}
