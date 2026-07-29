import { isModuleEnabled, loadConfig } from '@assistant/config';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { UploadPanel } from '@/app/upload-panel';
import { requireOwner } from '@/auth';
import { relativeTime } from '@/lib/format';
import { getApplication } from '@/lib/server';
import { btn, cardGridClass, EmptyState, PageHeader, PageShell, SectionHeading } from '@/lib/ui';
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
  if (!isModuleEnabled(loadConfig(), 'documents')) notFound();
  const now = new Date();
  const { documents: docs, stats, primaryConversationId } = await getApplication().getDocuments();

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
    askHref: `/chat/${primaryConversationId}?ask=${encodeURIComponent(
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

      <UploadPanel
        className="mt-8"
        title="Upload a document"
        action="/api/documents/upload"
        submitLabel="Upload"
        labelSummary="Give it a title"
        labelName="title"
        labelCaption="Title"
        labelPlaceholder="For example, Apartment lease"
        hint="Files can be up to 25MB."
      />

      <section className="mt-8">
        <SectionHeading
          title="Filed documents"
          count={stats.total > 0 ? stats.total : undefined}
          hint={
            stats.total > 0
              ? `${stats.ready} ready · ${stats.chunks} searchable passage${
                  stats.chunks === 1 ? '' : 's'
                }${stats.pending > 0 ? ` · ${stats.pending} in progress` : ''}`
              : undefined
          }
        />
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
