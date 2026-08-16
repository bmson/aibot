import { listApprovalInbox } from '@assistant/application/approvals';
import { ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { AutoRefresh } from '@/app/auto-refresh';
import { requireOwner } from '@/auth';
import { formatDateTime, relativeTime } from '@/lib/format';
import { getAgentTimezone, getDb } from '@/lib/server';
import { EmptyState, MetaLine, PageHeader, PageShell, SectionHeading } from '@/lib/ui';
import { StatusChip, taskTypeLabel, toPendingApprovalView } from '@/lib/views';
import { ApprovalCard } from './approval-card';

export const metadata = { title: 'Approvals' };

export const dynamic = 'force-dynamic';

export default async function ApprovalsPage() {
  await requireOwner();
  const db = getDb();
  const now = new Date();
  const [tz, { pending, resolved }] = await Promise.all([
    getAgentTimezone(),
    listApprovalInbox(db),
  ]);

  return (
    <PageShell size="reading">
      <AutoRefresh />
      <PageHeader
        back={{ href: '/chat', label: 'Chat' }}
        title="Approvals"
        intro="Review and approve or reject actions the assistant wants to take on your behalf."
      />

      <section className="mt-8">
        <SectionHeading title="Waiting for you" count={pending.length} />
        <p className="mt-1 text-sm leading-5 text-muted">
          Each card shows the real-world effect first. Policy and raw payload details stay available
          when you need them.
        </p>
        {pending.length === 0 ? (
          <EmptyState icon={<ShieldCheck className="size-5" />}>
            Nothing is waiting on you. The assistant asks here before anything leaves its workspace.
          </EmptyState>
        ) : (
          <div className="mt-5 flex flex-col gap-4">
            {pending.map(({ approval, taskType, taskTrust, toolName, decision }) => (
              <ApprovalCard
                key={approval.id}
                approval={toPendingApprovalView(
                  approval,
                  { type: taskType, trust: taskTrust },
                  { toolName, decision },
                  now,
                  tz,
                )}
              />
            ))}
          </div>
        )}
      </section>

      <details className="group mt-6 rounded-2xl bg-sunken/55 p-5">
        <summary className="disclosure flex cursor-pointer items-center gap-2 text-base font-semibold">
          Recently resolved
          <span className="ml-auto text-xs font-normal text-muted group-open:hidden">
            {resolved.length} recent
          </span>
        </summary>
        {resolved.length === 0 ? (
          <EmptyState>No resolved approvals yet.</EmptyState>
        ) : (
          <div className="mt-4 divide-y divide-edge">
            {resolved.map(({ approval, taskType }) => {
              const displayStatus =
                approval.status === 'pending' && approval.expiresAt <= now
                  ? 'expired'
                  : approval.status;
              return (
                <div key={approval.id} className="py-3 first:pt-0 last:pb-0">
                  <div className="flex items-start justify-between gap-3">
                    <p className="min-w-0 text-sm leading-5">{approval.summary}</p>
                    <span className="flex shrink-0 items-center gap-2">
                      <span className="rounded bg-raised px-1.5 py-0.5 font-mono text-xs text-muted">
                        {approval.shortCode}
                      </span>
                      <StatusChip status={displayStatus} />
                    </span>
                  </div>
                  {/* A settled approval is a receipt — one line, not a grid. */}
                  <MetaLine
                    className="mt-1"
                    segments={[
                      <Link
                        key="task"
                        href={`/tasks/${approval.taskId}`}
                        className="hover:text-strong hover:underline"
                      >
                        {taskTypeLabel(taskType)}
                      </Link>,
                      `requested ${formatDateTime(approval.requestedAt, tz)}`,
                      approval.resolvedAt
                        ? `resolved ${relativeTime(approval.resolvedAt, now)}${approval.resolvedVia ? ` via ${approval.resolvedVia}` : ''}${approval.resolutionPayload ? ' · edited' : ''}`
                        : `expired ${relativeTime(approval.expiresAt, now)}`,
                    ]}
                  />
                </div>
              );
            })}
          </div>
        )}
      </details>
    </PageShell>
  );
}
