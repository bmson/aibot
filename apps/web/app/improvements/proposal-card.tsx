'use client';

import { useState, useTransition } from 'react';
import {
  applyProposalAction,
  dismissProposalAction,
  requestProposalCodeFixAction,
} from '@/app/improvements/actions';
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

export function ProposalCard({
  proposal,
  canRequestFix = false,
}: {
  proposal: ProposalView;
  canRequestFix?: boolean;
}) {
  const requestFix = !proposal.applyable && canRequestFix;
  const [error, setError] = useState('');
  const [pending, startTransition] = useTransition();
  const [pendingAction, setPendingAction] = useState<'apply' | 'dismiss' | null>(null);
  const runAction = (name: 'apply' | 'dismiss', action: () => Promise<unknown>) => {
    setError('');
    setPendingAction(name);
    startTransition(async () => {
      try {
        await action();
      } catch {
        setError('Could not complete this request. Please try again.');
      } finally {
        setPendingAction(null);
      }
    });
  };

  return (
    <article className={`${cardShellClass} flex h-full flex-col`}>
      {error && (
        <p role="alert" className="px-5 pt-4 text-sm text-red-600">
          {error}
        </p>
      )}
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
          pendingLabel={requestFix ? 'Queuing…' : 'Applying…'}
          onClick={() =>
            runAction('apply', () =>
              requestFix
                ? requestProposalCodeFixAction(proposal.id)
                : applyProposalAction(proposal.id),
            )
          }
          title={
            requestFix
              ? 'Create a code-fix report for automatic investigation'
              : proposal.applyable
                ? 'Approve and enact this change'
                : 'Acknowledge this advisory suggestion'
          }
        >
          {requestFix ? 'Request code fix' : proposal.applyable ? 'Approve & apply' : 'Acknowledge'}
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
