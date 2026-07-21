'use client';

import { useTransition } from 'react';
import { applyProposalAction, dismissProposalAction } from '@/app/improvements/actions';
import { btn } from '@/lib/ui';

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

  return (
    <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
          {kindLabels[proposal.kind] ?? proposal.kind}
        </span>
        <span className="text-sm font-medium">{proposal.title}</span>
        <span className="ml-auto text-xs text-zinc-500 dark:text-zinc-500">
          {proposal.createdLabel}
        </span>
      </div>
      {proposal.rationale ? (
        <p className="mt-2 text-sm text-zinc-700 dark:text-zinc-300">{proposal.rationale}</p>
      ) : null}
      {proposal.suggestion ? (
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{proposal.suggestion}</p>
      ) : null}
      {proposal.evidenceCount > 0 ? (
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-500">
          From {proposal.evidenceCount} observed pattern
          {proposal.evidenceCount === 1 ? '' : 's'}.
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() => startTransition(() => applyProposalAction(proposal.id))}
          className={btn.primary}
          title={
            proposal.applyable
              ? 'Approve and enact this change'
              : 'Acknowledge this advisory suggestion'
          }
        >
          {proposal.applyable ? 'Approve & apply' : 'Acknowledge'}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => startTransition(() => dismissProposalAction(proposal.id))}
          className={btn.outline}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
