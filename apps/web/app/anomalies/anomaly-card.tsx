'use client';

import { useTransition } from 'react';
import { dismissAnomalyAction, suspendPolicyAction } from '@/app/anomalies/actions';
import { btn } from '@/lib/ui';

export interface AnomalyView {
  id: string;
  kind: string;
  toolName: string;
  detail: string;
  observed: number;
  expected: number;
  citationCount: number;
  hasPolicy: boolean;
  createdLabel: string;
}

const kindLabels: Record<string, string> = {
  burst: 'Burst',
  frequency: 'High frequency',
  off_hours: 'Off-hours',
};

const kindTone: Record<string, string> = {
  burst: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  frequency: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  off_hours: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300',
};

export function AnomalyCard({ anomaly }: { anomaly: AnomalyView }) {
  const [pending, startTransition] = useTransition();

  return (
    <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded-full px-2 py-0.5 text-2xs font-semibold uppercase tracking-wide ${
            kindTone[anomaly.kind] ??
            'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300'
          }`}
        >
          {kindLabels[anomaly.kind] ?? anomaly.kind}
        </span>
        <span className="font-mono text-xs text-zinc-600 dark:text-zinc-400">
          {anomaly.toolName}
        </span>
        <span className="ml-auto text-xs text-zinc-500 dark:text-zinc-500">
          {anomaly.createdLabel}
        </span>
      </div>
      <p className="mt-2 text-sm text-zinc-800 dark:text-zinc-200">{anomaly.detail}</p>
      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-500">
        Cites {anomaly.citationCount} tool call{anomaly.citationCount === 1 ? '' : 's'}.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {anomaly.hasPolicy ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => startTransition(() => suspendPolicyAction(anomaly.id))}
            className={btn.danger}
            title="Pause the policy behind this — its matching actions will park for your approval instead of auto-executing"
          >
            Suspend policy
          </button>
        ) : null}
        <button
          type="button"
          disabled={pending}
          onClick={() => startTransition(() => dismissAnomalyAction(anomaly.id))}
          className={btn.outline}
          title="Dismiss as a false positive — this level stops re-flagging for this policy"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
