'use client';

import { LoaderCircle } from 'lucide-react';
import { useState, useTransition } from 'react';
import { dismissAnomalyAction, suspendPolicyAction } from '@/app/anomalies/actions';
import {
  btn,
  cardBodyClass,
  cardFooterClass,
  cardHeaderClass,
  cardShellClass,
  InfoGrid,
  InfoItem,
} from '@/lib/ui';

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
  const [pendingAction, setPendingAction] = useState<'suspend' | 'dismiss' | null>(null);
  const runAction = (name: 'suspend' | 'dismiss', action: () => Promise<unknown>) => {
    setPendingAction(name);
    startTransition(async () => {
      try {
        await action();
      } finally {
        setPendingAction(null);
      }
    });
  };

  return (
    <article className={`${cardShellClass} flex h-full flex-col`}>
      <div className={`${cardBodyClass} flex-1`}>
        <div className={cardHeaderClass}>
          <div className="min-w-0">
            <span
              className={`rounded-full px-2 py-0.5 text-2xs font-semibold tracking-wide uppercase ${
                kindTone[anomaly.kind] ??
                'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300'
              }`}
            >
              {kindLabels[anomaly.kind] ?? anomaly.kind}
            </span>
            <h3 className="mt-2 truncate font-mono text-xs font-medium text-strong">
              {anomaly.toolName}
            </h3>
          </div>
          <span className="text-xs text-muted">{anomaly.createdLabel}</span>
        </div>
        <p className="text-[14px] leading-6 text-strong">{anomaly.detail}</p>
        <InfoGrid columns={3}>
          <InfoItem label="Observed">{anomaly.observed}</InfoItem>
          <InfoItem label="Expected">{anomaly.expected}</InfoItem>
          <InfoItem label="Evidence">{anomaly.citationCount} calls</InfoItem>
        </InfoGrid>
      </div>
      <footer className={cardFooterClass}>
        {anomaly.hasPolicy ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => runAction('suspend', () => suspendPolicyAction(anomaly.id))}
            className={btn.danger}
            title="Pause the policy behind this — its matching actions will park for your approval instead of auto-executing"
          >
            {pendingAction === 'suspend' ? (
              <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" />
            ) : null}
            {pendingAction === 'suspend' ? 'Updating…' : 'Suspend policy'}
          </button>
        ) : null}
        <button
          type="button"
          disabled={pending}
          onClick={() => runAction('dismiss', () => dismissAnomalyAction(anomaly.id))}
          className={btn.outline}
          title="Dismiss as a false positive — this level stops re-flagging for this policy"
        >
          {pendingAction === 'dismiss' ? (
            <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" />
          ) : null}
          {pendingAction === 'dismiss' ? 'Updating…' : 'Dismiss'}
        </button>
      </footer>
    </article>
  );
}
