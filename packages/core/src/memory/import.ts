import { createHash } from 'node:crypto';
import {
  addTombstone,
  type Db,
  type ImportSourceRow,
  importSources,
  isTombstoned,
  memories,
  resolveSubjectContact,
  type TaskRow,
  tasks,
} from '@assistant/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { isUnparseableObjectError, type ModelRouter } from '../model-router/router.js';
import { withSpan } from '../otel.js';
import { getQueueNotifier } from '../queue.js';
import { enqueueTask } from '../workflow/machine.js';
import { compileOwnerCard } from './consolidation.js';
import { ExtractedFactSchema, parseValidFrom } from './extraction.js';
import {
  ageScaledConfidence,
  type ImportKind,
  parseArchive,
  windowUnits,
} from './import-parsers.js';

/**
 * Backstory import (Phase 22): batch-distill an archive from the workspace
 * import/ prefix into entity-linked memories through the same attribution
 * rules as nightly extraction. Resumable: the window cursor checkpoints into
 * tasks.state after every window — an interrupted 100k-email import resumes,
 * never restarts, and content-hash dedupe makes overlap harmless.
 *
 * Tiering by design: only distilled FACTS reach the database and embeddings;
 * resumability snapshots remain inside the private workspace. Facts about
 * third parties land quarantined until profile review; facts about the owner
 * are trusted (origin_trust 'owner', it's the owner's own archive). Confidence
 * scales down with source age.
 */

/** Minimal structural view of the workspace store (defined in @assistant/tools — no cycle). */
export interface WorkspaceReader {
  read(relPath: string): Promise<string>;
  write(relPath: string, content: string): Promise<unknown>;
  list(relPath: string): Promise<Array<{ name: string; dir: boolean }>>;
  /** Binary read — present on the real store; used by document extraction (PDFs). */
  readBytes?(relPath: string): Promise<Buffer>;
}

const ImportFactsSchema = z.object({ facts: z.array(ExtractedFactSchema).max(20) });

const WINDOWS_PER_RUN = 6; // checkpoint granularity: one run ≈ one queue lease
const RESUME_DELAY_MS = 5_000;
const SNAPSHOT_LOCK_RETRY_MS = 30_000;
const BUDGET_RETRY_DELAY_MS = 6 * 3600 * 1000;

interface ImportCursor {
  windowIndex: number;
  saved: number;
  duplicates: number;
  tombstoned: number;
  quarantined: number;
  /** Durable parsed snapshot. Resumed leases never reopen the source archive. */
  manifestPath?: string;
  manifestHash?: string;
}

const IMPORT_SNAPSHOT_VERSION = 1;
const WINDOWS_PER_SHARD = 64;
const MIN_WINDOW_CHARS = 500;
const MAX_WINDOW_CHARS = 20_000;

const ImportShardSchema = z
  .array(
    z.object({
      date: z.string().datetime().nullable(),
      text: z.string().max(MAX_WINDOW_CHARS + 500),
    }),
  )
  .max(WINDOWS_PER_SHARD);

