'use client';

import { LoaderCircle } from 'lucide-react';
import { useState, useTransition } from 'react';
import { applyProposalAction, dismissProposalAction } from '@/app/improvements/actions';
import {
  Badge,
  btn,
  cardBodyClass,
  cardFooterClass,
  cardHeaderClass,
  cardShellClass,
  cardTitleClass,
} from '@/lib/ui';

export interface ProposalView {
  id: string;
  kind: string;
  title: string;
  rationale: string;
  suggestion: string;
  evidenceCount: number;
  applyable: boolean;
  createdLabel: string;
}

const kindLabels: Record<string, string> = {
  model_role: 'Model swap',
  policy: 'Policy',
  prompt: 'Prompt',
  note: 'Note',
};

export function ProposalCard({ proposal }: { proposal: ProposalView }) {
  const [pending, startTransition] = useTransition();
  const [pendingAction, setPendingAction] = useState<'apply' | 'dismiss' | null>(null);
  const runAction = (name: 'apply' | 'dismiss', action: () => Promise<unknown>) => {
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
            <Badge tone="neutral" uppercase>
              {kindLabels[proposal.kind] ?? proposal.kind}
            </Badge>
            <h3 className={`mt-2 ${cardTitleClass}`}>{proposal.title}</h3>
          </div>
          <span className="shrink-0 text-xs text-muted">{proposal.createdLabel}</span>
        </div>
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          {proposal.rationale ? (
            <section className="min-w-0">
              <h4 className="text-2xs font-semibold tracking-[0.08em] text-muted uppercase">
                Why this came up
              </h4>
              <p className="mt-1 text-[13px] leading-5 text-strong">{proposal.rationale}</p>
            </section>
          ) : null}
          {proposal.suggestion ? (
            <section className="min-w-0 rounded-xl bg-sunken/65 px-3 py-2.5">
              <h4 className="text-2xs font-semibold tracking-[0.08em] text-muted uppercase">
                Proposed change
              </h4>
              <p className="mt-1 text-[13px] leading-5 text-strong">{proposal.suggestion}</p>
            </section>
          ) : null}
        </div>
        <p className="flex flex-wrap gap-x-2 gap-y-0.5 text-xs leading-5 text-muted">
          <span className="whitespace-nowrap">
            Based on {proposal.evidenceCount} pattern{proposal.evidenceCount === 1 ? '' : 's'}
          </span>
          <span aria-hidden="true" className="text-muted/60">
            ·
          </span>
          <span className="whitespace-nowrap">
            {proposal.applyable ? 'Can apply directly' : 'Advisory'}
          </span>
        </p>
      </div>
      <footer className={cardFooterClass}>
        <button
          type="button"
          disabled={pending}
          onClick={() => runAction('apply', () => applyProposalAction(proposal.id))}
          className={btn.primary}
          title={
            proposal.applyable
              ? 'Approve and enact this change'
              : 'Acknowledge this advisory suggestion'
          }
        >
          {pendingAction === 'apply' ? (
            <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" />
          ) : null}
          {pendingAction === 'apply'
            ? 'Applying…'
            : proposal.applyable
              ? 'Approve & apply'
              : 'Acknowledge'}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => runAction('dismiss', () => dismissProposalAction(proposal.id))}
          className={btn.outline}
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
