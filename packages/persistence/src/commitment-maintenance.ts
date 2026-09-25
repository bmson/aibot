import type { Records } from './records.js';

const DAY_MS = 24 * 3600 * 1000;

/**
 * How long a loop may sit untouched before it leaves the desk. The windows
 * differ because the kinds decay differently: a month of silence on a question
 * or on someone else's reply is its own answer, while a decision is a record
 * rather than a task and is worth keeping visible for a quarter.
 */
export const COMMITMENT_STALE_AFTER_DAYS: Readonly<Record<string, number>> = {
  question: 30,
  waiting_on: 30,
  promise: 45,
  decision: 90,
};

/**
 * A loop that named its own date and blew through it by a fortnight was not
 * kept, whatever its kind — waiting out the idle window would only keep a dead
 * commitment on the list for another month.
 */
export const COMMITMENT_STALE_AFTER_DUE_DAYS = 14;

type StaleCandidate = Pick<
  Records['commitments'],
  'kind' | 'status' | 'updatedAt' | 'dueAt' | 'snoozedUntil'
>;

/**
 * Whether the open-loop sweep retires this commitment now. Only open loops and
 * snoozes that have run out are eligible; a closed loop is never reopened or
 * restamped. This is the portable statement of the PostgreSQL sweep's filter.
 */
export function commitmentIsStale(row: StaleCandidate, now: Date): boolean {
  const eligible =
    row.status === 'open' ||
    (row.status === 'snoozed' && row.snoozedUntil !== null && row.snoozedUntil < now);
  if (!eligible) return false;
  const idleDays = COMMITMENT_STALE_AFTER_DAYS[row.kind];
  const idle =
    idleDays !== undefined && row.updatedAt < new Date(now.getTime() - idleDays * DAY_MS);
  const overdue =
    row.dueAt !== null &&
    row.dueAt < new Date(now.getTime() - COMMITMENT_STALE_AFTER_DUE_DAYS * DAY_MS);
  return idle || overdue;
}

/** The `memory.sweep_loops` job: retire idle and long-overdue open loops. */
export interface CommitmentMaintenanceRepository {
  readonly kind: 'commitment-maintenance-repository';
  /** Returns how many commitments this call moved to `stale`. */
  markStale(agentId: string, now: Date): Promise<number>;
}
