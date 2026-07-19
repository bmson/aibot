import { describe, expect, it } from 'vitest';
import { type BudgetSnapshot, evaluateBudget } from './budget.js';

const base: BudgetSnapshot = {
  taskLimitUsd: 0.25,
  taskSpentUsd: 0,
  dailyLimitUsd: 2,
  dailySpentUsd: 0,
  monthlyLimitUsd: 20,
  monthlySpentUsd: 0,
  softPct: 80,
};

describe('evaluateBudget', () => {
  it('allows the primary model when everything is under soft thresholds', () => {
    expect(evaluateBudget(base)).toEqual({ mode: 'primary' });
  });

  it('degrades to fallback at the soft threshold (task)', () => {
    const d = evaluateBudget({ ...base, taskSpentUsd: 0.2 }); // 80% of 0.25
    expect(d.mode).toBe('fallback');
  });

  it('degrades to fallback at the soft threshold (daily)', () => {
    const d = evaluateBudget({ ...base, dailySpentUsd: 1.6 });
    expect(d.mode).toBe('fallback');
  });

  it('parks when the task cap is exhausted', () => {
    const d = evaluateBudget({ ...base, taskSpentUsd: 0.25 });
    expect(d.mode).toBe('park');
    expect(d).toHaveProperty('reason');
  });

  it('park takes precedence over daily/monthly block', () => {
    const d = evaluateBudget({ ...base, taskSpentUsd: 1, dailySpentUsd: 5, monthlySpentUsd: 25 });
    expect(d.mode).toBe('park');
  });

  it('blocks when daily is exhausted even if the task has budget left', () => {
    const d = evaluateBudget({ ...base, dailySpentUsd: 2 });
    expect(d.mode).toBe('block');
  });

  it('blocks when monthly is exhausted', () => {
    const d = evaluateBudget({ ...base, monthlySpentUsd: 20 });
    expect(d.mode).toBe('block');
  });

  it('handles calls without task context (daily/monthly only)', () => {
    const noTask = { ...base, taskLimitUsd: undefined, taskSpentUsd: undefined };
    expect(evaluateBudget(noTask)).toEqual({ mode: 'primary' });
    expect(evaluateBudget({ ...noTask, dailySpentUsd: 2 }).mode).toBe('block');
  });

  it('a zero task cap parks immediately (nothing is free)', () => {
    expect(evaluateBudget({ ...base, taskLimitUsd: 0 }).mode).toBe('park');
  });

  it('degrades (not parks) a critical reply just over the task cap, within the carve-out', () => {
    // 0.25 < 0.26 < 0.275 (1.1x). Without the carve-out this parked and the
    // owner reply stranded in needs_attention; critical work degrades instead,
    // matching reserveCost's task-cap carve-out for critical deliveries.
    const d = evaluateBudget({ ...base, taskSpentUsd: 0.26 }, { critical: true });
    expect(d.mode).toBe('fallback');
  });

  it('still parks a non-critical task at its cap (the carve-out is critical-only)', () => {
    expect(evaluateBudget({ ...base, taskSpentUsd: 0.26 }).mode).toBe('park');
  });

  it('parks a critical reply once it passes the task-cap carve-out margin', () => {
    // 0.3 > 0.275 (1.1x of 0.25): even critical work must stop.
    expect(evaluateBudget({ ...base, taskSpentUsd: 0.3 }, { critical: true }).mode).toBe('park');
  });
});
