import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { type Db, documents, files, type TaskRow } from '@assistant/db';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { hashCallbackToken } from '../browse.js';
import { withSpan } from '../otel.js';
import { getQueueNotifier } from '../queue.js';
import { enqueueTask } from '../workflow/machine.js';
import type { CodeJobOutcome } from './jobs.js';

/**
 * The document-processor worker (Phase 14) — a third credential-free Cloud Run
 * Job. Heavy formats (office documents, images, scanned PDFs) are parked by
 * document ingest with `extractor='pending_processor'`; the agent container
 * never loads their parsers. This module launches the out-of-process worker,
 * which reads the bytes from the Workspace, extracts plain text (OCR / office
 * parsing), uploads the text to the Workspace, and calls back over a single
 * HTTP request authenticated by a one-shot token.
 *
 * Unlike the code/browser jobs — launched from a tool with a task `pendingJob`
 * slot — document processing is a background pipeline with no model loop. The
 * one-shot token therefore lives on the `documents` row itself, so the worker
 * needs no task context and the callback re-enters the existing
 * `documents.extract` chunk+embed pipeline (see runDocumentExtraction) rather
 * than embedding inside the HTTP handler. The worker stays DB-free and
 * key-free: it only ever handles bytes in and text out.
 */

const PROCESS_BATCH = 5; // documents launched per sweep tick
const STALE_MS = 15 * 60 * 1000; // relaunch a run that never called back
const CALLBACK_GRACE_SECONDS = 600; // Cloud Run task-timeout ceiling for the worker

/** Deterministic Workspace path for a document's extracted text. The callback
 *  derives this itself — it never trusts a path the worker reports. */
export function extractedTextPath(documentId: string): string {
  return `documents/${documentId}/extracted.txt`;
}

// ── Launcher (mirrors the code job's Local/CloudRun pair) ─────────────────────

/** How the worker finds Workspace storage. Credential-free: GCS rides the
 *  runtime service account (prod) or the local filesystem (dev). */
export interface DocumentJobStorage {
  driver: 'gcs' | 'local';
  bucket?: string;
  prefix?: string;
  root?: string;
}

export interface DocumentJobLaunchInput {
  documentId: string;
  source: { workspacePath: string; mime: string; title: string; extractor: string };
  /** Where the worker uploads the extracted text (relative to the Workspace prefix). */
  outputPath: string;
  callbackUrl: string;
  callbackToken: string;
}

export interface DocumentProcessorLauncher {
  launch(input: DocumentJobLaunchInput): Promise<{ executionName?: string }>;
}

/** The Cloud Run `:run` POST may have reached Google even though its response
 *  did not reach us; relaunching could start a second run, so the sweep keeps
 *  its already-staged token instead of relaunching. */
export class AmbiguousDocumentJobLaunchError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AmbiguousDocumentJobLaunchError';
  }
}

export function isAmbiguousDocumentJobLaunchError(
  error: unknown,
): error is AmbiguousDocumentJobLaunchError {
  return error instanceof AmbiguousDocumentJobLaunchError;
}

/** Dev: run the worker as a detached child process against the local workspace. */
export class LocalDocumentProcessLauncher implements DocumentProcessorLauncher {
  constructor(private opts: { repoRoot: string; workspaceRoot: string }) {}

