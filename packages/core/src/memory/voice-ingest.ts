import {
  contacts,
  type Db,
  type ImportSourceRow,
  importSources,
  type TaskRow,
  tasks,
  writingSamples,
} from '@assistant/db';
import { and, eq, inArray, like, or, sql } from 'drizzle-orm';
import { loadConfig } from '../config.js';
import { BudgetReservationError } from '../cost.js';
import { quotesExternalContent } from '../email-provenance.js';
import type { ModelRouter } from '../model-router/router.js';
import { withSpan } from '../otel.js';
import { getQueueNotifier } from '../queue.js';
import type { VoiceRegister } from '../voice.js';
import { enqueueTask } from '../workflow/machine.js';
import type { WorkspaceReader } from './import.js';
import { type ImportKind, parseArchive } from './import-parsers.js';

/**
 * Owner voice-sample bootstrap (Phase 5). The outbound voice-rewrite pipeline
 * (`voice.ts`) already runs off an honest baseline profile plus opportunistic
 * sampling of the owner's authenticated inbound mail. This job lets the owner
 * seed real samples in one batch: they upload an archive of their OWN sent mail
 * (a Gmail Takeout `.mbox`, or a text/json export) through the same upload flow
 * as backstory import, and each message they actually authored becomes a
 * `writing_samples` row with an embedding.
 *
 * Only the owner's own words enter the private voice corpus: a message the
 * owner did not author (a full-mailbox export mixes in received mail) is
 * skipped, and any message that forwards or quotes someone else's text is
 * skipped whole — the same fail-closed rule `email-sync` uses for opportunistic
 * capture. Uploaded rows carry an `upload:` context so they are distinguishable
 * from auto-captured (`auto:`) and seed-script rows, and the Profile purge can
 * clear exactly the auto + uploaded set without touching seed samples.
 */

/** writing_samples.context prefix for rows seeded from an owner upload. */
export const UPLOAD_SAMPLE_PREFIX = 'upload:';
/** import_sources.source prefix that marks a row as a voice-sample import. */
export const VOICE_IMPORT_SOURCE_PREFIX = 'voice-samples';

const MIN_UPLOAD_SAMPLE_CHARS = 40;
const MAX_UPLOAD_SAMPLE_CHARS = 4000;
const SAMPLES_PER_RUN = 40; // one lease's worth; well under the router's 100/embed-batch cap
const MAX_UPLOAD_SAMPLES = 500; // plenty for nearest-5 retrieval; bounds cost and runtime
const RESUME_DELAY_MS = 3_000;
const DEFAULT_VOICE_INGEST_BUDGET_USD = '0.50';

/** Registers the seed script and this job agree on, from a file-name prefix. */
export function registerForFilename(filename: string): VoiceRegister {
  const f = filename.toLowerCase();
  if (f.startsWith('sms')) return 'sms';
  if (f.startsWith('chat')) return 'chat';
  if (f.startsWith('email-pro') || f.includes('professional')) return 'email_professional';
  return 'email_casual';
}

/** True for an import_sources row that feeds the voice corpus, not memory. */
export function isVoiceImportSource(source: string): boolean {
  return source.startsWith(VOICE_IMPORT_SOURCE_PREFIX);
}

const VALID_REGISTERS: ReadonlySet<string> = new Set([
  'email_professional',
  'email_casual',
  'sms',
  'chat',
]);

export function isVoiceRegister(value: unknown): value is VoiceRegister {
  return typeof value === 'string' && VALID_REGISTERS.has(value);
}

