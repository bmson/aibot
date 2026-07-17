import { timingSafeEqual } from 'node:crypto';
import { type Db, files, tasks, toolCalls } from '@assistant/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { TaskStateSchema } from '../events.js';
import { getQueueNotifier } from '../queue.js';

function tokensMatch(expected: string, given: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

export type BrowserCallbackOutcome =
  | { ok: true; taskId: string; queueGeneration: number }
  | { ok: false; status: 400 | 403 | 404 | 409; error: string };

/**
 * The browser job's one-shot callback: verify the launch token against the
 * task's pendingJob checkpoint, replace the sentinel result on the tool_calls
 * row with the job's real result, and wake the task. Idempotent-ish: once the
 * executor settles the job, pendingJob is cleared and later callbacks get 409.
 */
export async function recordBrowserJobResult(
  db: Db,
  input: { taskId: string; token: string; result: Record<string, unknown> },
): Promise<BrowserCallbackOutcome> {
  if (!input.taskId || !input.token) return { ok: false, status: 400, error: 'bad request' };

  const outcome = await db.transaction(async (tx): Promise<BrowserCallbackOutcome> => {
    // Serialize callback vs. administrative cancellation and executor claim.
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, input.taskId)).for('update');
    if (!task) return { ok: false, status: 404, error: 'task not found' };

    const state = TaskStateSchema.parse(task.state ?? {});
    const pending = state.pendingJob;
    if (!pending) return { ok: false, status: 409, error: 'no pending browser job' };
    if (!tokensMatch(pending.callbackToken, input.token)) {
      return { ok: false, status: 403, error: 'invalid token' };
    }
    // The token is durably checkpointed BEFORE launch, so a fast callback may
    // legitimately arrive while the launching executor still owns the task.
    // Moving running → pending invalidates that lease; its later CAS writes are
    // fenced out and the callback result becomes authoritative.
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

    // Inventory the job's Workspace artifacts (screenshots + trace) in `files`.
    const screenshots = Array.isArray(input.result.screenshots)
      ? (input.result.screenshots as unknown[]).filter((s): s is string => typeof s === 'string')
      : [];
    const artifacts = [
      ...screenshots.map((p) => ({ path: p, mime: 'image/png' })),
      ...(typeof input.result.tracePath === 'string'
        ? [{ path: input.result.tracePath, mime: 'application/zip' }]
        : []),
    ];
    if (artifacts.length > 0) {
      await tx.insert(files).values(
        artifacts.map((a) => ({
          agentId: task.agentId,
          taskId: task.id,
          workspacePath: a.path,
          mime: a.mime,
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
