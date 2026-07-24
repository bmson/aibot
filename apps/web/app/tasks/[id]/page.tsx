import { activeAutonomyGrant, getAgent } from '@assistant/core';
import { approvals, files, messages, modelCalls, tasks, toolCalls } from '@assistant/db';
import { and, asc, eq } from 'drizzle-orm';
import { Brain, Hand, MessageSquare, Wrench } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { requireOwner } from '@/auth';
import { formatDateTime, formatUsd, prettyJson, relativeTime, truncate } from '@/lib/format';
import { getDb } from '@/lib/server';
import { cardShellClass, InfoGrid, InfoItem, PageShell } from '@/lib/ui';
import { SubmitButton } from '@/lib/ui-client';
import { displayTaskStatus, StatusChip, taskTypeLabel, trustLabel } from '@/lib/views';
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

type TimelineKind = 'tool' | 'model' | 'approval' | 'message';

const timelineIcons: Record<TimelineKind, typeof Wrench> = {
  tool: Wrench,
  model: Brain,
  approval: Hand,
  message: MessageSquare,
};

interface TimelineEntry {
  key: string;
  at: Date;
  icon: TimelineKind;
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
        icon: 'tool',
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
        icon: 'model',
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
        icon: 'approval',
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
              {approval.resolvedAt
                ? ` at ${formatDateTime(approval.resolvedAt, agent.timezone)}`
                : ''}
            </p>
          </div>
        ),
      }),
    ),
    ...taskMessages.map(
      (message): TimelineEntry => ({
        key: `message-${message.id}`,
        at: message.createdAt,
        icon: 'message',
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
  const terminal = TERMINAL_TASK_STATUSES.has(task.status);
  // Parked on an approval that was resolved, expired, or never written. Nothing
  // will ever arrive to un-park it, so the owner needs the way out here.
  const stuckWaiting =
    task.status === 'waiting_approval' &&
    !taskApprovals.some((approval) => approval.status === 'pending');

  return (
    <PageShell size="reading">
      <Link
        href="/tasks"
        className="text-xs font-medium text-indigo-700 hover:underline dark:text-indigo-300"
      >
        ← Activity
      </Link>
      <header className="mt-3 grid min-w-0 gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-display text-2xl font-semibold tracking-[-0.035em]">
              {task.title || taskTypeLabel(task.type)}
            </h1>
            <StatusChip status={displayTaskStatus(task.status, !stuckWaiting)} />
          </div>
          {activeGrant ? (
            <span
              className="mt-2 inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300"
              title={`Free-range granted via ${activeGrant.grantedVia}. I act without asking, except the hard floor (memory from web content, unknown recipients, logged-in browsing, networked code) and budget caps.`}
            >
              ⚡ Free-range
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          {activeGrant && !terminal ? (
            <form action={revokeAutonomyGrant.bind(null, task.id)}>
              <SubmitButton pendingLabel="Revoking…">Revoke free-range</SubmitButton>
            </form>
          ) : null}
          {(task.status === 'needs_attention' && !stoppedForTaskBudget) || stuckWaiting ? (
            <form action={retryTask.bind(null, task.id)}>
              <SubmitButton variant="primary" pendingLabel="Retrying…">
                Retry
              </SubmitButton>
            </form>
          ) : null}
          {/* Any unfinished task can be called off. Restricting this to
              needs_attention left tasks parked on a vanished approval with no
              reachable action at all. */}
          {!terminal ? (
            <form action={cancelTask.bind(null, task.id)}>
              <SubmitButton pendingLabel="Cancelling…">Cancel</SubmitButton>
            </form>
          ) : null}
          {task.archivedAt ? (
            <form action={restoreTask.bind(null, task.id)}>
              <SubmitButton pendingLabel="Restoring…">Restore to Activity</SubmitButton>
            </form>
          ) : terminal ? (
            <form action={archiveTask.bind(null, task.id)}>
              <SubmitButton pendingLabel="Archiving…">Archive</SubmitButton>
            </form>
          ) : null}
        </div>
      </header>

      {stuckWaiting ? (
        <p className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-200">
          This was parked for an approval that no longer exists — it was resolved, it expired, or it
          was never recorded. Nothing will arrive to release it, so it does not appear on the
          Approvals page. Retry to run it again, or cancel it.
        </p>
      ) : null}

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
          <SubmitButton variant="primary" pendingLabel="Raising budget…">
            Raise budget and retry
          </SubmitButton>
          <p className="w-full text-xs text-amber-800 dark:text-amber-300">
            The task resumes from its saved checkpoint; completed actions are not repeated.
          </p>
        </form>
      ) : null}

      <InfoGrid className="mt-5 sm:grid-cols-3">
        <InfoItem label="Started by">{trustLabel(task.trust)}</InfoItem>
        <InfoItem label="Cost">
          {formatUsd(task.spentUsd)} of {formatUsd(task.budgetUsdLimit)}
        </InfoItem>
        <InfoItem label="Updated">
          {relativeTime(task.updatedAt, now)} · {formatDateTime(task.updatedAt, agent.timezone)}
        </InfoItem>
        {task.deadline ? (
          <InfoItem label="Target date">
            {relativeTime(task.deadline, now)} · {formatDateTime(task.deadline, agent.timezone)}
          </InfoItem>
        ) : null}
        {task.nextAction ? (
          <InfoItem label="What happens next" className="sm:col-span-2">
            {task.nextAction}
          </InfoItem>
        ) : null}
        {task.progress ? (
          <InfoItem label="Latest update" className="col-span-2 sm:col-span-3">
            {task.progress}
            {task.progressPercent != null ? ` (${task.progressPercent}%)` : ''}
          </InfoItem>
        ) : null}
      </InfoGrid>

      <section className={`${cardShellClass} mt-5 p-5`}>
        <h2 className="text-sm font-semibold">What actually happened</h2>
        <p className="mt-1 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
          This list is built from completed tool results, not from the assistant’s wording.
        </p>
        {completedActions.length === 0 ? (
          <p className="mt-4 rounded-lg bg-zinc-50 px-3 py-2 text-sm text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">
            No external action completed for this item.
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-zinc-100 dark:divide-zinc-800">
            {completedActions.map((call) => (
              <li key={call.id} className="py-3 first:pt-0 last:pb-0">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium">{actionLabel(call.toolName)}</p>
                    <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
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
        <section className={`${cardShellClass} mt-5 p-5`}>
          <h2 className="text-sm font-semibold">Files produced</h2>
          <p className="mt-1 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
            Artifacts this task saved to the workspace — click to download.
          </p>
          <ul className="mt-4 divide-y divide-zinc-100 dark:divide-zinc-800">
            {downloadableFiles.map((file) => (
              <li key={file.id} className="flex items-center justify-between gap-3 py-2">
                <a
                  href={`/api/files?path=${encodeURIComponent(file.workspacePath)}`}
                  className="truncate text-sm font-medium text-indigo-700 hover:underline dark:text-indigo-300"
                >
                  {file.workspacePath.split('/').pop()}
                </a>
                <span className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400">
                  {file.bytes > 0 ? `${Math.max(1, Math.round(file.bytes / 1024))} KB` : ''}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <details className={`${cardShellClass} mt-5 p-5`}>
        <summary className="cursor-pointer text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Full technical record
        </summary>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          Tool calls, approvals, messages, and model activity for troubleshooting.
        </p>
        {task.plan != null ? <JsonDetails summary="Plan" value={task.plan} /> : null}
        {timeline.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
            No activity recorded for this item yet.
          </p>
        ) : (
          <ol className="mt-4 flex flex-col gap-3">
            {timeline.map((entry) => {
              const EntryIcon = timelineIcons[entry.icon];
              return (
                <li
                  key={entry.key}
                  className="flex gap-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"
                >
                  <EntryIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-xs font-medium tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
                        {entry.label}
                      </span>
                      <span className="shrink-0 text-xs text-zinc-500 dark:text-zinc-500">
                        {formatDateTime(entry.at, agent.timezone)}
                      </span>
                    </div>
                    <div className="mt-1">{entry.content}</div>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </details>
    </PageShell>
  );
}