/** Split the "From X — Subject: Y" header parsers build back into its parts. */
function splitUnitHeader(header: string): { from: string; subject: string } {
  const from = header.match(/^From (.*?)(?: — Subject:|$)/)?.[1]?.trim() ?? '';
  const subject = header.match(/Subject:\s*(.*)$/)?.[1]?.trim() ?? '';
  return { from, subject };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A predicate that recognises the owner as a message's author. Emails match as
 * a substring of the raw From value ("Name <addr>"); names/aliases match on a
 * word boundary so a short first name cannot match inside an unrelated address.
 */
export function ownerAuthoredMatcher(identity: {
  emails: string[];
  names: string[];
}): (from: string) => boolean {
  const emails = identity.emails.map((e) => e.toLowerCase().trim()).filter(Boolean);
  const names = identity.names.map((n) => n.toLowerCase().trim()).filter((n) => n.length >= 3);
  const namePatterns = names.map((n) => new RegExp(`\\b${escapeRegExp(n)}\\b`));
  return (from: string) => {
    const f = from.toLowerCase();
    if (emails.some((e) => f.includes(e))) return true;
    return namePatterns.some((pattern) => pattern.test(f));
  };
}

/** Build the owner matcher from the owner contact, falling back to config. */
async function loadOwnerIdentity(db: Db): Promise<(from: string) => boolean> {
  const [owner] = await db.select().from(contacts).where(eq(contacts.trust, 'owner')).limit(1);
  const configEmail = loadConfig().OWNER_EMAIL;
  const emails = [...(owner?.emails ?? []), configEmail].filter(Boolean);
  const names = [owner?.name ?? '', ...(owner?.aliases ?? [])].filter(Boolean);
  return ownerAuthoredMatcher({ emails, names });
}

/**
 * Parse an archive and keep only the owner's own, non-quoting messages as
 * deduped sample texts, in file order. A unit with a `From` header that is not
 * the owner is dropped (received mail in a full-mailbox export); a unit that
 * forwards or quotes external content is dropped whole. Units with no author
 * header (a plain-text writing corpus) are treated as the owner's own words.
 */
export function extractOwnerSamples(
  kind: ImportKind,
  content: string,
  isOwnerAuthored: (from: string) => boolean,
): string[] {
  const seen = new Set<string>();
  const samples: string[] = [];
  for (const unit of parseArchive(kind, content)) {
    const { from, subject } = splitUnitHeader(unit.header);
    if (from && !isOwnerAuthored(from)) continue;
    if (quotesExternalContent({ subject, body: unit.text })) continue;
    const text = unit.text.trim();
    if (text.length < MIN_UPLOAD_SAMPLE_CHARS || text.length > MAX_UPLOAD_SAMPLE_CHARS) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    samples.push(text);
  }
  return samples;
}

interface VoiceIngestPayload {
  source: string;
  path: string;
  kind: ImportKind;
  register: VoiceRegister;
}

function voiceIngestPayload(task: TaskRow): VoiceIngestPayload {
  const payload = (task.trigger as { payload?: Record<string, unknown> })?.payload ?? {};
  const source = String(payload.source ?? '');
  const path = String(payload.path ?? '');
  const kind = String(payload.kind ?? 'text') as ImportKind;
  const register = payload.register;
  if (!source || !path) throw new Error('voice ingest payload needs source and path');
  if (kind !== 'mbox' && kind !== 'json' && kind !== 'text') {
    throw new Error(`unsupported voice ingest kind: ${kind}`);
  }
  if (!isVoiceRegister(register)) throw new Error(`voice ingest payload has no valid register`);
  return { source, path, kind, register };
}

interface VoiceIngestCursor {
  index: number;
  saved: number;
  duplicates: number;
}

export interface VoiceIngestOutcome {
  done: boolean;
  runAfter?: Date;
  summary: string;
}

/**
 * Code job: parse the uploaded archive, embed the owner's own messages, and
 * insert them as writing samples. Resumable — the cursor checkpoints into
 * tasks.state after every batch, dedupe-by-text makes a replayed batch a no-op,
 * and the archive re-parses deterministically on each lease.
 */
export async function runVoiceIngest(
  deps: {
    db: Db;
    router: ModelRouter;
    workspace?: WorkspaceReader;
    heartbeat?: () => Promise<void>;
  },
  task: TaskRow,
): Promise<VoiceIngestOutcome> {
  const { db, router, workspace } = deps;
  if (!workspace) throw new Error('voice ingest needs a workspace store (executor deps)');
  const payload = voiceIngestPayload(task);

  return withSpan('voice.ingest', { source: payload.source }, async () => {
    await deps.heartbeat?.();
    const [sourceRow] = await db
      .select()
      .from(importSources)
      .where(eq(importSources.source, payload.source));
    if (!sourceRow) throw new Error(`unknown voice import source: ${payload.source}`);
    if (sourceRow.status === 'purged') {
      return { done: true, summary: `voice ingest ${payload.source}: purged — nothing to do` };
    }

    const isOwnerAuthored = await loadOwnerIdentity(db);
    const content = await workspace.read(payload.path);
    const allSamples = extractOwnerSamples(payload.kind, content, isOwnerAuthored);
    const capped = allSamples.length > MAX_UPLOAD_SAMPLES;
    const candidates = capped ? allSamples.slice(0, MAX_UPLOAD_SAMPLES) : allSamples;
    await deps.heartbeat?.();

    const state = (task.state ?? {}) as Record<string, unknown>;
    const plannerState = (state.plannerState ?? {}) as Record<string, unknown>;
    const cursor: VoiceIngestCursor = {
      index: 0,
      saved: 0,
      duplicates: 0,
      ...((plannerState.voiceIngest as Partial<VoiceIngestCursor>) ?? {}),
    };

    await db
      .update(importSources)
      .set({
        status: 'running',
        taskId: task.id,
        itemsTotal: candidates.length,
        updatedAt: sql`now()`,
      })
      .where(eq(importSources.id, sourceRow.id));

    const checkpoint = async () => {
      await deps.heartbeat?.();
      plannerState.voiceIngest = cursor;
      state.plannerState = plannerState;
      await db
        .update(tasks)
        .set({
          state,
          progress: `voice ingest ${payload.source}: ${cursor.index}/${candidates.length}, ${cursor.saved} samples`,
          progressPercent: candidates.length
            ? Math.min(100, Math.round((cursor.index / candidates.length) * 100))
            : 100,
          reclaimCount: 0,
          updatedAt: sql`now()`,
        })
        .where(eq(tasks.id, task.id));
      await db
        .update(importSources)
        .set({
          itemsProcessed: cursor.index,
          memoriesSaved: cursor.saved,
          updatedAt: sql`now()`,
        })
        .where(eq(importSources.id, sourceRow.id));
    };

    const stopAt = Math.min(cursor.index + SAMPLES_PER_RUN, candidates.length);
    while (cursor.index < stopAt) {
      const batch = candidates.slice(cursor.index, stopAt);
      // Skip texts already stored (a prior run, an overlapping re-upload, or a
      // sample auto-captured from the same message) — writing_samples has no
      // unique text index, so dedupe explicitly before embedding.
      const existing = new Set(
        (
          await db
            .select({ text: writingSamples.text })
            .from(writingSamples)
            .where(inArray(writingSamples.text, batch))
        ).map((r) => r.text),
      );
      const fresh = batch.filter((text) => !existing.has(text));
      cursor.duplicates += batch.length - fresh.length;

      if (fresh.length > 0) {
        let embeddings: number[][];
        try {
          embeddings = await router.embed(fresh, { taskId: task.id });
        } catch (err) {
          // A budget stop never resets on its own — mark the source failed
          // (re-runnable) and surface it as needs_attention, mirroring import.
          if (err instanceof BudgetReservationError) {
            await checkpoint();
            await db
              .update(importSources)
              .set({ status: 'failed', error: err.message.slice(0, 2000), updatedAt: sql`now()` })
              .where(eq(importSources.id, sourceRow.id));
          }
          throw err;
        }
        await deps.heartbeat?.();
        await db.insert(writingSamples).values(
          fresh.map((text, i) => ({
            register: payload.register,
            text,
            context: `${UPLOAD_SAMPLE_PREFIX}${payload.source}`,
            embedding: embeddings[i],
          })),
        );
        cursor.saved += fresh.length;
      }
      cursor.index = stopAt;
      await checkpoint();
    }

    if (cursor.index >= candidates.length) {
      await db
        .update(importSources)
        .set({ status: 'done', error: null, updatedAt: sql`now()` })
        .where(eq(importSources.id, sourceRow.id));
      const capNote = capped
        ? ` (${allSamples.length - MAX_UPLOAD_SAMPLES} over the cap skipped)`
        : '';
      return {
        done: true,
        summary: `voice ingest ${payload.source}: complete — ${cursor.saved} samples (${cursor.duplicates} duplicates)${capNote}`,
      };
    }
    return {
      done: false,
      runAfter: new Date(Date.now() + RESUME_DELAY_MS),
      summary: `voice ingest ${payload.source}: ${cursor.index}/${candidates.length} messages`,
    };
  });
}

// ── Lifecycle (dashboard entry points) ───────────────────────────────────────

/** Normalise an owner label into a valid, voice-prefixed import source tag. */
export function voiceImportSourceTag(label: string): string {
  const cleaned = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(new RegExp(`^${VOICE_IMPORT_SOURCE_PREFIX}-?`), '');
  const suffix = cleaned ? `-${cleaned}` : '';
  return `${VOICE_IMPORT_SOURCE_PREFIX}${suffix}`.slice(0, 80);
}

/**
 * Register (or re-run) a voice-sample import and enqueue its resumable job.
 * Mirrors startImport but tags the source for the voice corpus and carries the
 * chosen register in the job payload.
 */
export async function startVoiceIngest(
  db: Db,
  input: {
    agentId: string;
    source: string;
    workspacePath: string;
    kind: ImportKind;
    register: VoiceRegister;
    budgetUsdLimit?: string;
  },
): Promise<{ sourceRow: ImportSourceRow; taskId: string }> {
  const source = voiceImportSourceTag(input.source);
  if (!/^[a-z0-9._-]{2,80}$/.test(source)) {
    throw new Error('voice import source tag is invalid');
  }
  if (!isVoiceRegister(input.register)) throw new Error('voice import needs a valid register');

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
      throw new Error(`voice import "${source}" is already ${existing.status}`);
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
    if (!sourceRow) throw new Error('voice import source upsert failed');

    const { task } = await enqueueTask(txDb, {
      event: {
        source: 'internal',
        agentId: input.agentId,
        trust: 'owner',
        payload: {
          job: 'voice.ingest',
          source,
          path: input.workspacePath,
          kind: input.kind,
          register: input.register,
        },
      },
      type: 'adhoc',
      budgetUsdLimit: input.budgetUsdLimit ?? DEFAULT_VOICE_INGEST_BUDGET_USD,
      deferNotification: true,
    });
    const [linked] = await tx
      .update(importSources)
      .set({ taskId: task.id, updatedAt: sql`now()` })
      .where(eq(importSources.id, sourceRow.id))
      .returning();
    if (!linked) throw new Error('failed to link voice import task');
    return { sourceRow: linked, task };
  });

  getQueueNotifier().notify(result.task.id, result.task.queueGeneration);
  return { sourceRow: result.sourceRow, taskId: result.task.id };
}

