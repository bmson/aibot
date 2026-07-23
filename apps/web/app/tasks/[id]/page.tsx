import { activeAutonomyGrant, getAgent } from '@assistant/core';
import { approvals, files, messages, modelCalls, tasks, toolCalls } from '@assistant/db';
import { and, asc, eq } from 'drizzle-orm';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { requireOwner } from '@/auth';
import { formatDateTime, formatUsd, prettyJson, relativeTime, truncate } from '@/lib/format';
import { getDb } from '@/lib/server';
import { btn } from '@/lib/ui';
import { StatusChip, taskTypeLabel, trustLabel } from '@/lib/views';
import {
  archiveTask,
  cancelTask,
  raiseTaskBudgetAndRetry,
  restoreTask,
  retryTask,
  revokeAutonomyGrant,
} from '../actions';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TERMINAL_TASK_STATUSES = new Set(['done', 'failed', 'cancelled']);

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

const actionLabels: Record<string, string> = {
  'docs.create': 'Created a document',
  'docs.append': 'Updated a document',
  'docs.share': 'Shared a document',
  'sheets.create': 'Created a spreadsheet',
  'sheets.append_rows': 'Updated a spreadsheet',
  'slides.create': 'Created a presentation',
  'slides.append': 'Updated a presentation',
  'calendar.create_event': 'Created a calendar event',
  'gmail.send': 'Sent an email',
  'sms.send': 'Sent a text message',
  'web.fetch': 'Read a web page',
  'browser.execute': 'Ran a browser task',
  'mission.update': 'Updated ongoing work',
};

function completedSuccessfully(call: { status: string; result: unknown }) {
  if (call.status !== 'succeeded') return false;
  if (!call.result || typeof call.result !== 'object') return true;
  const result = call.result as { ok?: unknown; status?: unknown; deliveryStatus?: unknown };
  return (
    result.ok !== false &&
    !(typeof result.status === 'number' && result.status >= 400) &&
    result.deliveryStatus !== 'unknown'
  );
}

function actionLabel(toolName: string) {
  return actionLabels[toolName] ?? toolName.replaceAll('.', ' ');
}

