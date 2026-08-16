import type { ImportSourceSnapshot } from '@assistant/application/imports';
import { SourceCard, type SourceView, StartImportButton } from '@/app/import/source-card';
import { UploadPanel } from '@/app/upload-panel';
import { requireOwner } from '@/auth';
import { relativeTime } from '@/lib/format';
import { getApplication } from '@/lib/server';
import { EmptyState, PageHeader, PageShell, SectionHeading } from '@/lib/ui';

export const metadata = { title: 'Import' };

export const dynamic = 'force-dynamic';

function toView(row: ImportSourceSnapshot, quarantinedNow: number, now: Date): SourceView {
  return {
    source: row.source,
    workspacePath: row.workspacePath,
    kind: row.kind,
    status: row.status,
    itemsTotal: row.itemsTotal,
    itemsProcessed: row.itemsProcessed,
    memoriesSaved: row.memoriesSaved,
    quarantinedNow,
    taskId: row.taskId,
    error: row.error,
    updatedLabel: `updated ${relativeTime(row.updatedAt, now)}`,
  };
}

export default async function ImportPage() {
  await requireOwner();
  const now = new Date();
  const { sources, quarantineBySource, unstartedFiles } = await getApplication().getImports();

  return (
    <PageShell size="reading">
      <PageHeader
        back={{ href: '/documents', label: 'Documents' }}
        title="Backstory import"
        intro="Add email archives, chat exports, or notes to help the assistant understand your history. You can review anything it learns about other people before it is remembered."
      />

      {/* Upload */}
      <UploadPanel
        className="mt-8"
        title="Upload an archive"
        action="/api/import/upload"
        submitLabel="Upload and import"
        labelSummary="Choose a custom label"
        labelName="source"
        labelCaption="Label"
        labelPlaceholder="For example, old work email"
        hint={
          <>
            Files can be up to 25MB. For larger archives, add the file to{' '}
            <code className="rounded bg-sunken px-1">import/</code> and start them from the list
            below.
          </>
        }
      />

      {/* Unstarted workspace files */}
      {unstartedFiles.length > 0 ? (
        <section className="mt-8">
          <SectionHeading title="Files ready to import" count={unstartedFiles.length} />
          <div className="mt-3 flex flex-col gap-2">
            {unstartedFiles.map((f) => (
              <div
                key={f.name}
                className="flex items-center justify-between gap-3 rounded-lg border border-edge px-3 py-2"
              >
                <p className="min-w-0 truncate text-sm">{f.name}</p>
                <StartImportButton
                  path={`import/${f.name}`}
                  suggestedTag={f.name.replace(/\.[a-z0-9]+$/i, '').toLowerCase()}
                />
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {/* Sources */}
      <section className="mt-8">
        <SectionHeading
          title="Import history"
          count={sources.length > 0 ? sources.length : undefined}
        />
        {sources.length === 0 ? (
          <EmptyState>Nothing imported yet.</EmptyState>
        ) : (
          <div className="mt-3 flex flex-col gap-3">
            {sources.map((row) => (
              <SourceCard
                key={`${row.id}:${row.updatedAt.getTime()}`}
                view={toView(row, quarantineBySource[row.source] ?? 0, now)}
              />
            ))}
          </div>
        )}
      </section>
    </PageShell>
  );
}
