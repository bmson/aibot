'use client';

import { useState, useTransition } from 'react';
import { applyProposalAction, dismissProposalAction } from '@/app/improvements/actions';
import {
  Badge,
  cardBodyClass,
  cardFooterClass,
  cardHeaderClass,
  cardShellClass,
  cardTitleClass,
  MetaLine,
} from '@/lib/ui';
import { ActionButton } from '@/lib/ui-client';

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
              <h4 className="font-mono text-xs font-medium tracking-[0.08em] text-muted uppercase">
                Why this came up
              </h4>
              <p className="mt-1 text-sm leading-5 text-strong">{proposal.rationale}</p>
            </section>
          ) : null}
          {proposal.suggestion ? (
            <section className="min-w-0 rounded-xl bg-sunken/65 px-3 py-2.5">
              <h4 className="font-mono text-xs font-medium tracking-[0.08em] text-muted uppercase">
                Proposed change
              </h4>
              <p className="mt-1 text-sm leading-5 text-strong">{proposal.suggestion}</p>
            </section>
          ) : null}
        </div>
        <MetaLine
          segments={[
            `Based on ${proposal.evidenceCount} pattern${proposal.evidenceCount === 1 ? '' : 's'}`,
            proposal.applyable ? 'Can apply directly' : 'Advisory',
          ]}
        />
      </div>
      <footer className={cardFooterClass}>
        <ActionButton
          variant="primary"
          disabled={pending}
          pending={pendingAction === 'apply'}
          pendingLabel="Applying…"
          onClick={() => runAction('apply', () => applyProposalAction(proposal.id))}
          title={
            proposal.applyable
              ? 'Approve and enact this change'
              : 'Acknowledge this advisory suggestion'
          }
        >
          {proposal.applyable ? 'Approve & apply' : 'Acknowledge'}
        </ActionButton>
        <ActionButton
          disabled={pending}
          pending={pendingAction === 'dismiss'}
          pendingLabel="Dismissing…"
          onClick={() => runAction('dismiss', () => dismissProposalAction(proposal.id))}
        >
          Dismiss
        </ActionButton>
      </footer>
    </article>
  );
}
