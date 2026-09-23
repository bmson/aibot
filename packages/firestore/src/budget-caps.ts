import type { BudgetCapsRepository } from '@assistant/persistence';
import { microsToUsd, usdToMicros } from '@assistant/persistence';
import { privacyErasureIsActive } from './privacy-erasure.js';
import { documentKey, type InstallationStore } from './store.js';

/** Mutates the same policy document read by cost reservations, atomically. */
export class FirestoreBudgetCapsRepository implements BudgetCapsRepository {
  readonly kind = 'budget-caps-repository' as const;

  constructor(readonly store: InstallationStore) {}

  async update(
    agentId: string,
    values: Partial<Record<'task_default' | 'daily' | 'monthly', string>>,
  ): Promise<void> {
    if (!agentId) throw new Error('Budget caps require a configured agent');
    if (
      Object.values(values).some(
        (value) =>
          typeof value !== 'string' ||
          !/^(?:0|[1-9]\d*)\.\d{2}$/.test(value) ||
          Number(value) > 10_000,
      )
    )
      throw new Error('Budget caps must be normalized, nonnegative USD amounts');
    await this.store.db.runTransaction(async (tx) => {
      const agents = await tx.get(this.store.collection('agents').limit(2));
      const agent = agents.docs[0];
      if (
        agents.size !== 1 ||
        !agent ||
        agent.id !== documentKey(agentId) ||
        agent.get('id') !== agentId
      )
        throw new Error('Budget caps require one matching configured owner');

      const erasure = await tx.get(this.store.doc('privacyErasureJobs', agentId));
      if (
        erasure.exists &&
        (erasure.get('agentId') !== agentId ||
          privacyErasureIsActive(erasure.get('status')) ||
          !erasure.updateTime)
      )
        throw new Error('Privacy erasure is in progress');

      const policyRef = this.store.doc('coordination', 'budget-policy');
      const taskRef = this.store.doc('budgets', 'task_default');
      const [policy, task] = await tx.getAll(policyRef, taskRef);
      if (!policy?.exists) throw new Error('Budget policy must be initialized');
      microsToUsd(policy.get('dailyLimitMicros'));
      microsToUsd(policy.get('monthlyLimitMicros'));
      const softPct = policy.get('softPct');
      if (!Number.isInteger(softPct) || softPct < 0 || softPct > 100)
        throw new Error('Budget policy is malformed');
      if (
        values.task_default !== undefined &&
        (!task?.exists ||
          task.get('scope') !== 'task_default' ||
          typeof task.get('limitUsd') !== 'string')
      )
        throw new Error('Default task cap is malformed');

      const now = this.store.now();
      const policyUpdate: Record<string, unknown> = {};
      if (values.daily !== undefined)
        policyUpdate.dailyLimitMicros = usdToMicros(Number(values.daily));
      if (values.monthly !== undefined)
        policyUpdate.monthlyLimitMicros = usdToMicros(Number(values.monthly));
      if (Object.keys(policyUpdate).length)
        tx.update(policyRef, { ...policyUpdate, updatedAt: now });
      if (values.task_default !== undefined)
        tx.update(taskRef, { limitUsd: values.task_default, updatedAt: now });
    });
  }
}
