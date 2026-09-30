import { createHash } from 'node:crypto';
import {
  assertPrivacyErasureInactiveInTransaction,
  type InstallationStore,
} from '@assistant/firestore';
import type { Records } from '@assistant/persistence';
export async function ensureRepairSchedule(store: InstallationStore, agentId: string) {
  const h = createHash('sha256').update(`self-repair:${agentId}`).digest('hex');
  const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
  await store.db.runTransaction(async (tx) => {
    await assertPrivacyErasureInactiveInTransaction(tx, store, agentId);
    const owner = await tx.get(store.doc('agents', agentId));
    if (!owner.exists) throw new Error('Repair schedule owner is missing');
    const previous = await tx.get(
      store
        .collection('schedules')
        .where('agentId', '==', agentId)
        .where('name', '==', 'self-repair')
        .limit(1),
    );
    if (!previous.empty) return;
    const now = store.now();
    const row: Records['schedules'] = {
      id,
      agentId,
      name: 'self-repair',
      cron: '*/15 * * * *',
      taskTemplate: { type: 'scheduled', budgetUsdLimit: '0.50', job: 'self.repair' },
      enabled: true,
      nextRunAt: now,
      lastRunAt: null,
      createdAt: now,
      updatedAt: now,
    };
    tx.create(store.doc('schedules', id), row);
  });
}
