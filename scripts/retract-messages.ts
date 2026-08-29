/**
 * Retract specific assistant messages that were published without support,
 * and post one source-backed correction in their place.
 *
 * The rows are named by a manifest file rather than by constants in here: an
 * incident's message ids, the exact text being retracted, and the correction
 * to publish are one installation's private data, and do not belong in the
 * repository. Keep the manifest outside version control.
 *
 *   pnpm tsx scripts/retract-messages.ts --manifest=./incident.json
 *   pnpm tsx scripts/retract-messages.ts --manifest=./incident.json \
 *     --apply --production --incident=<repairId>
 *
 * Dry run by default. Applying writes a JSON backup of every row it will
 * touch first, then does the whole repair in one transaction that re-checks
 * the guards after taking its snapshot. Re-running an applied repair is a
 * no-op: each retraction records the repair id and a digest of the original
 * text, which is also what proves a second run is looking at the same rows.
 *
 * Manifest shape:
 * {
 *   "repairId": "2026-08-29-example-v1",
 *   "conversationId": "<uuid>",
 *   "messages": [
 *     { "id": "<uuid>", "taskId": "<uuid>",
 *       "sha256": "<digest of the message text being retracted>",
 *       "reason": "Why this response was not supported." }
 *   ],
 *   "correction": {
 *     "text": "What the sources actually say.",
 *     "recall": [{ "date": "...", "label": "...", "kind": "knowledge_graph", "hops": 1 }]
 *   }
 * }
 *
 * `sha256` is the guard that matters: it is checked before anything is
 * written, so a message edited or replaced since the manifest was reviewed
 * aborts the repair instead of being silently overwritten. Take each digest
 * from the row you actually inspected.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '@assistant/config';
import { createDb, type Db, messages, tasks } from '@assistant/db';
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

const UUID = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

export const RetractionManifestSchema = z.object({
  /** Stable id for this repair; recorded on every row it writes. */
  repairId: z.string().min(8).max(120),
  conversationId: UUID,
  messages: z
    .array(
      z.object({
        id: UUID,
        taskId: UUID,
        sha256: z.string().regex(/^[0-9a-f]{64}$/i),
        reason: z.string().min(10).max(500),
      }),
    )
    .min(1)
    .max(50),
  correction: z.object({
    text: z.string().min(20),
    recall: z
      .array(
        z.object({
          date: z.string().min(1),
          label: z.string().min(1),
          kind: z.enum(['chat', 'knowledge_graph']).optional(),
          hops: z.union([z.literal(1), z.literal(2)]).optional(),
        }),
      )
      .default([]),
  }),
});

export type RetractionManifest = z.infer<typeof RetractionManifestSchema>;

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function retractionText(reason: string): string {
  return `This response was retracted. ${reason} See the source-backed correction below.`;
}

function correctionChannelId(manifest: RetractionManifest): string {
  return `repair:${manifest.repairId}`;
}

function retractionPart(part: unknown): Record<string, unknown> | null {
  if (!part || typeof part !== 'object') return null;
  const value = part as Record<string, unknown>;
  return value.type === 'notice' && value.notice === 'retracted' ? value : null;
}

export async function inspectIncident(db: Db, manifest: RetractionManifest) {
  const ids = manifest.messages.map((message) => message.id);
  const taskIds = manifest.messages.map((message) => message.taskId);
  const [affectedMessages, linkedTasks, correction] = await Promise.all([
    db.select().from(messages).where(inArray(messages.id, ids)),
    db.select().from(tasks).where(inArray(tasks.id, taskIds)),
    db
      .select()
      .from(messages)
      .where(eq(messages.channelMessageId, correctionChannelId(manifest))),
  ]);
  return { affectedMessages, linkedTasks, correction };
}

/**
 * Refuse to write unless the database still looks exactly like the manifest
 * describes. Returns `already-applied` when a previous run finished, so a
 * repeat run is a verification rather than a second edit.
 */
function assertIncident(
  manifest: RetractionManifest,
  snapshot: Awaited<ReturnType<typeof inspectIncident>>,
): 'ready' | 'already-applied' {
  if (snapshot.correction.length > 1) {
    throw new Error('Repair guard failed: duplicate correction rows exist.');
  }
  if (snapshot.affectedMessages.length !== manifest.messages.length) {
    throw new Error(
      `Repair guard failed: expected ${manifest.messages.length} target messages, found ${snapshot.affectedMessages.length}.`,
    );
  }

  const alreadyRetracted = snapshot.affectedMessages.filter(
    (row) => Array.isArray(row.parts) && row.parts.some((part) => retractionPart(part) !== null),
  );
  if (alreadyRetracted.length > 0) {
    if (alreadyRetracted.length === manifest.messages.length && snapshot.correction.length === 1) {
      for (const expected of manifest.messages) {
        const row = alreadyRetracted.find((message) => message.id === expected.id);
        const notice = Array.isArray(row?.parts)
          ? row.parts.map(retractionPart).find((part) => part !== null)
          : null;
        if (
          !row ||
          row.text !== retractionText(expected.reason) ||
          notice?.repairId !== manifest.repairId ||
          notice.reason !== expected.reason ||
          typeof notice.originalText !== 'string' ||
          digest(notice.originalText) !== expected.sha256
        ) {
          throw new Error(`Repair guard failed: invalid retraction for message ${expected.id}.`);
        }
      }
      return 'already-applied';
    }
    throw new Error('Repair guard failed: incident is only partially repaired.');
  }

  if (
    snapshot.linkedTasks.length !== manifest.messages.length ||
    manifest.messages.some(
      (expected) =>
        !snapshot.linkedTasks.some(
          (task) =>
            task.id === expected.taskId &&
            (task.conversationId === null || task.conversationId === manifest.conversationId),
        ),
    )
  ) {
    throw new Error('Repair guard failed: linked task ownership changed.');
  }

  for (const expected of manifest.messages) {
    const actual = snapshot.affectedMessages.find((row) => row.id === expected.id);
    if (!actual) throw new Error(`Repair guard failed: missing message ${expected.id}.`);
    if (actual.conversationId !== manifest.conversationId || actual.taskId !== expected.taskId) {
      throw new Error(`Repair guard failed: ownership changed for message ${expected.id}.`);
    }
    if (actual.role !== 'assistant' || digest(actual.text) !== expected.sha256) {
      throw new Error(`Repair guard failed: content changed for message ${expected.id}.`);
    }
  }

  if (snapshot.correction.length !== 0) {
    throw new Error(
      'Repair guard failed: a correction row already exists without full retractions.',
    );
  }
  return 'ready';
}

