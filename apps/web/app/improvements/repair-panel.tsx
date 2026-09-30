'use client';
import { useState, useTransition } from 'react';
import { ActionButton } from '@/lib/ui-client';
import { repairDecisionAction, reportRepairAction } from './repair-actions';

const labels: Record<string, string> = {
  reported: 'Reported',
  investigating: 'Investigating',
  fixing: 'Preparing fix',
  testing: 'Testing',
  pr_open: 'PR ready to review',
  merged: 'Awaiting deployment',
  monitoring: 'Deployed · confirm fix',
  resolved: 'Resolved',
  blocked: 'Needs your attention',
  failed: 'Fix attempt failed',
  dismissed: 'Dismissed',
};
export interface RepairView {
  id: string;
  title: string;
  summary: string;
  status: string;
  diagnosis: string;
  lastError: string;
  sourceTaskId: string | null;
  prUrl: string | null;
  runUrl: string | null;
  history: { status: string; at: string; detail: string }[];
}
export function RepairPanel({
  overview,
}: {
  overview: { enabled: boolean; configured: boolean; dailyLimit: number; issues: RepairView[] };
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState('');
  const [showReport, setShowReport] = useState(false);
  const run = (fn: () => Promise<void>) => {
    setError('');
    startTransition(async () => {
      try {
        await fn();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not update improvement');
      }
    });
  };
  const open = overview.issues.filter((issue) => !['dismissed', 'resolved'].includes(issue.status));
  return (
    <section className="mt-8 space-y-4" aria-label="Code fixes">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Code fixes</h2>
          <p className="mt-1 text-sm text-muted">
            {overview.enabled && overview.configured
              ? `Automatic investigation is on. Up to ${overview.dailyLimit} coding runs per day; one active fix at a time.`
              : 'Automatic coding is not configured yet. Reports are saved for review.'}{' '}
            You review and merge every PR.
          </p>
        </div>
        <ActionButton onClick={() => setShowReport(!showReport)}>Report an issue</ActionButton>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {showReport && (
        <form
          className="space-y-3 rounded-2xl border border-border bg-surface p-4"
          action={(form) =>
            run(async () => {
              await reportRepairAction(form);
              setShowReport(false);
            })
          }
        >
          <label className="block text-sm">
            Issue title
            <input
              name="title"
              required
              minLength={3}
              maxLength={200}
              className="mt-1 block w-full rounded-lg border border-border bg-surface p-2"
            />
          </label>
          <label className="block text-sm">
            What went wrong
            <textarea
              name="summary"
              required
              minLength={5}
              maxLength={3000}
              rows={3}
              className="mt-1 block w-full rounded-lg border border-border bg-surface p-2"
            />
          </label>
          <label className="block text-sm">
            Failed task ID (optional)
            <input
              name="sourceTaskId"
              className="mt-1 block w-full rounded-lg border border-border bg-surface p-2"
            />
          </label>
          <button
            type="submit"
            disabled={pending}
            className="rounded-lg bg-strong px-4 py-2 text-sm text-surface disabled:opacity-50"
          >
            {pending ? 'Saving…' : 'Save report'}
          </button>
        </form>
      )}
      {open.length === 0 && (
        <p className="rounded-2xl border border-border p-4 text-sm text-muted">
          No active code fixes. Failed flows and your corrections appear here when automatic
          investigation is enabled.
        </p>
      )}
      {open.map((issue) => (
        <article
          key={issue.id}
          className="space-y-3 rounded-2xl border border-border bg-surface p-4"
        >
          <div className="text-xs font-medium text-muted">
            {labels[issue.status] ?? issue.status}
          </div>
          <h3 className="font-semibold">{issue.title}</h3>
          <p className="text-sm text-muted">{issue.diagnosis || issue.summary}</p>
          {issue.lastError && <p className="text-sm">{issue.lastError}</p>}
          <div className="flex flex-wrap items-center gap-3 text-sm">
            {issue.prUrl && (
              <a className="underline" href={issue.prUrl} target="_blank" rel="noreferrer">
                Review pull request ↗
              </a>
            )}
            {issue.sourceTaskId && (
              <a className="underline" href={`/audit/${issue.sourceTaskId}`}>
                View evidence
              </a>
            )}
            {issue.runUrl && (
              <a className="underline" href={issue.runUrl} target="_blank" rel="noreferrer">
                View coding run ↗
              </a>
            )}
            {['failed', 'blocked'].includes(issue.status) && (
              <ActionButton
                disabled={pending}
                onClick={() => run(() => repairDecisionAction(issue.id, 'retry'))}
              >
                Retry investigation
              </ActionButton>
            )}
            {issue.status === 'monitoring' && (
              <ActionButton
                disabled={pending}
                onClick={() => run(() => repairDecisionAction(issue.id, 'resolve'))}
              >
                Confirm fixed
              </ActionButton>
            )}
            {!['investigating', 'fixing', 'testing', 'pr_open'].includes(issue.status) && (
              <ActionButton
                disabled={pending}
                onClick={() => run(() => repairDecisionAction(issue.id, 'dismiss'))}
              >
                Dismiss
              </ActionButton>
            )}
          </div>
          <details className="text-xs text-muted">
            <summary className="cursor-pointer">Progress history</summary>
            <ol className="mt-2 space-y-1">
              {issue.history.map((entry) => (
                <li key={`${entry.at}-${entry.status}`}>
                  {labels[entry.status] ?? entry.status} · {new Date(entry.at).toLocaleString()}
                  {entry.detail ? ` · ${entry.detail}` : ''}
                </li>
              ))}
            </ol>
          </details>
        </article>
      ))}
      {overview.issues.some((issue) => issue.status === 'resolved') && (
        <p className="text-xs text-muted">
          {overview.issues.filter((issue) => issue.status === 'resolved').length} issue(s) confirmed
          fixed.
        </p>
      )}
    </section>
  );
}