export default async function TaskDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireOwner();
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();

  const db = getDb();
  const agent = await getAgent(db);
  const now = new Date();

  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, id), eq(tasks.agentId, agent.id)));
  if (!task) notFound();

  const [taskToolCalls, taskModelCalls, taskApprovals, taskMessages, taskFiles] = await Promise.all(
    [
      db.select().from(toolCalls).where(eq(toolCalls.taskId, id)).orderBy(asc(toolCalls.createdAt)),
      db
        .select()
        .from(modelCalls)
        .where(eq(modelCalls.taskId, id))
        .orderBy(asc(modelCalls.createdAt)),
      db
        .select()
        .from(approvals)
        .where(eq(approvals.taskId, id))
        .orderBy(asc(approvals.requestedAt)),
      db.select().from(messages).where(eq(messages.taskId, id)).orderBy(asc(messages.createdAt)),
      db.select().from(files).where(eq(files.taskId, id)).orderBy(asc(files.createdAt)),
    ],
  );
  // Downloadable artifacts this task produced (charts, exports, saved pages).
  const downloadableFiles = taskFiles.filter((f) =>
    ['code/', 'browser/attachments/', 'documents/'].some((p) => f.workspacePath.startsWith(p)),
  );

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
  const completedActions = taskToolCalls.filter(completedSuccessfully);
  const incompleteActions = taskToolCalls.filter((call) => !completedSuccessfully(call));
  const taskBudget = Number(task.budgetUsdLimit);
  const suggestedBudget = Math.ceil(Math.max(taskBudget * 2, Number(task.spentUsd) + 0.25) * 4) / 4;
  const stoppedForTaskBudget =
    task.status === 'needs_attention' && task.progress.startsWith('budget: task budget');
  const activeGrant = activeAutonomyGrant(task, Date.now());

  return (
    <div className="mx-auto max-w-4xl">
      <Link
        href="/tasks"
        className="text-xs font-medium text-indigo-700 hover:underline dark:text-indigo-300"
      >
        ← Activity
      </Link>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-[-0.03em]">
          {task.title || taskTypeLabel(task.type)}
        </h1>
        <StatusChip status={task.status} />
        {activeGrant ? (
          <>
            <span
              className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300"
              title={`Free-range granted via ${activeGrant.grantedVia}. I act without asking, except the hard floor (memory from web content, unknown recipients, logged-in browsing, networked code) and budget caps.`}
            >
              ⚡ Free-range
            </span>
            {!TERMINAL_TASK_STATUSES.has(task.status) ? (
              <form action={revokeAutonomyGrant.bind(null, task.id)}>
                <button type="submit" className={btn.outline}>
                  Revoke free-range
                </button>
              </form>
            ) : null}
          </>
        ) : null}
        {task.status === 'needs_attention' && !stoppedForTaskBudget ? (
          <form action={retryTask.bind(null, task.id)}>
            <button type="submit" className={btn.primary}>
              Retry
            </button>
          </form>
        ) : null}
        {task.status === 'needs_attention' ? (
          <form action={cancelTask.bind(null, task.id)}>
            <button type="submit" className={btn.outline}>
              Cancel
            </button>
          </form>
        ) : null}
        {task.archivedAt ? (
          <form action={restoreTask.bind(null, task.id)}>
            <button type="submit" className={btn.outline}>
              Restore to Activity
            </button>
          </form>
        ) : TERMINAL_TASK_STATUSES.has(task.status) ? (
          <form action={archiveTask.bind(null, task.id)}>
            <button type="submit" className={btn.outline}>
              Archive
            </button>
          </form>
        ) : null}
      </div>

      {stoppedForTaskBudget ? (
        <form
          action={raiseTaskBudgetAndRetry.bind(null, task.id)}
          className="mt-5 flex flex-wrap items-end gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-900/60 dark:bg-amber-950/20"
        >
          <label className="flex flex-col gap-1 text-xs font-medium text-amber-900 dark:text-amber-200">
            New task budget (USD)
            <input
              type="number"
              name="budgetUsdLimit"
              step="0.01"
              min={(taskBudget + 0.01).toFixed(2)}
              max="10000"
              defaultValue={suggestedBudget.toFixed(2)}
              required
              className="w-32 rounded-md border border-amber-300 bg-white px-2 py-1 text-base text-zinc-900 sm:text-sm dark:border-amber-800 dark:bg-zinc-900 dark:text-zinc-100"
            />
          </label>
          <button type="submit" className={btn.primary}>
            Raise budget and retry
          </button>
          <p className="w-full text-xs text-amber-800 dark:text-amber-300">
            The task resumes from its saved checkpoint; completed actions are not repeated.
          </p>
        </form>
      ) : null}

      <div className="mt-5 rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs text-zinc-500 dark:text-zinc-400">Started by</dt>
            <dd>{trustLabel(task.trust)}</dd>
          </div>
          <div>
            <dt className="text-xs text-zinc-500 dark:text-zinc-400">Cost</dt>
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
              <dt className="text-xs text-zinc-500 dark:text-zinc-400">Target date</dt>
              <dd>
                {formatDateTime(task.deadline)} ({relativeTime(task.deadline, now)})
              </dd>
            </div>
          ) : null}
          {task.nextAction ? (
            <div className="sm:col-span-2">
              <dt className="text-xs text-zinc-500 dark:text-zinc-400">What happens next</dt>
              <dd>{task.nextAction}</dd>
            </div>
          ) : null}
          {task.progress ? (
            <div className="sm:col-span-3">
              <dt className="text-xs text-zinc-500 dark:text-zinc-400">Latest update</dt>
              <dd>
                {task.progress}
                {task.progressPercent != null ? ` (${task.progressPercent}%)` : ''}
              </dd>
            </div>
          ) : null}
        </dl>
      </div>

      <section className="mt-5 rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <h2 className="text-sm font-semibold">What actually happened</h2>
        <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-zinc-400">
          This list is built from completed tool results, not from the assistant’s wording.
        </p>
        {completedActions.length === 0 ? (
          <p className="mt-4 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600 dark:bg-zinc-900 dark:text-zinc-400">
            No external action completed for this item.
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-slate-100 dark:divide-zinc-800">
            {completedActions.map((call) => (
              <li key={call.id} className="py-3 first:pt-0 last:pb-0">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium">{actionLabel(call.toolName)}</p>
                    <p className="mt-0.5 text-xs text-slate-500 dark:text-zinc-400">
                      {relativeTime(call.finishedAt ?? call.createdAt, now)}
                    </p>
                  </div>
                  <StatusChip status="done" />
                </div>
                {call.result != null ? (
                  <JsonDetails summary="View result" value={call.result} />
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {incompleteActions.length > 0 ? (
          <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900/60 dark:bg-amber-950/20">
            <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
              Didn’t complete
            </p>
            <ul className="mt-1 space-y-1 text-xs text-amber-800 dark:text-amber-300">
              {incompleteActions.map((call) => (
                <li key={call.id}>
                  {actionLabel(call.toolName)}
                  {call.error ? ` — ${call.error}` : ''}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      {downloadableFiles.length > 0 ? (
        <section className="mt-5 rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <h2 className="text-sm font-semibold">Files produced</h2>
          <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-zinc-400">
            Artifacts this task saved to the workspace — click to download.
          </p>
          <ul className="mt-4 divide-y divide-slate-100 dark:divide-zinc-800">
            {downloadableFiles.map((file) => (
              <li key={file.id} className="flex items-center justify-between gap-3 py-2">
                <a
                  href={`/api/files?path=${encodeURIComponent(file.workspacePath)}`}
                  className="truncate text-sm font-medium text-indigo-700 hover:underline dark:text-indigo-300"
                >
                  {file.workspacePath.split('/').pop()}
                </a>
                <span className="shrink-0 text-xs text-slate-500 dark:text-zinc-400">
                  {file.bytes > 0 ? `${Math.max(1, Math.round(file.bytes / 1024))} KB` : ''}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <details className="mt-5 rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <summary className="cursor-pointer text-sm font-medium text-slate-700 dark:text-zinc-300">
          Full technical record
        </summary>
        <p className="mt-1 text-xs text-slate-500 dark:text-zinc-400">
          Tool calls, approvals, messages, and model activity for troubleshooting.
        </p>
        {task.plan != null ? <JsonDetails summary="Plan" value={task.plan} /> : null}
        {timeline.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
            No activity recorded for this item yet.
          </p>
        ) : (
          <ol className="mt-4 flex flex-col gap-3">
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
      </details>
    </div>
  );
}
