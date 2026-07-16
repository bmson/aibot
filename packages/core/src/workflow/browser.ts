import { timingSafeEqual } from 'node:crypto';
import { type Db, tasks, toolCalls } from '@assistant/db';
import { eq, sql } from 'drizzle-orm';
import { TaskStateSchema } from '../events.js';
import { wakeTask } from './machine.js';

function tokensMatch(expected: string, given: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

export type BrowserCallbackOutcome =
  | { ok: true; taskId: string }
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

  const [task] = await db.select().from(tasks).where(eq(tasks.id, input.taskId));
  if (!task) return { ok: false, status: 404, error: 'task not found' };

  const state = TaskStateSchema.parse(task.state ?? {});
  const pending = state.pendingJob;
  if (!pending) return { ok: false, status: 409, error: 'no pending browser job' };
  if (!tokensMatch(pending.callbackToken, input.token)) {
    return { ok: false, status: 403, error: 'invalid token' };
  }
  // While the executor holds the claim it may be settling this very job —
  // let the job retry rather than race the settle read.
  if (task.status === 'running') {
    return { ok: false, status: 409, error: 'task is running — retry shortly' };
  }

  await db
    .update(toolCalls)
    .set({ result: input.result, finishedAt: sql`now()` })
    .where(eq(toolCalls.id, pending.dbToolCallId));
  await wakeTask(db, task.id);
  return { ok: true, taskId: task.id };
}