export async function retractMessages(
  db: Db,
  manifest: RetractionManifest,
  options: { apply: boolean; backupPath?: string },
): Promise<{ status: 'dry-run' | 'applied' | 'already-applied'; backupPath?: string }> {
  const snapshot = await inspectIncident(db, manifest);
  const state = assertIncident(manifest, snapshot);
  if (state === 'already-applied') return { status: 'already-applied' };
  if (!options.apply) return { status: 'dry-run' };
  if (!options.backupPath) throw new Error('An explicit backup path is required when applying.');

  const backupPath = resolve(options.backupPath);
  await mkdir(dirname(backupPath), { recursive: true });
  await writeFile(
    backupPath,
    `${JSON.stringify({ repairId: manifest.repairId, createdAt: new Date().toISOString(), ...snapshot }, null, 2)}\n`,
    { flag: 'wx' },
  );

  await db.transaction(async (tx) => {
    const current = await inspectIncident(tx as unknown as Db, manifest);
    if (assertIncident(manifest, current) !== 'ready') {
      throw new Error('Repair changed before transaction start.');
    }
    for (const expected of manifest.messages) {
      const actual = current.affectedMessages.find((row) => row.id === expected.id);
      if (!actual) throw new Error(`Repair target disappeared: ${expected.id}`);
      const safeText = retractionText(expected.reason);
      await tx
        .update(messages)
        .set({
          text: safeText,
          // The retracted wording must not stay reachable through recall.
          embedding: null,
          parts: [
            { type: 'text', text: safeText },
            {
              type: 'notice',
              notice: 'retracted',
              reason: expected.reason,
              originalText: actual.text,
              repairId: manifest.repairId,
            },
          ],
        })
        .where(eq(messages.id, expected.id));
    }
    await tx
      .insert(messages)
      .values({
        conversationId: manifest.conversationId,
        role: 'assistant',
        origin: 'assistant',
        channelMessageId: correctionChannelId(manifest),
        text: manifest.correction.text,
        parts: [
          { type: 'text', text: manifest.correction.text },
          ...(manifest.correction.recall.length > 0
            ? [{ type: 'recall', sources: manifest.correction.recall }]
            : []),
        ],
      })
      .onConflictDoNothing();
  });

  const repaired = await inspectIncident(db, manifest);
  if (assertIncident(manifest, repaired) !== 'already-applied') {
    throw new Error('Repair verification failed after commit.');
  }
  return { status: 'applied', backupPath };
}

async function main() {
  const config = loadConfig();
  const apply = process.argv.includes('--apply');
  const production = process.argv.includes('--production');
  const manifestArg = process.argv.find((argument) => argument.startsWith('--manifest='));
  if (!manifestArg) throw new Error('--manifest=<path to the incident manifest> is required.');
  const manifest = RetractionManifestSchema.parse(
    JSON.parse(await readFile(resolve(manifestArg.slice('--manifest='.length)), 'utf8')),
  );

  const incidentArg = process.argv.find((argument) => argument.startsWith('--incident='));
  if (apply && (!production || incidentArg !== `--incident=${manifest.repairId}`)) {
    throw new Error(
      `Applying requires --production --incident=${manifest.repairId}. Dry-run first.`,
    );
  }
  const databaseUrl = production ? config.PROD_DATABASE_URL : config.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(production ? 'PROD_DATABASE_URL is required.' : 'DATABASE_URL is required.');
  }
  const backupArg = process.argv.find((argument) => argument.startsWith('--backup='));
  const backupPath =
    backupArg?.slice('--backup='.length) ??
    `.workspace/backups/${manifest.repairId}-${new Date().toISOString().replaceAll(':', '-')}.json`;

  const db = createDb(databaseUrl, { max: 1 });
  try {
    const result = await retractMessages(db, manifest, { apply, backupPath });
    console.log(
      result.status === 'dry-run'
        ? `Dry run passed: ${manifest.messages.length} messages and their task ownership match the manifest.`
        : result.status === 'already-applied'
          ? 'Repair already applied; no rows changed.'
          : `Repair applied and verified. Backup: ${result.backupPath}`,
    );
  } finally {
    await db.$client.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
