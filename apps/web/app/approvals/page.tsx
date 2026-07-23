import { getAgent } from '@assistant/core';
import { approvals, tasks, toolCalls } from '@assistant/db';
import { and, asc, desc, eq, gt, inArray, lte, or, sql } from 'drizzle-orm';
import { ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { AutoRefresh } from '@/app/auto-refresh';
import { requireOwner } from '@/auth';
import { formatDateTime, relativeTime } from '@/lib/format';
import { getAgentTimezone, getDb } from '@/lib/server';
import { EmptyState, InfoGrid, InfoItem, PageHeader, PageShell, SectionHeading } from '@/lib/ui';
import { StatusChip, taskTypeLabel, toPendingApprovalView } from '@/lib/views';
import { ApprovalCard } from './approval-card';

export const metadata = { title: 'Approvals' };

export const dynamic = 'force-dynamic';

export default async function ApprovalsPage() {
  await requireOwner();
  const db = getDb();
  const now = new Date();
  const [tz, agent] = await Promise.all([getAgentTimezone(), getAgent(db)]);

  const [pending, resolved] = await Promise.all([
    db
      .select({
        approval: approvals,
        taskType: tasks.type,
        taskTrust: tasks.trust,
        toolName: toolCalls.toolName,
        decision: toolCalls.decision,
      })
      .from(approvals)
      .innerJoin(tasks, eq(approvals.taskId, tasks.id))
      .innerJoin(toolCalls, eq(approvals.toolCallId, toolCalls.id))
      .where(
        and(
          eq(tasks.agentId, agent.id),
          eq(approvals.status, 'pending'),
          gt(approvals.expiresAt, sql`now()`),
        ),
      )
      .orderBy(asc(approvals.requestedAt)),
    db
      .select({ approval: approvals, taskType: tasks.type })
      .from(approvals)
      .innerJoin(tasks, eq(approvals.taskId, tasks.id))
      .where(
        and(
          eq(tasks.agentId, agent.id),
          or(
            inArray(approvals.status, ['approved', 'denied', 'expired']),
            and(eq(approvals.status, 'pending'), lte(approvals.expiresAt, sql`now()`)),
          ),
        ),
      )
      .orderBy(desc(approvals.resolvedAt))
      .limit(20),
  ]);

  return (
    <PageShell size="reading">
      <AutoRefresh />
      <PageHeader
        title="Approvals"
        intro="Review and approve or reject actions the assistant wants to take on your behalf."
      />

      <section className="mt-8">
        <SectionHeading title="Waiting for you" count={pending.length} />
        <p className="mt-1 text-[13px] leading-5 text-muted">
          Each card shows the real-world effect first. Policy and raw payload details stay available
          when you need them.
        </p>
        {pending.length === 0 ? (
          <EmptyState icon={<ShieldCheck className="size-5" />}>
            Nothing is waiting on you. AI Bot asks here before anything leaves its workspace.
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
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[15px] font-semibold [&::-webkit-details-marker]:hidden">
          Recently resolved
          <span className="text-xs font-normal text-muted group-open:hidden">
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
                    <p className="min-w-0 text-[13px] leading-5">{approval.summary}</p>
                    <span className="flex shrink-0 items-center gap-2">
                      <span className="rounded bg-raised px-1.5 py-0.5 font-mono text-xs text-muted">
                        {approval.shortCode}
                      </span>
                      <StatusChip status={displayStatus} />
                    </span>
                  </div>
                  <InfoGrid className="mt-2 sm:grid-cols-3">
                    <InfoItem label="Activity">
                      <Link href={`/tasks/${approval.taskId}`} className="hover:underline">
                        {taskTypeLabel(taskType)}
                      </Link>
                    </InfoItem>
                    <InfoItem label="Requested">
                      {formatDateTime(approval.requestedAt, tz)}
                    </InfoItem>
                    <InfoItem label="Outcome">
                      {approval.resolvedAt
                        ? `${relativeTime(approval.resolvedAt, now)}${approval.resolvedVia ? ` via ${approval.resolvedVia}` : ''}${approval.resolutionPayload ? ' · edited' : ''}`
                        : `Expired ${relativeTime(approval.expiresAt, now)}`}
                    </InfoItem>
                  </InfoGrid>
                </div>
              );
            })}
          </div>
        )}
      </details>
    </PageShell>
  );
}