const ImportManifestSchema = z.object({
  version: z.literal(IMPORT_SNAPSHOT_VERSION),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  windowCount: z.number().int().nonnegative(),
  shards: z
    .array(
      z.object({
        path: z.string().min(1),
        start: z.number().int().nonnegative(),
        count: z.number().int().positive().max(WINDOWS_PER_SHARD),
        hash: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .max(100_000),
});

type ImportManifest = z.infer<typeof ImportManifestSchema>;
type ImportShardWindow = z.infer<typeof ImportShardSchema>[number];

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function snapshotBasePath(source: string, taskId: string): string {
  // `source` is constrained by startImport and taskId is a UUID. Keeping
  // snapshots outside import/ prevents them from appearing as user uploads.
  return `.assistant/imports/${source}/${taskId}`;
}

async function createImportSnapshot(
  workspace: WorkspaceReader,
  payload: ImportPayload,
  taskId: string,
): Promise<{ manifest: ImportManifest; path: string; hash: string }> {
  const content = await workspace.read(payload.path);
  const windows = windowUnits(parseArchive(payload.kind, content), payload.windowChars);
  const base = snapshotBasePath(payload.source, taskId);
  const shards: ImportManifest['shards'] = [];

  for (let start = 0; start < windows.length; start += WINDOWS_PER_SHARD) {
    const path = `${base}/windows-${String(start / WINDOWS_PER_SHARD).padStart(6, '0')}.json`;
    const shard = windows.slice(start, start + WINDOWS_PER_SHARD).map((window) => ({
      date: window.date?.toISOString() ?? null,
      text: window.text,
    }));
    const serialized = JSON.stringify(shard);
    await workspace.write(path, serialized);
    shards.push({ path, start, count: shard.length, hash: sha256(serialized) });
  }

  const manifest: ImportManifest = {
    version: IMPORT_SNAPSHOT_VERSION,
    sourceHash: sha256(content),
    windowCount: windows.length,
    shards,
  };
  const serialized = JSON.stringify(manifest);
  const path = `${base}/manifest.json`;
  // Publish the manifest only after every referenced shard is durable. A
  // partial snapshot is therefore never mistaken for a resumable one.
  await workspace.write(path, serialized);
  return { manifest, path, hash: sha256(serialized) };
}

/**
 * Snapshot parsing temporarily holds several representations of a large
 * archive. Serialize only that phase across instances so scaled Cloud Run
 * requests cannot multiply the peak memory footprint and OOM one another.
 */
async function tryCreateImportSnapshot(
  db: Db,
  workspace: WorkspaceReader,
  payload: ImportPayload,
  taskId: string,
): Promise<Awaited<ReturnType<typeof createImportSnapshot>> | null> {
  const connection = await db.$client.reserve();
  let acquired = false;
  try {
    const [row] = await connection<[{ acquired: boolean }]>`
      select pg_try_advisory_lock(hashtext('assistant:import-snapshot')) as acquired
    `;
    acquired = row?.acquired === true;
    if (!acquired) return null;
    return await createImportSnapshot(workspace, payload, taskId);
  } finally {
    if (acquired) {
      await connection`select pg_advisory_unlock(hashtext('assistant:import-snapshot'))`.catch(
        (error) => console.error('import: failed to release snapshot lock', error),
      );
    }
    connection.release();
  }
}

async function readImportManifest(
  workspace: WorkspaceReader,
  path: string,
  expectedHash: string,
  expectedBase: string,
): Promise<ImportManifest> {
  const serialized = await workspace.read(path);
  if (sha256(serialized) !== expectedHash) throw new Error('import snapshot manifest is corrupt');
  return validateManifestTopology(ImportManifestSchema.parse(JSON.parse(serialized)), expectedBase);
}

function validateManifestTopology(manifest: ImportManifest, expectedBase: string): ImportManifest {
  let nextStart = 0;
  for (let index = 0; index < manifest.shards.length; index++) {
    const shard = manifest.shards[index];
    const expectedPath = `${expectedBase}/windows-${String(index).padStart(6, '0')}.json`;
    if (!shard || shard.start !== nextStart || shard.path !== expectedPath) {
      throw new Error('import snapshot manifest has invalid shard topology');
    }
    nextStart += shard.count;
  }
  if (nextStart !== manifest.windowCount) {
    throw new Error('import snapshot manifest window count does not match its shards');
  }
  return manifest;
}

function missingWorkspaceFile(error: unknown): boolean {
  const candidate = error as { code?: string; message?: string };
  return candidate.code === 'ENOENT' || candidate.message?.includes('no such file') === true;
}

async function readImportShard(
  workspace: WorkspaceReader,
  manifest: ImportManifest,
  windowIndex: number,
): Promise<{ start: number; windows: ImportShardWindow[] }> {
  const shard = manifest.shards.find(
    (candidate) =>
      windowIndex >= candidate.start && windowIndex < candidate.start + candidate.count,
  );
  if (!shard) throw new Error(`import snapshot has no shard for window ${windowIndex}`);
  const serialized = await workspace.read(shard.path);
  if (sha256(serialized) !== shard.hash) {
    throw new Error(`import snapshot shard is corrupt: ${shard.path}`);
  }
  const windows = ImportShardSchema.parse(JSON.parse(serialized));
  if (windows.length !== shard.count) {
    throw new Error(`import snapshot shard has the wrong window count: ${shard.path}`);
  }
  return { start: shard.start, windows };
}

interface ImportPayload {
  job: string;
  source: string;
  path: string;
  kind: ImportKind;
  windowsPerRun?: number;
  windowChars?: number;
}

function importPayload(task: TaskRow): ImportPayload {
  const payload = (task.trigger as { payload?: Record<string, unknown> })?.payload ?? {};
  const source = String(payload.source ?? '');
  const path = String(payload.path ?? '');
  const kind = String(payload.kind ?? 'text') as ImportKind;
  if (!source || !path) throw new Error('import task payload needs source and path');
  if (kind !== 'mbox' && kind !== 'json' && kind !== 'text') {
    throw new Error(`unsupported import kind: ${kind}`);
  }
  const optionalInteger = (name: 'windowsPerRun' | 'windowChars', min: number, max: number) => {
    const value = payload[name];
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      throw new Error(`import task ${name} must be an integer from ${min} to ${max}`);
    }
    return value;
  };
  return {
    job: String(payload.job),
    source,
    path,
    kind,
    windowsPerRun: optionalInteger('windowsPerRun', 1, WINDOWS_PER_SHARD),
    windowChars: optionalInteger('windowChars', MIN_WINDOW_CHARS, MAX_WINDOW_CHARS),
  };
}

function importSystem(source: string, period: string): string {
  return [
    "You distill an ARCHIVE from the owner's (Baldvin's) digital past into lasting memories.",
    `Source: ${source}. Period: ${period}. The content may be years old — extract only`,
    'durable, biography-level information: who people are, where he lived/worked, lasting',
    'preferences, significant events. Skip logistics, newsletters, receipts, marketing,',
    'and anything trivially dated. Each fact must stand alone, in third person, with names',
    'spelled out. Use subject "owner" for Baldvin himself. Include validFrom (ISO date)',
    'when the period implies it. If nothing is worth keeping, return an empty facts array.',
  ].join('\n');
}

export interface ImportRunResult {
  done: boolean;
  runAfter?: Date;
  summary: string;
}

export async function runImportJob(
  deps: {
    db: Db;
    router: ModelRouter;
    workspace?: WorkspaceReader;
    heartbeat?: () => Promise<void>;
  },
  task: TaskRow,
): Promise<ImportRunResult> {
  const { db, router, workspace } = deps;
  if (!workspace) throw new Error('import job needs a workspace store (executor deps)');
  const payload = importPayload(task);

  return withSpan('memory.import', { source: payload.source }, async () => {
    await deps.heartbeat?.();
    const [sourceRow] = await db
      .select()
      .from(importSources)
      .where(eq(importSources.source, payload.source));
    if (!sourceRow) throw new Error(`unknown import source: ${payload.source}`);
    if (sourceRow.status === 'purged') {
      return { done: true, summary: `import ${payload.source}: source was purged — nothing to do` };
    }

    // Resume point: cursor lives in the task checkpoint
    const state = (task.state ?? {}) as Record<string, unknown>;
    const plannerState = (state.plannerState ?? {}) as Record<string, unknown>;
    const cursor: ImportCursor = {
      windowIndex: 0,
      saved: 0,
      duplicates: 0,
      tombstoned: 0,
      quarantined: 0,
      ...((plannerState.import as Partial<ImportCursor>) ?? {}),
    };

    let manifest: ImportManifest;
    let manifestCheckpointNeeded = false;
    const snapshotBase = snapshotBasePath(payload.source, task.id);
    if (cursor.manifestPath && cursor.manifestHash) {
      if (cursor.manifestPath !== `${snapshotBase}/manifest.json`) {
        throw new Error('import snapshot manifest path does not match this task');
      }
      manifest = await readImportManifest(
        workspace,
        cursor.manifestPath,
        cursor.manifestHash,
        snapshotBase,
      );
    } else {
      // If a worker died after publishing the manifest but before checkpointing
      // its path, reuse the completed snapshot instead of reopening the source.
      const publishedPath = `${snapshotBase}/manifest.json`;
      try {
        const serialized = await workspace.read(publishedPath);
        manifest = validateManifestTopology(
          ImportManifestSchema.parse(JSON.parse(serialized)),
          snapshotBase,
        );
        cursor.manifestPath = publishedPath;
        cursor.manifestHash = sha256(serialized);
      } catch (error) {
        if (!missingWorkspaceFile(error)) throw error;
        const snapshot = await tryCreateImportSnapshot(db, workspace, payload, task.id);
        if (!snapshot) {
          return {
            done: false,
            runAfter: new Date(Date.now() + SNAPSHOT_LOCK_RETRY_MS),
            summary: `import ${payload.source}: waiting for the bounded snapshot worker`,
          };
        }
        manifest = snapshot.manifest;
        cursor.manifestPath = snapshot.path;
        cursor.manifestHash = snapshot.hash;
      }
      manifestCheckpointNeeded = true;
    }
    await deps.heartbeat?.();

    await db
      .update(importSources)
      .set({
        status: 'running',
        taskId: task.id,
        itemsTotal: manifest.windowCount,
        updatedAt: sql`now()`,
      })
      .where(eq(importSources.id, sourceRow.id));

    const checkpoint = async () => {
      await deps.heartbeat?.();
      plannerState.import = cursor;
      state.plannerState = plannerState;
      await db
        .update(tasks)
        .set({
          state,
          progress: `import ${payload.source}: window ${cursor.windowIndex}/${manifest.windowCount}, ${cursor.saved} memories`,
          progressPercent: manifest.windowCount
            ? Math.min(100, Math.round((cursor.windowIndex / manifest.windowCount) * 100))
            : 100,
          // Each window is proof of progress: clear the poison-pill reclaim
          // counter so a multi-hour import that survives a few mid-run worker
          // deaths is not falsely dead-lettered (matches checkpointTask, which
          // this raw update stands in for on the code-job path).
          reclaimCount: 0,
          updatedAt: sql`now()`,
        })
        .where(eq(tasks.id, task.id));
      await db
        .update(importSources)
        .set({
          itemsProcessed: cursor.windowIndex,
          memoriesSaved: cursor.saved,
          memoriesQuarantined: cursor.quarantined,
          updatedAt: sql`now()`,
        })
        .where(eq(importSources.id, sourceRow.id));
    };

    const perRun = payload.windowsPerRun ?? WINDOWS_PER_RUN;
    const stopAt = Math.min(cursor.windowIndex + perRun, manifest.windowCount);
    let loadedShard: Awaited<ReturnType<typeof readImportShard>> | undefined;

    // Persist snapshot identity before the first paid model call. This keeps a
    // retry after an executor crash on the cheap shard path.
    if (manifestCheckpointNeeded) await checkpoint();

    while (cursor.windowIndex < stopAt) {
      await deps.heartbeat?.();
      if (
        !loadedShard ||
        cursor.windowIndex < loadedShard.start ||
        cursor.windowIndex >= loadedShard.start + loadedShard.windows.length
      ) {
        loadedShard = await readImportShard(workspace, manifest, cursor.windowIndex);
      }
      const window = loadedShard.windows[cursor.windowIndex - loadedShard.start];
      if (!window) throw new Error(`import snapshot is missing window ${cursor.windowIndex}`);
      const windowDate = window.date ? new Date(window.date) : null;
      const period = windowDate ? windowDate.toISOString().slice(0, 10) : 'unknown';

      // A single window the model can't structure (even on the fallback) must
      // not fail the whole import into a dead-letter — record it as progress and
      // move on. Budget stops still park/throw below; other errors still surface.
      const outcome = await router
        .object<z.infer<typeof ImportFactsSchema>>('extract', {
          taskId: task.id,
          schema: ImportFactsSchema,
          system: importSystem(payload.source, period),
          prompt: window.text,
        })
        .catch((err) => {
          if (!isUnparseableObjectError(err)) throw err;
          console.error(
            `import ${payload.source}: skipping window ${cursor.windowIndex} the model could not structure`,
            err,
          );
          return null;
        });
      await deps.heartbeat?.();
      if (outcome === null) {
        // Advance past the unstructurable window and checkpoint so a resume
        // never re-blocks on it; its facts are simply not learned.
        cursor.windowIndex += 1;
        await checkpoint();
        continue;
      }
      if (!outcome.ok) {
        // A daily/monthly cap (mode 'block') frees itself when the period
        // resets, so checkpoint and come back later — never lose progress.
        // A task-budget stop (mode 'park') is a cumulative spent-vs-limit cap
        // that NEVER resets on its own: yielding on it would re-block on the
        // next wake and re-fire this job every 6h forever, with import_sources
        // stuck 'running' so the owner can't even restart it. Mark the source
        // failed (re-runnable) and throw, so the task reaches needs_attention —
        // exactly how the model step loop treats task-budget exhaustion.
        if (outcome.decision.mode === 'park') {
          await db
            .update(importSources)
            .set({
              status: 'failed',
              error: outcome.decision.reason.slice(0, 2000),
              updatedAt: sql`now()`,
            })
            .where(eq(importSources.id, sourceRow.id));
          throw new Error(
            `import ${payload.source} exceeded its task budget and cannot continue (${outcome.decision.reason})`,
          );
        }
        // budget guard said stop — checkpoint and come back later, never lose progress
        await checkpoint();
        return {
          done: false,
          runAfter: new Date(Date.now() + BUDGET_RETRY_DELAY_MS),
          summary: `import ${payload.source}: paused by budget at window ${cursor.windowIndex}/${manifest.windowCount} (${outcome.decision.reason})`,
        };
      }

      const facts = outcome.object.facts;
      if (facts.length > 0) {
        const embeddings = await router.embed(
          facts.map((f) => f.content),
          { taskId: task.id },
        );
        await deps.heartbeat?.();
        await db.transaction(async (tx) => {
          const txDb = tx as unknown as Db;
          const [activeSource] = await tx
            .select({ status: importSources.status, taskId: importSources.taskId })
            .from(importSources)
            .where(eq(importSources.id, sourceRow.id))
            .for('update');
          const [activeTask] = await tx
            .select({ status: tasks.status })
            .from(tasks)
            .where(eq(tasks.id, task.id))
            .for('update');
          if (
            activeSource?.status !== 'running' ||
            activeSource.taskId !== task.id ||
            activeTask?.status !== 'running'
          ) {
            throw new Error(`import ${payload.source} was cancelled while processing`);
          }

          for (let i = 0; i < facts.length; i++) {
            const fact = facts[i];
            const embedding = embeddings[i];
            if (!fact || !embedding) continue;

            const contentHash = createHash('sha256').update(fact.content).digest('hex');
            if (await isTombstoned(txDb, contentHash)) {
              cursor.tombstoned += 1;
              continue;
            }
            const resolved = await resolveSubjectContact(txDb, {
              subject: fact.subject,
              relationship: fact.relationship,
            });
            // Owner's own archive → origin 'owner'; but facts ABOUT third parties
            // wait in quarantine until profile review.
            const aboutOwner = fact.subject.trim().toLowerCase() === 'owner';
            const confidence = ageScaledConfidence(fact.confidence, windowDate);

            const [row] = await tx
              .insert(memories)
              .values({
                agentId: task.agentId,
                category: 'knowledge',
                kind: fact.kind,
                content: fact.content,
                contentHash,
                embedding,
                importance: Math.min(fact.importance, 3),
                confidence: confidence.toFixed(2),
                originTrust: 'owner',
                quarantined: !aboutOwner,
                subjectContactId: resolved?.contactId,
                domain: fact.domain,
                validFrom: parseValidFrom(fact.validFrom) ?? windowDate ?? undefined,
                source: payload.source,
                sourceTaskId: task.id,
              })
              .onConflictDoNothing({ target: memories.contentHash })
              .returning({ id: memories.id });

            if (!row) cursor.duplicates += 1;
            else {
              cursor.saved += 1;
              if (!aboutOwner) cursor.quarantined += 1;
            }
          }
        });
      }

      cursor.windowIndex += 1;
      await checkpoint();
    }

    if (cursor.windowIndex >= manifest.windowCount) {
      await db
        .update(importSources)
        .set({ status: 'done', error: null, updatedAt: sql`now()` })
        .where(eq(importSources.id, sourceRow.id));
      // the profile card must reflect what was just learned
      await compileOwnerCard(db).catch((err) => console.error('card recompile failed', err));
      return {
        done: true,
        summary: `import ${payload.source}: complete — ${cursor.saved} memories (${cursor.quarantined} quarantined for review), ${cursor.duplicates} duplicates, ${cursor.tombstoned} tombstoned, ${manifest.windowCount} windows`,
      };
    }
    return {
      done: false,
      runAfter: new Date(Date.now() + RESUME_DELAY_MS),
      summary: `import ${payload.source}: ${cursor.windowIndex}/${manifest.windowCount} windows`,
    };
  });
}

// ── Lifecycle (dashboard + CLI entry points) ─────────────────────────────────

const DEFAULT_IMPORT_BUDGET_USD = '0.50';

/**
 * Register (or re-run) an import source and enqueue its resumable job task.
 * Re-running a done/failed source resets counters and relies on content-hash
 * dedupe — already-saved memories are skipped, not duplicated.
 */
export async function startImport(
  db: Db,
  input: {
    agentId: string;
    source: string;
    workspacePath: string;
    kind: ImportKind;
    budgetUsdLimit?: string;
    windowsPerRun?: number;
    windowChars?: number;
  },
): Promise<{ sourceRow: ImportSourceRow; taskId: string }> {
  const source = input.source.trim().toLowerCase().replace(/\s+/g, '-');
  if (!/^[a-z0-9._-]{2,80}$/.test(source)) {
    throw new Error('source tag must be 2-80 chars of letters/digits/._-');
  }

  const result = await db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`assistant:import-source:${source}`}))`,
    );
    const [existing] = await tx
      .select()
      .from(importSources)
      .where(eq(importSources.source, source))
      .for('update');
    if (existing?.status === 'running' || existing?.status === 'pending') {
      throw new Error(`import "${source}" is already ${existing.status}`);
    }

    const [sourceRow] = existing
      ? await tx
          .update(importSources)
          .set({
            workspacePath: input.workspacePath,
            kind: input.kind,
            status: 'pending',
            itemsProcessed: 0,
            memoriesSaved: 0,
            memoriesQuarantined: 0,
            error: null,
            updatedAt: sql`now()`,
          })
          .where(eq(importSources.id, existing.id))
          .returning()
      : await tx
          .insert(importSources)
          .values({
            agentId: input.agentId,
            source,
            workspacePath: input.workspacePath,
            kind: input.kind,
          })
          .returning();
    if (!sourceRow) throw new Error('import source upsert failed');

    const { task } = await enqueueTask(txDb, {
      event: {
        source: 'internal',
        agentId: input.agentId,
        trust: 'owner',
        payload: {
          job: 'import.run',
          source,
          path: input.workspacePath,
          kind: input.kind,
          ...(input.windowsPerRun ? { windowsPerRun: input.windowsPerRun } : {}),
          ...(input.windowChars ? { windowChars: input.windowChars } : {}),
        },
      },
      type: 'adhoc',
      budgetUsdLimit: input.budgetUsdLimit ?? DEFAULT_IMPORT_BUDGET_USD,
      deferNotification: true,
    });
    const [linkedSource] = await tx
      .update(importSources)
      .set({ taskId: task.id, updatedAt: sql`now()` })
      .where(eq(importSources.id, sourceRow.id))
      .returning();
    if (!linkedSource) throw new Error('failed to link import task');
    return { sourceRow: linkedSource, task };
  });

  getQueueNotifier().notify(result.task.id, result.task.queueGeneration);
  return { sourceRow: result.sourceRow, taskId: result.task.id };
}

/**
 * Purge-by-source: remove exactly this source's memories and nothing else.
 * The in-flight task (if any) is cancelled; the source row stays as a record.
 */
export async function purgeImportSource(db: Db, source: string): Promise<{ purged: number }> {
  const purged = await db.transaction(async (tx) => {
    const [sourceRow] = await tx
      .select()
      .from(importSources)
      .where(eq(importSources.source, source))
      .for('update');
    if (!sourceRow) throw new Error(`unknown import source: ${source}`);

    if (sourceRow.taskId) {
      await tx
        .update(tasks)
        .set({ status: 'cancelled', lockedUntil: null, runAfter: null, updatedAt: sql`now()` })
        .where(
          and(
            eq(tasks.id, sourceRow.taskId),
            inArray(tasks.status, ['pending', 'sleeping', 'running', 'needs_attention']),
          ),
        );
    }
    const deleted = await tx
      .delete(memories)
      .where(eq(memories.source, source))
      .returning({ id: memories.id });
    await tx
      .update(importSources)
      .set({
        status: 'purged',
        memoriesSaved: 0,
        memoriesQuarantined: 0,
        updatedAt: sql`now()`,
      })
      .where(eq(importSources.id, sourceRow.id));
    return deleted.length;
  });
  await compileOwnerCard(db).catch((err) => console.error('card recompile failed', err));
  return { purged };
}

/**
 * Delete an import source outright: cancel its task, remove its memories
 * (a delete implies a purge), remove the uploaded archive from the
 * workspace, and drop the source row — no purged/failed husk left behind.
 */
export async function deleteImportSource(
  db: Db,
  source: string,
  workspace?: { delete(relPath: string): Promise<void> },
): Promise<{ purgedMemories: number }> {
  const result = await db.transaction(async (tx) => {
    const [sourceRow] = await tx
      .select()
      .from(importSources)
      .where(eq(importSources.source, source))
      .for('update');
    if (!sourceRow) throw new Error(`unknown import source: ${source}`);

    if (sourceRow.taskId) {
      await tx
        .update(tasks)
        .set({ status: 'cancelled', lockedUntil: null, runAfter: null, updatedAt: sql`now()` })
        .where(
          and(
            eq(tasks.id, sourceRow.taskId),
            inArray(tasks.status, ['pending', 'sleeping', 'running', 'needs_attention']),
          ),
        );
    }
    const deleted = await tx
      .delete(memories)
      .where(eq(memories.source, source))
      .returning({ id: memories.id });
    await tx.delete(importSources).where(eq(importSources.id, sourceRow.id));
    return { sourceRow, purgedMemories: deleted.length };
  });
  if (workspace) {
    await workspace.delete(result.sourceRow.workspacePath).catch((err) => {
      console.error(`workspace delete failed for ${result.sourceRow.workspacePath}`, err);
    });
  }
  await compileOwnerCard(db).catch((err) => console.error('card recompile failed', err));
  return { purgedMemories: result.purgedMemories };
}

/**
 * Batch quarantine review by source: approve releases all quarantined facts
 * from this source; reject deletes them AND tombstones their hashes.
 */
export async function reviewImportSource(
  db: Db,
  source: string,
  verdict: 'approve' | 'reject',
): Promise<{ reviewed: number }> {
  const quarantined = await db
    .select({ id: memories.id, contentHash: memories.contentHash })
    .from(memories)
    .where(and(eq(memories.source, source), eq(memories.quarantined, true)));
  if (quarantined.length === 0) return { reviewed: 0 };

  if (verdict === 'approve') {
    await db
      .update(memories)
      .set({ quarantined: false })
      .where(and(eq(memories.source, source), eq(memories.quarantined, true)));
  } else {
    for (const row of quarantined) await addTombstone(db, row.contentHash, 'quarantine_reject');
    await db.delete(memories).where(
      inArray(
        memories.id,
        quarantined.map((r) => r.id),
      ),
    );
  }
  await db
    .update(importSources)
    .set({ memoriesQuarantined: 0, updatedAt: sql`now()` })
    .where(eq(importSources.source, source));
  await compileOwnerCard(db).catch((err) => console.error('card recompile failed', err));
  return { reviewed: quarantined.length };
}
