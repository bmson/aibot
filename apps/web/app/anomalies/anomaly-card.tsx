'use client';

import { LoaderCircle } from 'lucide-react';
import { useState, useTransition } from 'react';
import { dismissAnomalyAction, suspendPolicyAction } from '@/app/anomalies/actions';
import {
  Badge,
  type BadgeTone,
  btn,
  cardBodyClass,
  cardFooterClass,
  cardHeaderClass,
  cardShellClass,
  cardTitleClass,
  InfoGrid,
  InfoItem,
} from '@/lib/ui';
import { toolLabel } from '@/lib/views';

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

// Every anomaly is a "look at this" — color carries severity, not category.
const kindBadgeTone: Record<string, BadgeTone> = {
  burst: 'red',
  frequency: 'amber',
  off_hours: 'amber',
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
            <Badge tone={kindBadgeTone[anomaly.kind] ?? 'neutral'} uppercase>
              {kindLabels[anomaly.kind] ?? anomaly.kind}
            </Badge>
            <h3 className={`mt-2 truncate ${cardTitleClass}`}>{toolLabel(anomaly.toolName)}</h3>
            <p className="mt-0.5 truncate font-mono text-2xs text-muted">{anomaly.toolName}</p>
          </div>
          <span className="shrink-0 text-xs text-muted">{anomaly.createdLabel}</span>
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
