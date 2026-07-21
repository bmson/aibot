import {
  documentStats,
  getAgent,
  getOrCreatePrimaryConversation,
  listDocuments,
} from '@assistant/core';
import { requireOwner } from '@/auth';
import { relativeTime } from '@/lib/format';
import { getDb } from '@/lib/server';
import { EmptyState, PageHeader } from '@/lib/ui';
import { DocumentCard, type DocumentCardView } from './document-card';

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
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Documents"
        intro="Upload files — PDFs, notes, exports — and I'll read them so you can ask about their contents in chat. Attachments from people you know are filed here automatically. Text and PDFs are read right away; scans and office files wait for the document processor."
      />

      <section className="mt-8">
        <h2 className="text-sm font-medium">Upload a document</h2>
        <form
          action="/api/documents/upload"
          method="post"
          encType="multipart/form-data"
          className="mt-3 flex flex-col items-start gap-3"
        >
          <div className="flex flex-wrap items-center gap-3">
            <input
              type="file"
              name="file"
              required
              className="text-xs text-zinc-600 file:mr-3 file:rounded-md file:border file:border-zinc-300 file:bg-white file:px-2.5 file:py-1 file:text-xs file:font-medium file:text-zinc-700 hover:file:bg-zinc-100 dark:text-zinc-400 dark:file:border-zinc-700 dark:file:bg-zinc-900 dark:file:text-zinc-300"
            />
            <button
              type="submit"
              className="rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700"
            >
              Upload
            </button>
          </div>
          <details className="text-xs text-zinc-500 dark:text-zinc-400">
            <summary className="cursor-pointer">Give it a title</summary>
            <label className="mt-2 flex flex-col gap-1">
              Title
              <input
                type="text"
                name="title"
                placeholder="For example, Apartment lease"
                className="w-64 rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              />
            </label>
          </details>
        </form>
        <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-500">Files can be up to 25MB.</p>
      </section>

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
          <div className="mt-3 flex flex-col gap-2.5">
            {views.map((doc) => (
              <DocumentCard key={doc.id} doc={doc} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
