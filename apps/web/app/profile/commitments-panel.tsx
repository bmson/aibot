import type { CommitmentView } from '@assistant/application/commitments';
import { Check, Clock3, X } from 'lucide-react';
import {
  correctCommitmentFormAction,
  dismissCommitmentAction,
  resolveCommitmentAction,
  snoozeCommitmentAction,
} from '@/app/profile/actions';
import { btn, cardShellClass, focusRing, inputClass, microLabelClass } from '@/lib/ui';

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
                <p className={`${microLabelClass} text-muted`}>{row.kind}</p>
                <p className="mt-1 text-sm font-medium text-strong">{row.title}</p>
                {row.nextAction ? (
                  <p className="mt-1 text-xs text-muted">Next: {row.nextAction}</p>
                ) : null}
              </div>
              <details className="text-xs">
                <summary
                  className={`w-fit cursor-pointer rounded text-muted hover:text-strong ${focusRing}`}
                >
                  Correct this loop
                </summary>
                <form
                  action={correctCommitmentFormAction.bind(null, row.id)}
                  className="mt-2 grid gap-2 sm:grid-cols-3"
                >
                  <input
                    className={inputClass}
                    name="title"
                    defaultValue={row.title}
                    aria-label="Commitment title"
                    required
                    maxLength={180}
                  />
                  <input
                    className={inputClass}
                    name="details"
                    defaultValue={row.details}
                    placeholder="Details"
                    aria-label="Commitment details"
                    maxLength={500}
                  />
                  <div className="flex gap-2">
                    <input
                      className={`${inputClass} min-w-0 flex-1`}
                      name="nextAction"
                      defaultValue={row.nextAction}
                      placeholder="Next action"
                      aria-label="Next action"
                      maxLength={240}
                    />
                    <button type="submit" className={btn.primary}>
                      Save changes
                    </button>
                  </div>
                </form>
              </details>
              <div className="flex flex-wrap gap-2">
                <form action={resolveCommitmentAction.bind(null, row.id)}>
                  <button type="submit" className={btn.success}>
                    <Check className="size-3.5" aria-hidden="true" /> Done
                  </button>
                </form>
                <form action={snoozeCommitmentAction.bind(null, row.id)}>
                  <button type="submit" className={btn.outline}>
                    <Clock3 className="size-3.5" aria-hidden="true" /> Later
                  </button>
                </form>
                <form action={dismissCommitmentAction.bind(null, row.id)}>
                  <button type="submit" className={btn.dangerOutline}>
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
