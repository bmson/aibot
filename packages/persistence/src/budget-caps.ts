/** Owner-scoped writes to the live cost policy and default task cap. */
export interface BudgetCapsRepository {
  readonly kind: 'budget-caps-repository';
  update(
    agentId: string,
    values: Partial<Record<'task_default' | 'daily' | 'monthly', string>>,
  ): Promise<void>;
}
