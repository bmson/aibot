import { type ImportSourceRow, importSources, memories } from '@assistant/db';
import { and, desc, eq, sql } from 'drizzle-orm';
import { SourceCard, type SourceView, StartImportButton } from '@/app/import/source-card';
import { requireOwner } from '@/auth';
import { relativeTime } from '@/lib/format';
import { getDb, getWorkspace } from '@/lib/server';

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

  const [sources, quarantineCounts, importFiles] = await Promise.all([
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
  const quarantinedBySource = new Map(quarantineCounts.map((r) => [r.source ?? '', Number(r.n)]));
  const knownPaths = new Set(sources.map((s) => s.workspacePath));
  const unstartedFiles = importFiles.filter((f) => !f.dir && !knownPaths.has(`import/${f.name}`));

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="text-xl font-semibold">Backstory import</h1>
      <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
        Feed the assistant your digital past — Takeout mail archives (.mbox), chat exports (.json),
        or plain notes. Archives are distilled into memories with source provenance: a whole source
        can be re-run or purged atomically, and facts about other people wait in quarantine until
        you review them.
      </p>

      {/* Upload */}
      <section className="mt-8">
        <h2 className="text-sm font-medium">Upload an archive</h2>
        <form
          action="/api/import/upload"
          method="post"
          encType="multipart/form-data"
          className="mt-3 flex flex-wrap items-center gap-3"
        >
          <input
            type="file"
            name="file"
            required
            className="text-xs text-zinc-600 file:mr-3 file:rounded-md file:border file:border-zinc-300 file:bg-white file:px-2.5 file:py-1 file:text-xs file:font-medium file:text-zinc-700 hover:file:bg-zinc-100 dark:text-zinc-400 dark:file:border-zinc-700 dark:file:bg-zinc-900 dark:file:text-zinc-300"
          />
          <input
            type="text"
            name="source"
            placeholder="source tag (e.g. takeout-mail-2021)"
            className="w-64 rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
          />
          <button
            type="submit"
            className="rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700"
          >
            Upload &amp; start
          </button>
        </form>
        <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-500">
          Up to 25MB here. Bigger archives: copy into the workspace bucket under{' '}
          <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">import/</code> and start them
          from the list below.
        </p>
      </section>

      {/* Unstarted workspace files */}
      {unstartedFiles.length > 0 ? (
        <section className="mt-8">
          <h2 className="text-sm font-medium">Files in import/ not yet imported</h2>
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
        <h2 className="text-sm font-medium">Sources</h2>
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
    </div>
  );
}
