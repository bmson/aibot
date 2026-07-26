import { isVoiceImportSource } from '@assistant/core';
import { type ImportSourceRow, importSources, memories } from '@assistant/db';
import { and, desc, eq, sql } from 'drizzle-orm';
import { SourceCard, type SourceView, StartImportButton } from '@/app/import/source-card';
import { requireOwner } from '@/auth';
import { relativeTime } from '@/lib/format';
import { getDb, getWorkspace } from '@/lib/server';
import { fileInputClass, inputClass, PageHeader, PageShell, Panel } from '@/lib/ui';
import { SubmitButton } from '@/lib/ui-client';

export const metadata = { title: 'Import' };

export const dynamic = 'force-dynamic';

function toView(row: ImportSourceRow, quarantinedNow: number, now: Date): SourceView {
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
  const db = getDb();
  const now = new Date();

  const [allSources, quarantineCounts, importFiles] = await Promise.all([
    db.select().from(importSources).orderBy(desc(importSources.updatedAt)),
    db
      .select({ source: memories.source, n: sql<number>`count(*)` })
      .from(memories)
      .where(and(eq(memories.quarantined, true), sql`${memories.source} IS NOT NULL`))
      .groupBy(memories.source),
    getWorkspace()
      .list('import')
      .catch(() => [] as Array<{ name: string; dir: boolean }>),
  ]);
  // Voice-sample imports seed the writing corpus, not memory — they're managed
  // on the Profile page, so they never appear in the backstory list.
  const sources = allSources.filter((s) => !isVoiceImportSource(s.source));
  const quarantinedBySource = new Map(quarantineCounts.map((r) => [r.source ?? '', Number(r.n)]));
  const knownPaths = new Set(allSources.map((s) => s.workspacePath));
  const unstartedFiles = importFiles.filter((f) => !f.dir && !knownPaths.has(`import/${f.name}`));

  return (
    <PageShell size="reading">
      <PageHeader
        title="Backstory import"
        intro="Add email archives, chat exports, or notes to help the assistant understand your history. You can review anything it learns about other people before it is remembered."
      />

      {/* Upload */}
      <Panel tone="sunken" className="mt-8">
        <h2 id="archive-upload-title" className="text-[15px] font-semibold">
          Upload an archive
        </h2>
        <form
          action="/api/import/upload"
          method="post"
          encType="multipart/form-data"
          className="mt-3 flex flex-col items-start gap-3"
        >
          <div className="flex w-full min-w-0 flex-wrap items-center gap-3">
            <input
              type="file"
              name="file"
              required
              aria-labelledby="archive-upload-title"
              className={fileInputClass}
            />
            <SubmitButton variant="primary" pendingLabel="Uploading…">
              Upload and import
            </SubmitButton>
          </div>
          <details className="text-xs text-muted">
            <summary className="disclosure flex items-center gap-2 cursor-pointer">
              Choose a custom label
            </summary>
            <label className="mt-2 flex flex-col gap-1">
              Label
              <input
                type="text"
                name="source"
                placeholder="For example, old work email"
                className={`${inputClass} w-64`}
              />
            </label>
          </details>
        </form>
        <p className="mt-2 text-xs text-muted">
          Files can be up to 25MB. For larger archives, add the file to{' '}
          <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">import/</code> and start them
          from the list below.
        </p>
      </Panel>

      {/* Unstarted workspace files */}
      {unstartedFiles.length > 0 ? (
        <section className="mt-8">
          <h2 className="text-sm font-medium">Files ready to import</h2>
          <div className="mt-3 flex flex-col gap-2">
            {unstartedFiles.map((f) => (
              <div
                key={f.name}
                className="flex items-center justify-between gap-3 rounded-md border border-zinc-200 px-3 py-2 dark:border-zinc-800"
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
        <h2 className="text-sm font-medium">Import history</h2>
        {sources.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">Nothing imported yet.</p>
        ) : (
          <div className="mt-3 flex flex-col gap-3">
            {sources.map((row) => (
              <SourceCard
                key={`${row.id}:${row.updatedAt.getTime()}`}
                view={toView(row, quarantinedBySource.get(row.source) ?? 0, now)}
              />
            ))}
          </div>
        )}
      </section>
    </PageShell>
  );
}
