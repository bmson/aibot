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
import { requestCodeFixAction } from './code-fix-action';

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
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const runAction = (name: string, action: () => Promise<unknown>) => {
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
          {[
            ['Why this came up', proposal.rationale, 'min-w-0'],
            ['Proposed change', proposal.suggestion, 'min-w-0 rounded-xl bg-sunken/65 px-3 py-2.5'],
          ].map(([label, text, className]) =>
            text ? (
              <section key={label} className={className}>
                <h4 className="font-mono text-xs font-medium tracking-[0.08em] text-muted uppercase">
                  {label}
                </h4>
                <p className="mt-1 text-sm leading-5 text-strong">{text}</p>
              </section>
            ) : null,
          )}
        </div>
        <MetaLine
          segments={[
            `Based on ${proposal.evidenceCount} pattern${proposal.evidenceCount === 1 ? '' : 's'}`,
            proposal.applyable ? 'Can apply directly' : 'Advisory',
          ]}
        />
      </div>
      <footer className={cardFooterClass}>
        {[
          {
            name: 'apply',
            label: proposal.applyable ? 'Approve & apply' : 'Acknowledge',
            pendingLabel: 'Applying…',
            title: proposal.applyable
              ? 'Approve and enact this change'
              : 'Acknowledge this advisory suggestion',
            action: applyProposalAction,
          },
          {
            name: 'fix',
            label: 'Request code fix',
            pendingLabel: 'Requesting…',
            action: requestCodeFixAction,
          },
          {
            name: 'dismiss',
            label: 'Dismiss',
            pendingLabel: 'Dismissing…',
            action: dismissProposalAction,
          },
        ].map(({ name, label, pendingLabel, action, title }) => (
          <ActionButton
            key={name}
            title={title}
            variant={name === 'apply' ? 'primary' : 'outline'}
            disabled={pending}
            pending={pendingAction === name}
            pendingLabel={pendingLabel}
            onClick={() => runAction(name, () => action(proposal.id))}
          >
            {label}
          </ActionButton>
        ))}
      </footer>
    </article>
  );
}
