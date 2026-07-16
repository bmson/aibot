import { approvals, tasks } from '@assistant/db';
import { asc, desc, eq, inArray } from 'drizzle-orm';
import Link from 'next/link';
import { requireOwner } from '@/auth';
import { formatDateTime, relativeTime } from '@/lib/format';
import { getDb } from '@/lib/server';
import { StatusChip, toPendingApprovalView } from '@/lib/views';
import { ApprovalCard } from './approval-card';

export const dynamic = 'force-dynamic';

export default async function ApprovalsPage() {
  await requireOwner();
  const db = getDb();
  const now = new Date();

  const [pending, resolved] = await Promise.all([
    db
      .select({ approval: approvals, taskType: tasks.type, taskTrust: tasks.trust })
      .from(approvals)
      .innerJoin(tasks, eq(approvals.taskId, tasks.id))
      .where(eq(approvals.status, 'pending'))
      .orderBy(asc(approvals.requestedAt)),
    db
      .select({ approval: approvals, taskType: tasks.type })
      .from(approvals)
      .innerJoin(tasks, eq(approvals.taskId, tasks.id))
      .where(inArray(approvals.status, ['approved', 'denied', 'expired']))
      .orderBy(desc(approvals.resolvedAt))
      .limit(20),
  ]);

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="text-xl font-semibold">Approvals</h1>
      <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
        Review and approve or reject actions the assistant wants to take on your behalf.
      </p>

      <h2 className="mt-8 text-sm font-medium">Pending</h2>
      {pending.length === 0 ? (
        <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
          Nothing to approve — actions that need your sign-off will appear here.
        </p>
      ) : (
        <div className="mt-3 flex flex-col gap-3">
          {pending.map(({ approval, taskType, taskTrust }) => (
            <ApprovalCard
              key={approval.id}
              approval={toPendingApprovalView(approval, { type: taskType, trust: taskTrust }, now)}
            />
          ))}
        </div>
      )}

      <h2 className="mt-8 text-sm font-medium">Recently resolved</h2>
      {resolved.length === 0 ? (
        <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">No resolved approvals yet.</p>
      ) : (
        <div className="mt-3 flex flex-col gap-2">
          {resolved.map(({ approval, taskType }) => (
            <div
              key={approval.id}
              className="rounded-lg border border-zinc-200 p-3 opacity-70 dark:border-zinc-800"
            >
              <div className="flex items-start justify-between gap-3">
                <p className="min-w-0 truncate text-sm">{approval.summary}</p>
                <span className="flex shrink-0 items-center gap-2">
                  <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">
                    {approval.shortCode}
                  </span>
                  <StatusChip status={approval.status} />
                </span>
              </div>
              <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-500">
                <Link href={`/tasks/${approval.taskId}`} className="hover:underline">
                  task {taskType}
                </Link>
                {' · '}requested {formatDateTime(approval.requestedAt)}
                {approval.resolvedAt
                  ? ` · resolved ${formatDateTime(approval.resolvedAt)} (${relativeTime(approval.resolvedAt, now)})`
                  : ''}
                {approval.resolvedVia ? ` via ${approval.resolvedVia}` : ''}
                {approval.resolutionPayload ? ' · payload edited' : ''}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
