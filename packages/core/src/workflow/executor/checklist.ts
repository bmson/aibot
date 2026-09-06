import { approvals, type Db, toolCalls } from '@assistant/db';
import { eq } from 'drizzle-orm';
import type { TaskState } from '../../events.js';
import { reconcileRequestChecklist } from '../request-checklist.js';

/** Exact task scope, including undecided/denied calls; no conversation-wide receipts. */
export async function refreshRequestChecklist(
  db: Db,
  taskId: string,
  state: TaskState,
): Promise<void> {
  if (!state.requestChecklist) return;
  const [rows, decisions] = await Promise.all([
    db
      .select({
        id: toolCalls.id,
        toolName: toolCalls.toolName,
        status: toolCalls.status,
        args: toolCalls.args,
        result: toolCalls.result,
      })
      .from(toolCalls)
      .where(eq(toolCalls.taskId, taskId))
      .orderBy(toolCalls.step, toolCalls.id),
    db
      .select({ toolCallId: approvals.toolCallId, status: approvals.status })
      .from(approvals)
      .where(eq(approvals.taskId, taskId)),
  ]);
  const byCall = new Map(decisions.map((decision) => [decision.toolCallId, decision.status]));
  state.requestChecklist = reconcileRequestChecklist(
    state.requestChecklist,
    rows.map((row) => {
      const decision = byCall.get(row.id);
      if (decision === 'denied' || decision === 'expired') return { ...row, status: decision };
      if (decision === 'approved' && row.status === 'awaiting_approval')
        return { ...row, status: 'approved_not_executed' };
      return row;
    }),
  );
}
