import {
  documentStats,
  getAgent,
  getOrCreatePrimaryConversation,
  listDocuments,
} from '@assistant/core';
import Link from 'next/link';
import { requireOwner } from '@/auth';
import { relativeTime } from '@/lib/format';
import { getDb } from '@/lib/server';
import {
  btn,
  cardGridClass,
  EmptyState,
  fileInputClass,
  inputClass,
  PageHeader,
  PageShell,
  Panel,
} from '@/lib/ui';
import { SubmitButton } from '@/lib/ui-client';
import { DocumentCard, type DocumentCardView } from './document-card';

export const metadata = { title: 'Documents' };

export const dynamic = 'force-dynamic';

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default async function DocumentsPage() {
  await requireOwner();
  const db = getDb();
  const now = new Date();
  const agent = await getAgent(db);
  const [docs, stats, primary] = await Promise.all([
    listDocuments(db, agent.id),
    documentStats(db, agent.id),
    getOrCreatePrimaryConversation(db, agent.id),
  ]);

  const views: DocumentCardView[] = docs.map((d) => ({
    id: d.id,
    title: d.title,
    mime: d.mime,
    source: d.source,
    trust: d.trust,
    status: d.status,
    extractor: d.extractor,
    chunkCount: d.chunkCount,
    bytesLabel: formatBytes(d.bytes),
    error: d.error,
    createdLabel: relativeTime(d.createdAt, now),
    askHref: `/chat/${primary.id}?ask=${encodeURIComponent(
      `From my documents, tell me about "${d.title}".`,
    )}`,
  }));

  return (
    <PageShell size="reading">
      <PageHeader
        title="Documents"
        intro="Upload files — PDFs, notes, exports — and I'll read them so you can ask about their contents in chat. Attachments from people you know are filed here automatically. Text and PDFs are read right away; scans and office files wait for the document processor."
        actions={
          <Link href="/import" className={btn.outline}>
            Import backstory
          </Link>
        }
      />

      <Panel tone="sunken" className="mt-8">
        <h2 id="document-upload-title" className="text-[15px] font-semibold">
          Upload a document
        </h2>
        <form
          action="/api/documents/upload"
          method="post"
          encType="multipart/form-data"
          className="mt-3 flex flex-col items-start gap-3"
        >
          <div className="flex w-full min-w-0 flex-wrap items-center gap-3">
            <input
              type="file"
              name="file"
              required
              aria-labelledby="document-upload-title"
              className={fileInputClass}
            />
            <SubmitButton variant="primary" pendingLabel="Uploading…">
              Upload
            </SubmitButton>
          </div>
          <details className="text-xs text-muted">
            <summary className="disclosure flex items-center gap-2 cursor-pointer">
              Give it a title
            </summary>
            <label className="mt-2 flex flex-col gap-1">
              Title
              <input
                type="text"
                name="title"
                placeholder="For example, Apartment lease"
                className={`${inputClass} w-64`}
              />
            </label>
          </details>
        </form>
        <p className="mt-2 text-xs text-muted">Files can be up to 25MB.</p>
      </Panel>

      <section className="mt-8">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-medium">Filed documents</h2>
          {stats.total > 0 ? (
            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              {stats.ready} ready · {stats.chunks} searchable passage
              {stats.chunks === 1 ? '' : 's'}
              {stats.pending > 0 ? ` · ${stats.pending} in progress` : ''}
            </span>
          ) : null}
        </div>
        {views.length === 0 ? (
          <div className="mt-3">
            <EmptyState>
              No documents yet. Upload one above, or forward an email with an attachment.
            </EmptyState>
          </div>
        ) : (
          <div className={`${cardGridClass} mt-3`}>
            {views.map((doc) => (
              <DocumentCard key={doc.id} doc={doc} />
            ))}
          </div>
        )}
      </section>
    </PageShell>
  );
}
