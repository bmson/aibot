import type {
  ExecutionEvidenceRecord,
  ExecutionEvidenceRepository,
  ResponseCheckInput,
} from '@assistant/persistence';
import { evidenceLimit, type Records } from '@assistant/persistence';
import { FieldPath } from '@google-cloud/firestore';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

function read<T>(snapshot: { exists: boolean; data(): unknown }, id?: string): T | null {
  if (!snapshot.exists) return null;
  const value = decodeRecord<T>(snapshot.data());
  return value &&
    typeof value === 'object' &&
    (id === undefined || (value as { id?: unknown }).id === id)
    ? value
    : null;
}

function evidence(row: Records['toolCalls']): ExecutionEvidenceRecord {
  return {
    id: row.id,
    toolName: row.toolName,
    status: row.status,
    args: row.args,
    result: row.result,
    error: row.error,
    step: row.step,
  };
}

function bounded<T>(rows: T[], max: number): T[] {
  if (rows.length > max) throw new Error(`Execution evidence exceeds the ${max}-row bound`);
  return rows;
}

async function ownedTask(store: InstallationStore, agentId: string, taskId: string) {
  const task = read<Records['tasks']>(await store.doc('tasks', taskId).get(), taskId);
  if (!task || task.agentId !== agentId)
    throw new Error('Execution evidence task is missing or outside the owner scope');
  return task;
}

export class FirestoreExecutionEvidenceRepository implements ExecutionEvidenceRepository {
  readonly kind = 'execution-evidence-repository' as const;

  constructor(readonly store: InstallationStore) {}

  async taskEvidence({
    agentId,
    taskId,
    maxRows,
  }: {
    agentId: string;
    taskId: string;
    maxRows?: number;
  }) {
    await ownedTask(this.store, agentId, taskId);
    const max = evidenceLimit(maxRows);
    const snapshot = await this.store
      .collection('toolCalls')
      .where('taskId', '==', taskId)
      .limit(max + 1)
      .get();
    const rows = snapshot.docs
      .map((doc) => {
        const row = read<Records['toolCalls']>(
          { exists: doc.exists, data: () => doc.data() },
          undefined,
        );
        if (!row || documentKey(row.id) !== doc.id)
          throw new Error('Execution evidence contains a corrupt tool-call identity');
        return row;
      })
      .sort(
        (a, b) =>
          a.step - b.step ||
          a.createdAt.getTime() - b.createdAt.getTime() ||
          a.id.localeCompare(b.id),
      );
    return bounded(rows.map(evidence), max);
  }

  async conversationEvidence({
    agentId,
    conversationId,
    excludeTaskId,
    maxRows,
  }: {
    agentId: string;
    conversationId: string;
    excludeTaskId: string;
    maxRows?: number;
  }) {
    const max = evidenceLimit(maxRows);
    const conversation = read<Records['conversations']>(
      await this.store.doc('conversations', conversationId).get(),
      conversationId,
    );
    if (!conversation || conversation.agentId !== agentId)
      throw new Error('Execution evidence conversation is missing or outside the owner scope');
    const excluded = await ownedTask(this.store, agentId, excludeTaskId);
    if (excluded.conversationId !== conversationId)
      throw new Error('Execution evidence task is outside the conversation scope');
    const toolRows: Records['toolCalls'][] = [];
    let taskCursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
    for (;;) {
      let taskQuery = this.store
        .collection('tasks')
        .where('conversationId', '==', conversationId)
        .orderBy(FieldPath.documentId())
        .limit(100);
      if (taskCursor) taskQuery = taskQuery.startAfter(taskCursor);
      const taskSnapshot = await taskQuery.get();
      for (const taskDoc of taskSnapshot.docs) {
        const task = read<Records['tasks']>({ exists: taskDoc.exists, data: () => taskDoc.data() });
        if (!task || documentKey(task.id) !== taskDoc.id)
          throw new Error('Execution evidence contains a corrupt task identity');
        if (task.agentId !== agentId || task.id === excludeTaskId) continue;
        const snapshot = await this.store
          .collection('toolCalls')
          .where('taskId', '==', task.id)
          .limit(max - toolRows.length + 1)
          .get();
        for (const doc of snapshot.docs) {
          const row = read<Records['toolCalls']>({ exists: doc.exists, data: () => doc.data() });
          if (!row || documentKey(row.id) !== doc.id)
            throw new Error('Execution evidence contains a corrupt tool-call identity');
          toolRows.push(row);
          if (toolRows.length > max)
            throw new Error(`Execution evidence exceeds the ${max}-row bound`);
        }
      }
      if (taskSnapshot.size < 100) break;
      taskCursor = taskSnapshot.docs.at(-1);
    }
    return toolRows
      .sort(
        (a, b) =>
          a.createdAt.getTime() - b.createdAt.getTime() ||
          a.step - b.step ||
          a.id.localeCompare(b.id),
      )
      .map(evidence);
  }