export interface VoiceSampleStats {
  total: number;
  auto: number;
  uploaded: number;
}

/** Counts for the Profile page: total corpus, plus the purgeable auto+uploaded subset. */
export async function voiceSampleStats(db: Db): Promise<VoiceSampleStats> {
  const [row] = await db
    .select({
      total: sql<number>`count(*)`,
      auto: sql<number>`count(*) filter (where ${writingSamples.context} like 'auto:%')`,
      uploaded: sql<number>`count(*) filter (where ${writingSamples.context} like ${`${UPLOAD_SAMPLE_PREFIX}%`})`,
    })
    .from(writingSamples);
  return {
    total: Number(row?.total ?? 0),
    auto: Number(row?.auto ?? 0),
    uploaded: Number(row?.uploaded ?? 0),
  };
}

/**
 * Purge the auto-captured and uploaded voice samples, leaving seed-script
 * samples (raw file-name context) and the distilled voice profile untouched.
 * Also clears the voice import_sources husks and cancels any in-flight ingest.
 */
export async function purgeVoiceSamples(
  db: Db,
  workspace?: { delete(relPath: string): Promise<void> },
): Promise<{ deleted: number }> {
  const purgeable = or(
    like(writingSamples.context, 'auto:%'),
    like(writingSamples.context, `${UPLOAD_SAMPLE_PREFIX}%`),
  );
  const voiceSources = await db
    .select()
    .from(importSources)
    .where(like(importSources.source, `${VOICE_IMPORT_SOURCE_PREFIX}%`));

  const result = await db.transaction(async (tx) => {
    const cancelledTaskIds = voiceSources.map((s) => s.taskId).filter((id): id is string => !!id);
    if (cancelledTaskIds.length > 0) {
      await tx
        .update(tasks)
        .set({ status: 'cancelled', lockedUntil: null, runAfter: null, updatedAt: sql`now()` })
        .where(
          and(
            inArray(tasks.id, cancelledTaskIds),
            inArray(tasks.status, ['pending', 'sleeping', 'running', 'needs_attention']),
          ),
        );
    }
    const deleted = await tx.delete(writingSamples).where(purgeable).returning({
      id: writingSamples.id,
    });
    if (voiceSources.length > 0) {
      await tx.delete(importSources).where(
        inArray(
          importSources.id,
          voiceSources.map((s) => s.id),
        ),
      );
    }
    return deleted.length;
  });

  if (workspace) {
    for (const source of voiceSources) {
      await workspace.delete(source.workspacePath).catch((err) => {
        console.error(`voice purge: workspace delete failed for ${source.workspacePath}`, err);
      });
    }
  }
  return { deleted: result };
}
