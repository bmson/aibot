import type { CommitmentView } from '@assistant/application/commitments';
import { Check, Clock3, X } from 'lucide-react';
import {
  correctCommitmentFormAction,
  dismissCommitmentAction,
  resolveCommitmentAction,
  snoozeCommitmentAction,
} from '@/app/profile/actions';
import { btn, cardShellClass } from '@/lib/ui';

export function CommitmentsPanel({ rows }: { rows: CommitmentView[] }) {
  return (
    <section className={`${cardShellClass} mt-8`}>
      <div className="border-b border-edge px-5 py-4 sm:px-6">
        <h2 className="text-lg font-semibold tracking-[-0.025em]">Open loops</h2>
        <p className="mt-1 text-sm leading-5 text-muted">
          Decisions, questions, and follow-ups the assistant may bring back when they are relevant.
        </p>
      </div>
      {rows.length === 0 ? (
        <p className="px-5 py-5 text-sm text-muted sm:px-6">
          Nothing is waiting for your attention.
        </p>
      ) : (
        <div className="divide-y divide-edge">
          {rows.map((row) => (
            <div key={row.id} className="flex flex-col gap-3 px-5 py-4 sm:px-6">
              <div>
                <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted">
                  {row.kind}
                </p>
                <p className="mt-1 text-sm font-medium text-strong">{row.title}</p>
                {row.nextAction ? (
                  <p className="mt-1 text-xs text-muted">Next: {row.nextAction}</p>
                ) : null}
              </div>
              <details className="text-xs">
                <summary className="cursor-pointer text-muted">Correct this loop</summary>
                <form
                  action={correctCommitmentFormAction.bind(null, row.id)}
                  className="mt-2 grid gap-2 sm:grid-cols-3"
                >
                  <input
                    className="rounded-lg border border-edge bg-raised px-2 py-1.5"
                    name="title"
                    defaultValue={row.title}
                    aria-label="Commitment title"
                  />
                  <input
                    className="rounded-lg border border-edge bg-raised px-2 py-1.5"
                    name="details"
                    defaultValue={row.details}
                    placeholder="Details"
                    aria-label="Commitment details"
                  />
                  <div className="flex gap-2">
                    <input
                      className="min-w-0 flex-1 rounded-lg border border-edge bg-raised px-2 py-1.5"
                      name="nextAction"
                      defaultValue={row.nextAction}
                      placeholder="Next action"
                      aria-label="Next action"
                    />
                    <button type="submit" className={btn.outline}>
                      Save
                    </button>
                  </div>
                </form>
              </details>
              <div className="flex flex-wrap gap-2">
                <form action={resolveCommitmentAction.bind(null, row.id)}>
                  <button type="submit" className={btn.outline}>
                    <Check className="size-3.5" aria-hidden="true" /> Done
                  </button>
                </form>
                <form action={snoozeCommitmentAction.bind(null, row.id)}>
                  <button type="submit" className={btn.outline}>
                    <Clock3 className="size-3.5" aria-hidden="true" /> Later
                  </button>
                </form>
                <form action={dismissCommitmentAction.bind(null, row.id)}>
                  <button type="submit" className={btn.outline}>
                    <X className="size-3.5" aria-hidden="true" /> Not relevant
                  </button>
                </form>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
