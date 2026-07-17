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
import type { ModelRouter } from '../model-router/router.js';
import { withSpan } from '../otel.js';
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
 * Tiering by design: only the distilled FACTS are embedded and stored — raw
 * bodies never leave the archive file. Facts about third parties land
 * quarantined until profile review; facts about the owner are trusted
 * (origin_trust 'owner', it's the owner's own archive). Confidence scales
 * down with source age.
 */

/** Minimal structural view of the workspace store (defined in @assistant/tools — no cycle). */
export interface WorkspaceReader {
  read(relPath: string): Promise<string>;
  list(relPath: string): Promise<Array<{ name: string; dir: boolean }>>;
}

const ImportFactsSchema = z.object({ facts: z.array(ExtractedFactSchema).max(20) });

const WINDOWS_PER_RUN = 6; // checkpoint granularity: one run ≈ one queue lease
const RESUME_DELAY_MS = 5_000;
const BUDGET_RETRY_DELAY_MS = 6 * 3600 * 1000;

interface ImportCursor {
  windowIndex: number;
  saved: number;
  duplicates: number;
  tombstoned: number;
  quarantined: number;
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
  return {
    job: String(payload.job),
    source,
    path,
    kind,
    windowsPerRun: typeof payload.windowsPerRun === 'number' ? payload.windowsPerRun : undefined,
    windowChars: typeof payload.windowChars === 'number' ? payload.windowChars : undefined,
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
  deps: { db: Db; router: ModelRouter; workspace?: WorkspaceReader },
  task: TaskRow,
): Promise<ImportRunResult> {
  const { db, router, workspace } = deps;
  if (!workspace) throw new Error('import job needs a workspace store (executor deps)');
  const payload = importPayload(task);

  return withSpan('memory.import', { source: payload.source }, async () => {
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

    const content = await workspace.read(payload.path);
    const units = parseArchive(payload.kind, content);
    const windows = windowUnits(units, payload.windowChars);

    await db
      .update(importSources)
      .set({
        status: 'running',
        taskId: task.id,
        itemsTotal: windows.length,
        updatedAt: sql`now()`,
      })
      .where(eq(importSources.id, sourceRow.id));

    const checkpoint = async () => {
      plannerState.import = cursor;
      state.plannerState = plannerState;
      await db
        .update(tasks)
        .set({
          state,
          progress: `import ${payload.source}: window ${cursor.windowIndex}/${windows.length}, ${cursor.saved} memories`,
          progressPercent: windows.length
            ? Math.min(100, Math.round((cursor.windowIndex / windows.length) * 100))
            : 100,
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
    const stopAt = Math.min(cursor.windowIndex + perRun, windows.length);

    while (cursor.windowIndex < stopAt) {
      const window = windows[cursor.windowIndex];
      if (!window) break;
      const period = window.date ? window.date.toISOString().slice(0, 10) : 'unknown';

      const outcome = await router.object<z.infer<typeof ImportFactsSchema>>('extract', {
        taskId: task.id,
        schema: ImportFactsSchema,
        system: importSystem(payload.source, period),
        prompt: window.text,
      });
      if (!outcome.ok) {
        // budget guard said stop — checkpoint and come back later, never lose progress
        await checkpoint();
        return {
          done: false,
          runAfter: new Date(Date.now() + BUDGET_RETRY_DELAY_MS),
          summary: `import ${payload.source}: paused by budget at window ${cursor.windowIndex}/${windows.length} (${outcome.decision.reason})`,
        };
      }

      const facts = outcome.object.facts;
      if (facts.length > 0) {
        const embeddings = await router.embed(
          facts.map((f) => f.content),
          { taskId: task.id },
        );
        for (let i = 0; i < facts.length; i++) {
          const fact = facts[i];
          const embedding = embeddings[i];
          if (!fact || !embedding) continue;

          const contentHash = createHash('sha256').update(fact.content).digest('hex');
          if (await isTombstoned(db, contentHash)) {
            cursor.tombstoned += 1;
            continue;
          }
          const resolved = await resolveSubjectContact(db, {
            subject: fact.subject,
            relationship: fact.relationship,
          });
          // Owner's own archive → origin 'owner'; but facts ABOUT third parties
          // wait in quarantine until profile review.
          const aboutOwner = fact.subject.trim().toLowerCase() === 'owner';
          const confidence = ageScaledConfidence(fact.confidence, window.date);

          const [row] = await db
            .insert(memories)
            .values({
              agentId: task.agentId,
              // Archives are biography: everything worth importing is durable
              // knowledge. 'experience' is the assistant's own expiring work
              // tier — imported life facts must never expire out of the profile.
              category: 'knowledge',
              kind: fact.kind,
              content: fact.content,
              contentHash,
              embedding,
              // Archive facts are recall-tier: cap importance so imported
              // material never auto-fills the owner card (importance >= 4).
              // The card is for pinned facts and high-importance LIVED facts.
              importance: Math.min(fact.importance, 3),
              confidence: confidence.toFixed(2),
              originTrust: 'owner',
              quarantined: !aboutOwner,
              subjectContactId: resolved?.contactId,
              domain: fact.domain,
              validFrom: parseValidFrom(fact.validFrom) ?? window.date ?? undefined,
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
      }

      cursor.windowIndex += 1;
      await checkpoint();
    }

    if (cursor.windowIndex >= windows.length) {
      await db
        .update(importSources)
        .set({ status: 'done', error: null, updatedAt: sql`now()` })
        .where(eq(importSources.id, sourceRow.id));
      // the profile card must reflect what was just learned
      await compileOwnerCard(db).catch((err) => console.error('card recompile failed', err));
      return {
        done: true,
        summary: `import ${payload.source}: complete — ${cursor.saved} memories (${cursor.quarantined} quarantined for review), ${cursor.duplicates} duplicates, ${cursor.tombstoned} tombstoned, ${windows.length} windows`,
      };
    }
    return {
      done: false,
      runAfter: new Date(Date.now() + RESUME_DELAY_MS),
      summary: `import ${payload.source}: ${cursor.windowIndex}/${windows.length} windows`,
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

  const [existing] = await db.select().from(importSources).where(eq(importSources.source, source));
  if (existing?.status === 'running' || existing?.status === 'pending') {
    throw new Error(`import "${source}" is already ${existing.status}`);
  }

  const [sourceRow] = existing
    ? await db
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
    : await db
        .insert(importSources)
        .values({
          agentId: input.agentId,
          source,
          workspacePath: input.workspacePath,
          kind: input.kind,
        })
        .returning();
  if (!sourceRow) throw new Error('import source upsert failed');

  const { task } = await enqueueTask(db, {
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
  });
  await db
    .update(importSources)
    .set({ taskId: task.id, updatedAt: sql`now()` })
    .where(eq(importSources.id, sourceRow.id));
  return { sourceRow, taskId: task.id };
}

/**
 * Purge-by-source: remove exactly this source's memories and nothing else.
 * The in-flight task (if any) is cancelled; the source row stays as a record.
 */
export async function purgeImportSource(db: Db, source: string): Promise<{ purged: number }> {
  const [sourceRow] = await db.select().from(importSources).where(eq(importSources.source, source));
  if (!sourceRow) throw new Error(`unknown import source: ${source}`);

  if (sourceRow.taskId) {
    await db
      .update(tasks)
      .set({ status: 'cancelled', updatedAt: sql`now()` })
      .where(
        and(
          eq(tasks.id, sourceRow.taskId),
          inArray(tasks.status, ['pending', 'sleeping', 'running', 'needs_attention']),
        ),
      );
  }
  const deleted = await db
    .delete(memories)
    .where(eq(memories.source, source))
    .returning({ id: memories.id });
  await db
    .update(importSources)
    .set({
      status: 'purged',
      memoriesSaved: 0,
      memoriesQuarantined: 0,
      updatedAt: sql`now()`,
    })
    .where(eq(importSources.id, sourceRow.id));
  await compileOwnerCard(db).catch((err) => console.error('card recompile failed', err));
  return { purged: deleted.length };
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
  const [sourceRow] = await db.select().from(importSources).where(eq(importSources.source, source));
  if (!sourceRow) throw new Error(`unknown import source: ${source}`);

  if (sourceRow.taskId) {
    await db
      .update(tasks)
      .set({ status: 'cancelled', updatedAt: sql`now()` })
      .where(
        and(
          eq(tasks.id, sourceRow.taskId),
          inArray(tasks.status, ['pending', 'sleeping', 'running', 'needs_attention']),
        ),
      );
  }
  const deleted = await db
    .delete(memories)
    .where(eq(memories.source, source))
    .returning({ id: memories.id });
  if (workspace) {
    await workspace.delete(sourceRow.workspacePath).catch((err) => {
      console.error(`workspace delete failed for ${sourceRow.workspacePath}`, err);
    });
  }
  await db.delete(importSources).where(eq(importSources.id, sourceRow.id));
  await compileOwnerCard(db).catch((err) => console.error('card recompile failed', err));
  return { purgedMemories: deleted.length };
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
