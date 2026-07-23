import { getAgent, listOpenProposals } from '@assistant/core';
import { ProposalCard, type ProposalView } from '@/app/improvements/proposal-card';
import { requireOwner } from '@/auth';
import { relativeTime } from '@/lib/format';
import { getDb } from '@/lib/server';
import { EmptyState, PageHeader } from '@/lib/ui';

export const metadata = { title: 'Improvements' };

export const dynamic = 'force-dynamic';

export default async function ImprovementsPage() {
  await requireOwner();
  const db = getDb();
  const now = new Date();
  const agent = await getAgent(db);
  const rows = await listOpenProposals(db, agent.id);

  const proposals: ProposalView[] = rows.map((p) => {
    const change = (p.change ?? {}) as { suggestion?: unknown };
    return {
      id: p.id,
      kind: p.kind,
      title: p.title,
      rationale: p.rationale,
      suggestion: typeof change.suggestion === 'string' ? change.suggestion : '',
      evidenceCount: p.evidenceIds.length,
      applyable: p.kind === 'model_role',
      createdLabel: relativeTime(p.createdAt, now),
    };
  });

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Improvements"
        intro="Changes the assistant proposes for itself after reviewing its own failures, retries, and costs — a model swap, a suggested rule, or an observation. Nothing is applied automatically: approve what helps, dismiss the rest."
      />
      <section className="mt-8">
        {proposals.length === 0 ? (
          <EmptyState>
            No open proposals. The nightly review surfaces suggestions here when it spots a pattern.
          </EmptyState>
        ) : (
          <div className="flex flex-col gap-3">
            {proposals.map((proposal) => (
              <ProposalCard key={proposal.id} proposal={proposal} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