  async launch(input: DocumentJobLaunchInput): Promise<{ executionName?: string }> {
    const jobInput = {
      ...input,
      storage: { driver: 'local', root: this.opts.workspaceRoot } satisfies DocumentJobStorage,
    };
    const inherited = Object.fromEntries(
      ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL', 'PNPM_HOME', 'COREPACK_HOME']
        .map((key) => [key, process.env[key]])
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
    const child = spawn('pnpm', ['--filter', '@assistant/document-processor', 'start'], {
      cwd: this.opts.repoRoot,
      env: {
        ...inherited,
        NODE_ENV: 'production',
        DOCUMENT_JOB_INPUT: JSON.stringify(jobInput),
      },
      stdio: 'ignore',
      detached: true,
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.unref();
    return { executionName: `local-pid-${child.pid}` };
  }
}

/** Prod: execute the Cloud Run Job with per-run env overrides (metadata-server auth, no SDK). */
export class CloudRunDocumentJobLauncher implements DocumentProcessorLauncher {
  constructor(
    private opts: {
      project: string;
      location: string;
      jobName: string;
      storage: DocumentJobStorage;
    },
  ) {}

  private async token(): Promise<string> {
    const res = await fetch(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(5_000) },
    );
    if (!res.ok) throw new Error(`metadata token fetch failed: ${res.status}`);
    return ((await res.json()) as { access_token: string }).access_token;
  }

  async launch(input: DocumentJobLaunchInput): Promise<{ executionName?: string }> {
    const jobInput = { ...input, storage: this.opts.storage };
    const url = `https://run.googleapis.com/v2/projects/${this.opts.project}/locations/${this.opts.location}/jobs/${this.opts.jobName}:run`;
    const token = await this.token();
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          overrides: {
            containerOverrides: [
              { env: [{ name: 'DOCUMENT_JOB_INPUT', value: JSON.stringify(jobInput) }] },
            ],
            timeout: `${CALLBACK_GRACE_SECONDS}s`,
          },
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new AmbiguousDocumentJobLaunchError(
        `cloud run document job launch response was not received: ${String(error)}`,
        { cause: error },
      );
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => 'response body unavailable');
      if (res.status >= 500 || res.status === 408) {
        throw new AmbiguousDocumentJobLaunchError(
          `cloud run document job launch outcome is unknown: ${res.status} ${detail}`,
        );
      }
      throw new Error(`cloud run document job launch failed: ${res.status} ${detail}`);
    }
    let op: { metadata?: { name?: string } };
    try {
      op = (await res.json()) as { metadata?: { name?: string } };
    } catch (error) {
      throw new AmbiguousDocumentJobLaunchError(
        'cloud run accepted the document job launch but returned an unreadable operation response',
        { cause: error },
      );
    }
    return { executionName: op.metadata?.name };
  }
}

// ── Sweep code job: launch the worker for pending documents ───────────────────

export interface DocumentProcessorConfig {
  launcher: DocumentProcessorLauncher;
  /** POST target for the worker's one-shot-token result callback. */
  callbackUrl: string;
}

export interface DocumentProcessDeps {
  db: Db;
  documentProcessor?: DocumentProcessorConfig;
  now?: () => Date;
  heartbeat?: () => Promise<void>;
}

/**
 * Code job `documents.process`. With a `documentId` payload it targets one
 * freshly-ingested document; without one it sweeps every heavy-format document
 * whose processor run is missing or stale (the retry backstop). Each launch is
 * an atomic claim: the token hash + start time are written only if the row is
 * still unclaimed/stale, so two overlapping sweeps never double-launch.
 *
 * A no-op — returning "not configured" — when no processor launcher is wired.
 * That is how the feature stays inert in production until the Cloud Run Job is
 * deployed and `PROCESSOR_DRIVER=cloudrun` is set: parked documents simply wait.
 */
export async function runDocumentProcessing(
  deps: DocumentProcessDeps,
  task: TaskRow,
): Promise<CodeJobOutcome> {
  const processor = deps.documentProcessor;
  if (!processor) {
    return {
      done: true,
      summary: 'document processor not configured — pending documents left as-is',
    };
  }
  const now = deps.now?.() ?? new Date();
  const db = deps.db;
  const payload = (task.trigger as { payload?: { documentId?: unknown } } | null)?.payload;
  const documentId = typeof payload?.documentId === 'string' ? payload.documentId : null;

  return withSpan('documents.process', { documentId: documentId ?? 'sweep' }, async () => {
    await deps.heartbeat?.();
    const staleCutoff = new Date(now.getTime() - STALE_MS);
    const claimable = or(
      isNull(documents.processorStartedAt),
      lt(documents.processorStartedAt, staleCutoff),
    );
    const rows = await db
      .select({
        id: documents.id,
        title: documents.title,
        mime: documents.mime,
        extractor: documents.extractor,
        workspacePath: files.workspacePath,
      })
      .from(documents)
      .innerJoin(files, eq(files.id, documents.fileId))
      .where(
        and(
          eq(documents.extractor, 'pending_processor'),
          eq(documents.status, 'pending'),
          claimable,
          ...(documentId ? [eq(documents.id, documentId)] : []),
        ),
      )
      .limit(documentId ? 1 : PROCESS_BATCH);

    let launched = 0;
    let skipped = 0;
    for (const row of rows) {
      await deps.heartbeat?.();
      const callbackToken = randomBytes(24).toString('hex');
      // Atomic claim: only take the row if it is still unclaimed/stale.
      const [claimed] = await db
        .update(documents)
        .set({
          processorTokenHash: hashCallbackToken(callbackToken),
          processorStartedAt: now,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(documents.id, row.id),
            eq(documents.extractor, 'pending_processor'),
            eq(documents.status, 'pending'),
            claimable,
          ),
        )
        .returning({ id: documents.id });
      if (!claimed) {
        skipped++;
        continue;
      }

      try {
        const { executionName } = await processor.launcher.launch({
          documentId: row.id,
          source: {
            workspacePath: row.workspacePath,
            mime: row.mime,
            title: row.title,
            extractor: row.extractor,
          },
          outputPath: extractedTextPath(row.id),
          callbackUrl: processor.callbackUrl,
          callbackToken,
        });
        void executionName;
        launched++;
      } catch (error) {
        if (isAmbiguousDocumentJobLaunchError(error)) {
          // The run may have started; keep the claim and wait for its callback
          // or the staleness relaunch. Never issue a second launch now.
          launched++;
          continue;
        }
        // A definite launch failure: release the claim so the next sweep retries.
        await db
          .update(documents)
          .set({ processorTokenHash: null, processorStartedAt: null, updatedAt: sql`now()` })
          .where(eq(documents.id, row.id));
        console.error(`document processor launch failed for ${row.id}`, error);
      }
    }

    return {
      done: true,
      summary: `document processor: ${launched} launched${skipped ? `, ${skipped} already in flight` : ''}`,
    };
  });
}

