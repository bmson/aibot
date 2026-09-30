import {
  AUDIT_FIELDS,
  AUDIT_TASK_FIELDS,
  type AuditInvestigationRepository,
  type AuditReadInput,
  type AuditRow,
  type AuditTask,
} from '@assistant/persistence';
import { assertPrivacyErasureFenceUnchanged, readPrivacyErasureFence } from './privacy-erasure.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

export class FirestoreAuditInvestigationRepository implements AuditInvestigationRepository {
  constructor(readonly store: InstallationStore) {}
  async task(agentId: string, taskId: string): Promise<AuditTask | null> {
    const fence = await readPrivacyErasureFence(this.store, agentId);
    const snapshot = await this.store.doc('tasks', taskId).get();
    if (!snapshot.exists) return null;
    const data = decodeRecord<AuditTask>(snapshot.data());
    if (data.agentId !== agentId) return null;
    if (
      data.id !== taskId ||
      snapshot.id !== documentKey(taskId) ||
      !(data.createdAt instanceof Date)
    )
      throw new Error('Invalid audit task');
    await assertPrivacyErasureFenceUnchanged(this.store, agentId, fence);
    return Object.fromEntries(AUDIT_TASK_FIELDS.map((field) => [field, data[field]])) as AuditTask;
  }
  async read(agentId: string, taskId: string, input: AuditReadInput): Promise<AuditRow[]> {
    const fence = await readPrivacyErasureFence(this.store, agentId);
    const task = await this.task(agentId, taskId);
    if (!task) return [];
    const context = input.section === 'contextMessages';
    if (context) {
      if (!task.conversationId) return [];
      const conversation = await this.store.doc('conversations', task.conversationId).get();
      if (!conversation.exists || conversation.get('agentId') !== agentId) return [];
    }
    const collection = context ? 'messages' : input.section;
    const time = input.section === 'approvals' ? 'requestedAt' : 'createdAt';
    if (input.entryId) {
      const doc = await this.store.doc(collection, input.entryId).get();
      if (!doc.exists) return [];
      const data = decodeRecord<Record<string, unknown>>(doc.data());
      if (data.id !== input.entryId || !(data[time] instanceof Date))
        throw new Error('Invalid audit entry');
      if (
        context
          ? data.conversationId !== task.conversationId || (data.createdAt as Date) > task.createdAt
          : data.taskId !== taskId
      )
        return [];
      await assertPrivacyErasureFenceUnchanged(this.store, agentId, fence);
      return [
        {
          id: input.entryId,
          at: data[time] as Date,
          data: Object.fromEntries(
            AUDIT_FIELDS[input.section].map((field) => [field, data[field]]),
          ),
        },
      ];
    }
    let query = this.store
      .collection(collection)
      .where(context ? 'conversationId' : 'taskId', '==', context ? task.conversationId : taskId)
      .select(...AUDIT_FIELDS[input.section], 'taskId');
    if (context) query = query.where('createdAt', '<=', task.createdAt);
    query = query.orderBy(time, 'desc').orderBy('id', 'desc');
    if (input.cursor) query = query.startAfter(input.cursor.at, input.cursor.id);
    const snapshot = await query.limit(input.entryId ? 1 : input.limit).get();
    const rows = snapshot.docs.map((doc) => {
      const data = decodeRecord<Record<string, unknown>>(doc.data());
      if (
        typeof data.id !== 'string' ||
        documentKey(data.id) !== doc.id ||
        !(data[time] instanceof Date) ||
        (!context && data.taskId !== taskId)
      )
        throw new Error('Invalid audit entry');
      return {
        id: data.id,
        at: data[time] as Date,
        data: Object.fromEntries(AUDIT_FIELDS[input.section].map((field) => [field, data[field]])),
      };
    });
    await assertPrivacyErasureFenceUnchanged(this.store, agentId, fence);
    return rows;
  }
}
