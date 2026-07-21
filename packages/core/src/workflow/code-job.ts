import { timingSafeEqual } from 'node:crypto';
import { type Db, files, tasks, toolCalls } from '@assistant/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { hashCallbackToken } from '../browse.js';
import { TaskStateSchema } from '../events.js';
import { getQueueNotifier } from '../queue.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function tokensMatch(expected: string, given: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

const MIME_BY_EXT: Record<string, string> = {
  json: 'application/json',
  csv: 'text/csv',
  txt: 'text/plain',
  md: 'text/markdown',
  html: 'text/html',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
};

function mimeForPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

export type CodeCallbackOutcome =
  | { ok: true; taskId: string; queueGeneration: number }
  | { ok: false; status: 400 | 403 | 404 | 409; error: string };

/**
 * The code job's one-shot callback: verify the launch token against the task's
 * pendingJob checkpoint, replace the sentinel result on the tool_calls row with
 * the job's real result, inventory any output files the script wrote, and wake
 * the task. Mirrors recordBrowserJobResult — the security checks are identical
 * (UUID guard → FOR UPDATE → pending exists → constant-time token compare →
 * status gate → sentinel replace → wake); only the artifact inventory differs.
 */
export async function recordCodeJobResult(
  db: Db,
  input: { taskId: string; token: string; result: Record<string, unknown> },
): Promise<CodeCallbackOutcome> {
  if (!input.taskId || !input.token) return { ok: false, status: 400, error: 'bad request' };
  if (!UUID_RE.test(input.taskId)) return { ok: false, status: 400, error: 'bad request' };

  const outcome = await db.transaction(async (tx): Promise<CodeCallbackOutcome> => {
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, input.taskId)).for('update');
    if (!task) return { ok: false, status: 404, error: 'task not found' };

    const state = TaskStateSchema.parse(task.state ?? {});
    const pending = state.pendingJob;
    if (!pending) return { ok: false, status: 409, error: 'no pending code job' };
    if (!tokensMatch(pending.callbackTokenHash, hashCallbackToken(input.token))) {
      return { ok: false, status: 403, error: 'invalid token' };
    }
    const callbackStates = ['running', 'sleeping', 'waiting_approval'];
    if (!callbackStates.includes(task.status)) {
      return {
        ok: false,
        status: 409,
        error: `task is ${task.status}; callback is no longer accepted`,
      };
    }

    await tx
      .update(toolCalls)
      .set({ status: 'succeeded', result: input.result, finishedAt: sql`now()` })
      .where(eq(toolCalls.id, pending.dbToolCallId));

    // Inventory the files the script wrote (already uploaded to the workspace).
    const outputs = Array.isArray(input.result.outputs)
      ? (input.result.outputs as unknown[]).filter((p): p is string => typeof p === 'string')
      : [];
    if (outputs.length > 0) {
      await tx.insert(files).values(
        outputs.slice(0, 100).map((p) => ({
          agentId: task.agentId,
          taskId: task.id,
          workspacePath: p,
          mime: mimeForPath(p),
        })),
      );
    }

    const [woken] = await tx
      .update(tasks)
      .set({
        status: 'pending',
        runAfter: null,
        lockedUntil: null,
        queueGeneration: sql`${tasks.queueGeneration} + 1`,
        updatedAt: sql`now()`,
      })
      .where(and(eq(tasks.id, task.id), inArray(tasks.status, callbackStates)))
      .returning({ id: tasks.id, queueGeneration: tasks.queueGeneration });
    return woken
      ? { ok: true, taskId: task.id, queueGeneration: woken.queueGeneration }
      : { ok: false, status: 409, error: 'task is no longer waiting for this callback' };
  });

  if (outcome.ok) getQueueNotifier().notify(outcome.taskId, outcome.queueGeneration);
  return outcome;
}