// ── One-shot callback ─────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function tokensMatch(expected: string, given: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface DocumentProcessorResult {
  ok: boolean;
  /** 'text' on success, or 'unsupported' when the worker could not parse the format. */
  kind?: string;
  chars?: number;
  error?: string;
}

export type DocumentProcessorCallbackOutcome =
  | { ok: true; documentId: string; enqueued: boolean }
  | { ok: false; status: 400 | 403 | 404 | 409; error: string };

/**
 * The worker's one-shot callback. Verify the launch token against the document
 * row's checkpoint, then either hand the extracted text to the chunk+embed
 * pipeline (success) or mark the document unsupported/failed. The token is
 * cleared here, so a replayed callback is rejected. Mirrors the code job's
 * recordCodeJobResult, but keyed on the document rather than a task pendingJob.
 */
export async function recordDocumentProcessorResult(
  db: Db,
  input: { documentId: string; token: string; result: DocumentProcessorResult },
): Promise<DocumentProcessorCallbackOutcome> {
  if (!input.documentId || !input.token) return { ok: false, status: 400, error: 'bad request' };
  if (!UUID_RE.test(input.documentId)) return { ok: false, status: 400, error: 'bad request' };

  const outcome = await db.transaction(async (tx): Promise<DocumentProcessorCallbackOutcome> => {
    const [doc] = await tx
      .select()
      .from(documents)
      .where(eq(documents.id, input.documentId))
      .for('update');
    if (!doc) return { ok: false, status: 404, error: 'document not found' };
    if (!doc.processorTokenHash) {
      return { ok: false, status: 409, error: 'no pending processor run' };
    }
    if (!tokensMatch(doc.processorTokenHash, hashCallbackToken(input.token))) {
      return { ok: false, status: 403, error: 'invalid token' };
    }

    if (input.result.ok) {
      // Success: point the extract pipeline at the worker's text blob and wake
      // it. The path is derived here — a worker-reported path is never trusted.
      await tx
        .update(documents)
        .set({
          processedTextPath: extractedTextPath(doc.id),
          processorTokenHash: null,
          error: null,
          updatedAt: sql`now()`,
        })
        .where(eq(documents.id, doc.id));
      return { ok: true, documentId: doc.id, enqueued: true };
    }

    const unsupported = input.result.kind === 'unsupported';
    await tx
      .update(documents)
      .set({
        status: unsupported ? 'unsupported' : 'failed',
        processorTokenHash: null,
        error: (
          input.result.error ?? (unsupported ? 'format not supported' : 'processing failed')
        ).slice(0, 2000),
        updatedAt: sql`now()`,
      })
      .where(eq(documents.id, doc.id));
    return { ok: true, documentId: doc.id, enqueued: false };
  });

  // Re-enter the existing resumable chunk+embed pipeline outside the txn.
  if (outcome.ok && outcome.enqueued) {
    const [doc] = await db.select().from(documents).where(eq(documents.id, outcome.documentId));
    if (doc) {
      const { task } = await enqueueTask(db, {
        event: {
          source: 'internal',
          agentId: doc.agentId,
          trust: 'assistant',
          payload: { job: 'documents.extract', documentId: doc.id },
        },
        type: 'adhoc',
        budgetUsdLimit: '0.50',
        deferNotification: true,
      });
      getQueueNotifier().notify(task.id, task.queueGeneration);
    }
  }
  return outcome;
}