  async finalMessageExists({
    agentId,
    taskId,
    conversationId,
    text,
  }: {
    agentId: string;
    taskId: string;
    conversationId: string | null;
    text: string;
  }) {
    const task = await ownedTask(this.store, agentId, taskId);
    if (conversationId) {
      const conversation = read<Records['conversations']>(
        await this.store.doc('conversations', conversationId).get(),
        conversationId,
      );
      if (!conversation || conversation.agentId !== agentId)
        throw new Error('Execution final-message conversation is outside the owner scope');
      if (task.conversationId !== null && task.conversationId !== conversationId)
        throw new Error('Execution final-message conversation does not match its task');
    }
    let messageCursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
    for (;;) {
      let query = this.store
        .collection('messages')
        .where('taskId', '==', taskId)
        .orderBy(FieldPath.documentId())
        .limit(100);
      if (messageCursor) query = query.startAfter(messageCursor);
      const snapshot = await query.get();
      for (const doc of snapshot.docs) {
        const message = read<Records['messages']>({ exists: doc.exists, data: () => doc.data() });
        if (!message) throw new Error('Execution evidence contains a corrupt message record');
        if (documentKey(message.id) !== doc.id)
          throw new Error('Execution evidence contains a corrupt message identity');
        if (message.role !== 'assistant' || message.origin !== 'assistant' || message.text !== text)
          continue;
        if (conversationId && message.conversationId !== conversationId) continue;
        const conversation = read<Records['conversations']>(
          await this.store.doc('conversations', message.conversationId).get(),
          message.conversationId,
        );
        if (conversation?.agentId === agentId) return true;
      }
      if (snapshot.size < 100) return false;
      messageCursor = snapshot.docs.at(-1);
    }
  }

  async hasOutboundReply({ agentId, taskId }: { agentId: string; taskId: string }) {
    await ownedTask(this.store, agentId, taskId);
    const snapshot = await this.store
      .collection('toolCalls')
      .where('taskId', '==', taskId)
      .limit(51)
      .get();
    if (snapshot.size > 50) throw new Error('Execution outbound lookup exceeds its bound');
    return snapshot.docs.some((doc) => {
      const row = read<Records['toolCalls']>({ exists: doc.exists, data: () => doc.data() });
      if (!row || documentKey(row.id) !== doc.id)
        throw new Error('Execution evidence contains a corrupt tool-call identity');
      return row.toolName === 'gmail.send' || row.toolName === 'gmail.create_draft';
    });
  }

  async checklistDecisions({ agentId, taskId }: { agentId: string; taskId: string }) {
    await ownedTask(this.store, agentId, taskId);
    const snapshot = await this.store
      .collection('approvals')
      .where('taskId', '==', taskId)
      .limit(501)
      .get();
    const rows = snapshot.docs.map((doc) => {
      const row = read<Records['approvals']>({ exists: doc.exists, data: () => doc.data() });
      if (!row) throw new Error('Execution evidence contains a corrupt approval record');
      if (documentKey(row.id) !== doc.id)
        throw new Error('Execution evidence contains a corrupt approval identity');
      return row;
    });
    return bounded(
      rows.map((row) => ({ toolCallId: row.toolCallId, status: row.status })),
      500,
    );
  }

  async recordResponseCheck({ agentId, check }: { agentId: string; check: ResponseCheckInput }) {
    const ref = this.store.doc('responseChecks', check.taskId);
    return this.store.db.runTransaction(async (tx) => {
      const task = read<Records['tasks']>(
        await tx.get(this.store.doc('tasks', check.taskId)),
        check.taskId,
      );
      if (!task || task.agentId !== agentId)
        throw new Error('Execution evidence task is missing or outside the owner scope');
      const existing = await tx.get(ref);
      if (existing.exists) return false;
      tx.create(ref, encodeRecord({ id: check.taskId, createdAt: this.store.now(), ...check }));
      return true;
    });
  }
}

export function createFirestoreExecutionEvidenceRepository(
  store: InstallationStore,
): ExecutionEvidenceRepository {
  return new FirestoreExecutionEvidenceRepository(store);
}
