import { approvals, messages, modelCalls, tasks, toolCalls } from '@assistant/db';
import { asc, eq } from 'drizzle-orm';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { requireOwner } from '@/auth';
import { formatDateTime, formatUsd, prettyJson, relativeTime, truncate } from '@/lib/format';
import { getDb } from '@/lib/server';
import { StatusChip } from '@/lib/views';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface TimelineEntry {
  key: string;
  at: Date;
  icon: string;
  label: string;
  content: ReactNode;
}

function JsonDetails({ summary, value }: { summary: string; value: unknown }) {
  return (
    <details className="mt-1">
      <summary className="cursor-pointer text-xs text-zinc-600 select-none dark:text-zinc-400">
        {summary}
      </summary>
      <pre className="mt-1 overflow-x-auto rounded bg-zinc-100 p-2 font-mono text-xs dark:bg-zinc-900">
        {typeof value === 'string' ? value : prettyJson(value)}
      </pre>
    </details>
  );
}

export default async function TaskDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireOwner();
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();

  const db = getDb();
  const now = new Date();

  const [task] = await db.select().from(tasks).where(eq(tasks.id, id));
  if (!task) notFound();

  const [taskToolCalls, taskModelCalls, taskApprovals, taskMessages] = await Promise.all([
    db.select().from(toolCalls).where(eq(toolCalls.taskId, id)).orderBy(asc(toolCalls.createdAt)),
    db
      .select()
      .from(modelCalls)
      .where(eq(modelCalls.taskId, id))
      .orderBy(asc(modelCalls.createdAt)),
    db.select().from(approvals).where(eq(approvals.taskId, id)).orderBy(asc(approvals.requestedAt)),
    db.select().from(messages).where(eq(messages.taskId, id)).orderBy(asc(messages.createdAt)),
  ]);

  const timeline: TimelineEntry[] = [
    ...taskToolCalls.map((tc): TimelineEntry => {
      const decision = tc.decision as { riskTier?: string; policyId?: string } | null;
      return {
        key: `tool-${tc.id}`,
        at: tc.createdAt,
        icon: '🔧',
        label: 'tool call',
        content: (
          <div>
            <p className="text-sm">
              <span className="font-mono font-medium">{tc.toolName}</span>{' '}
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                step {tc.step} · <StatusChip status={tc.status} />
              </span>
            </p>
            {decision?.riskTier ? (
              <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                risk {decision.riskTier}
                {decision.policyId ? ` · policy ${decision.policyId}` : ''}
              </p>
            ) : null}
            <JsonDetails summary="Args" value={tc.args} />
            {tc.result != null ? <JsonDetails summary="Result" value={tc.result} /> : null}
            {tc.error ? <JsonDetails summary="Error" value={tc.error} /> : null}
          </div>
        ),
      };
    }),
    ...taskModelCalls.map(
      (mc): TimelineEntry => ({
        key: `model-${mc.id}`,
        at: mc.createdAt,
        icon: '🧠',
        label: 'model call',
        content: (
          <p className="text-sm">
            <span className="font-medium">{mc.role}</span>{' '}
            <span className="font-mono text-xs text-zinc-600 dark:text-zinc-400">{mc.model}</span>{' '}
            <span className="text-xs text-zinc-500 dark:text-zinc-500">
              {formatUsd(mc.costUsd)}
              {mc.latencyMs != null ? ` · ${mc.latencyMs}ms` : ''}
            </span>
          </p>
        ),
      }),
    ),
    ...taskApprovals.map(
      (approval): TimelineEntry => ({
        key: `approval-${approval.id}`,
        at: approval.requestedAt,
        icon: '✋',
        label: 'approval',
        content: (
          <div>
            <p className="text-sm">
              {approval.summary}{' '}
              <span className="text-xs">
                <StatusChip status={approval.status} />
              </span>
            </p>
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
              {approval.shortCode}
              {approval.resolvedVia ? ` · resolved via ${approval.resolvedVia}` : ''}
              {approval.resolvedAt ? ` at ${formatDateTime(approval.resolvedAt)}` : ''}
            </p>
          </div>
        ),
      }),
    ),
    ...taskMessages.map(
      (message): TimelineEntry => ({
        key: `message-${message.id}`,
        at: message.createdAt,
        icon: '💬',
        label: 'message',
        content: (
          <p className="text-sm">
            <span className="font-medium">{message.role}</span>{' '}
            <span className="text-zinc-600 dark:text-zinc-400">{truncate(message.text, 200)}</span>
          </p>
        ),
      }),
    ),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());

  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">{task.type}</h1>
        <StatusChip status={task.status} />
      </div>

      <div className="mt-4 rounded-lg border border-zinc-200 p-5 dark:border-zinc-800">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs text-zinc-500 dark:text-zinc-400">Trust</dt>
            <dd>{task.trust}</dd>
          </div>
          <div>
            <dt className="text-xs text-zinc-500 dark:text-zinc-400">Budget</dt>
            <dd>
              {formatUsd(task.spentUsd)} of {formatUsd(task.budgetUsdLimit)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-zinc-500 dark:text-zinc-400">Updated</dt>
            <dd>
              {formatDateTime(task.updatedAt)} ({relativeTime(task.updatedAt, now)})
            </dd>
          </div>
          {task.deadline ? (
            <div>
              <dt className="text-xs text-zinc-500 dark:text-zinc-400">Deadline</dt>
              <dd>
                {formatDateTime(task.deadline)} ({relativeTime(task.deadline, now)})
              </dd>
            </div>
          ) : null}
          {task.nextAction ? (
            <div className="col-span-2">
              <dt className="text-xs text-zinc-500 dark:text-zinc-400">Next action</dt>
              <dd>{task.nextAction}</dd>
            </div>
          ) : null}
          {task.progress ? (
            <div className="col-span-2 sm:col-span-3">
              <dt className="text-xs text-zinc-500 dark:text-zinc-400">Progress</dt>
              <dd>
                {task.progress}
                {task.progressPercent != null ? ` (${task.progressPercent}%)` : ''}
              </dd>
            </div>
          ) : null}
        </dl>
        {task.plan != null ? <JsonDetails summary="Plan" value={task.plan} /> : null}
      </div>

      <h2 className="mt-8 text-sm font-medium">Timeline</h2>
      {timeline.length === 0 ? (
        <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
          No activity recorded for this task yet.
        </p>
      ) : (
        <ol className="mt-3 flex flex-col gap-3">
          {timeline.map((entry) => (
            <li
              key={entry.key}
              className="flex gap-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"
            >
              <span aria-hidden="true" className="mt-0.5">
                {entry.icon}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-xs font-medium tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
                    {entry.label}
                  </span>
                  <span className="shrink-0 text-xs text-zinc-500 dark:text-zinc-500">
                    {formatDateTime(entry.at)}
                  </span>
                </div>
                <div className="mt-1">{entry.content}</div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
