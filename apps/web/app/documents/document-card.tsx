'use client';

import { FileText } from 'lucide-react';
import Link from 'next/link';
import { useState, useTransition } from 'react';
import {
  btnSm,
  cardBodyClass,
  cardFooterClass,
  cardHeaderClass,
  cardShellClass,
  InfoGrid,
  InfoItem,
} from '@/lib/ui';
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
  const sourceLabel =
    doc.source === 'email' ? 'Email attachment' : doc.source === 'drive' ? 'Drive' : 'Upload';
  const formatLabel = doc.mime.split('/').pop()?.toUpperCase() ?? doc.mime;

  return (
    <article className={`${cardShellClass} flex h-full flex-col`}>
      <div className={`${cardBodyClass} flex-1`}>
        <div className={cardHeaderClass}>
          <div className="flex min-w-0 items-start gap-3">
            <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <FileText className="size-4" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h3 className="truncate text-[15px] font-semibold tracking-[-0.01em]">{doc.title}</h3>
              <p className="mt-0.5 text-xs text-muted">
                {sourceLabel}
                {doc.trust !== 'owner' ? ' · Third-party source' : ''}
              </p>
            </div>
          </div>
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-2xs font-medium ${status?.className ?? ''}`}
          >
            {status?.label}
          </span>
        </div>

        <InfoGrid className="sm:grid-cols-4">
          <InfoItem label="Format">{formatLabel}</InfoItem>
          <InfoItem label="Size">{doc.bytesLabel}</InfoItem>
          <InfoItem label="Added">{doc.createdLabel}</InfoItem>
          <InfoItem label="Searchable">
            {doc.status === 'ready'
              ? `${doc.chunkCount} passage${doc.chunkCount === 1 ? '' : 's'}`
              : 'Not yet'}
          </InfoItem>
        </InfoGrid>

        {waitingForProcessor ? (
          <p className="rounded-xl bg-sunken/65 px-3 py-2.5 text-xs leading-5 text-muted">
            Waiting for the document processor to read this format.
          </p>
        ) : null}
        {doc.status === 'failed' && doc.error ? (
          <p className="rounded-xl bg-red-50 px-3 py-2.5 text-xs leading-5 text-red-700 dark:bg-red-950/35 dark:text-red-300">
            {doc.error}
          </p>
        ) : null}
      </div>
      <footer className={cardFooterClass}>
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
      </footer>
    </article>
  );
}
