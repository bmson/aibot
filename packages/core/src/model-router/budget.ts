/**
 * Pure budget evaluation — the order matters and is part of the contract:
 * hard task cap → park (owner can grant more); hard daily/monthly → block
 * (read-only cheap mode); any soft threshold → degrade to fallback model.
 */

export interface BudgetSnapshot {
  /** Per-task cap; both undefined when the call has no task context. */
  taskLimitUsd?: number;
  taskSpentUsd?: number;
  dailyLimitUsd: number;
  dailySpentUsd: number;
  monthlyLimitUsd: number;
  monthlySpentUsd: number;
  /** Percentage (0-100) at which degradation kicks in. */
  softPct: number;
}

export type BudgetDecision =
  | { mode: 'primary' }
  | { mode: 'fallback'; reason: string }
  | { mode: 'park'; reason: string }
  | { mode: 'block'; reason: string };

export function evaluateBudget(s: BudgetSnapshot): BudgetDecision {
  if (s.taskLimitUsd !== undefined && (s.taskSpentUsd ?? 0) >= s.taskLimitUsd) {
    return {
      mode: 'park',
      reason: `task budget exhausted ($${(s.taskSpentUsd ?? 0).toFixed(4)} of $${s.taskLimitUsd.toFixed(4)})`,
    };
  }
  if (s.monthlySpentUsd >= s.monthlyLimitUsd) {
    return {
      mode: 'block',
      reason: `monthly budget exhausted ($${s.monthlySpentUsd.toFixed(2)} of $${s.monthlyLimitUsd.toFixed(2)})`,
    };
  }
  if (s.dailySpentUsd >= s.dailyLimitUsd) {
    return {
      mode: 'block',
      reason: `daily budget exhausted ($${s.dailySpentUsd.toFixed(2)} of $${s.dailyLimitUsd.toFixed(2)})`,
    };
  }

  const soft = (spent: number, limit: number) => limit > 0 && spent >= (limit * s.softPct) / 100;
  if (s.taskLimitUsd !== undefined && soft(s.taskSpentUsd ?? 0, s.taskLimitUsd)) {
    return { mode: 'fallback', reason: 'task budget above soft threshold' };
  }
  if (soft(s.dailySpentUsd, s.dailyLimitUsd)) {
    return { mode: 'fallback', reason: 'daily budget above soft threshold' };
  }
  if (soft(s.monthlySpentUsd, s.monthlyLimitUsd)) {
    return { mode: 'fallback', reason: 'monthly budget above soft threshold' };
  }
  return { mode: 'primary' };
}
