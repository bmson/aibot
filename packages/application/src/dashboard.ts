import { approvals, type Db, tasks } from '@assistant/db';
import { and, count, eq, gt, inArray, sql } from 'drizzle-orm';

export type AssistantPresence = 'idle' | 'working' | 'attention';

export interface DashboardPresence {
  pendingApprovals: number;
  needsAttention: number;
  presence: AssistantPresence;
}

/** Query the small status projection needed by the global dashboard shell. */
export async function getDashboardPresence(db: Db, agentId: string): Promise<DashboardPresence> {
  const [pendingRows, activityRows] = await Promise.all([
    db
      .select({ value: count() })
      .from(approvals)
      .innerJoin(tasks, eq(approvals.taskId, tasks.id))
      .where(
        and(
          eq(tasks.agentId, agentId),
          eq(approvals.status, 'pending'),
          gt(approvals.expiresAt, sql`now()`),
        ),
      ),
    db
      .select({ status: tasks.status, value: count() })
      .from(tasks)
      .where(and(eq(tasks.agentId, agentId), inArray(tasks.status, ['running', 'needs_attention'])))
      .groupBy(tasks.status),
  ]);

  const pendingApprovals = Number(pendingRows[0]?.value ?? 0);
  const needsAttention = Number(
    activityRows.find((row) => row.status === 'needs_attention')?.value ?? 0,
  );
  const running = Number(activityRows.find((row) => row.status === 'running')?.value ?? 0);
  return {
    pendingApprovals,
    needsAttention,
    presence:
      pendingApprovals > 0 || needsAttention > 0 ? 'attention' : running > 0 ? 'working' : 'idle',
  };
}
