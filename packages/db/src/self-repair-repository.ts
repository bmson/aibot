import { randomUUID } from 'node:crypto';
import {
  queuedRepairIssues,
  type RepairIssue,
  repairFailureKey,
  repairQueueReady,
  repairTransition,
  type SelfRepairRepository,
} from '@assistant/persistence';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { conversations, selfRepairIssues, tasks } from './schema.js';

export function createPostgresSelfRepairRepository(db: Db): SelfRepairRepository {
  return {
    async report(agentId, input) {
      if (input.sourceTaskId) {
        const [task] = await db
          .select({ id: tasks.id })
          .from(tasks)
          .where(and(eq(tasks.id, input.sourceTaskId), eq(tasks.agentId, agentId)));
        if (!task) throw new Error('Repair evidence task is outside the owner');
      }
      if (input.conversationId) {
        const [chat] = await db
          .select({ id: conversations.id })
          .from(conversations)
          .where(
            and(eq(conversations.id, input.conversationId), eq(conversations.agentId, agentId)),
          );
        if (!chat) throw new Error('Repair conversation is outside the owner');
      }
      const now = new Date();
      await db
        .insert(selfRepairIssues)
        .values({
          id: randomUUID(),
          agentId,
          fingerprint: input.fingerprint,
          data: { ...input, history: [{ status: 'reported', at: now.toISOString(), detail: '' }] },
        })
        .onConflictDoNothing();
      const [row] = await db
        .select()
        .from(selfRepairIssues)
        .where(
          and(
            eq(selfRepairIssues.agentId, agentId),
            eq(selfRepairIssues.fingerprint, input.fingerprint),
          ),
        );
      if (!row) throw new Error('Repair report was not saved');
      return row as RepairIssue;
    },
    async list(agentId) {
      const rows = (await db
        .select()
        .from(selfRepairIssues)
        .where(eq(selfRepairIssues.agentId, agentId))
        .orderBy(selfRepairIssues.createdAt)
        .limit(1001)) as RepairIssue[];
      if (rows.length > 1000) throw new Error('Repair ledger requires archival');
      return rows;
    },
    async claim(agentId, now, dailyLimit) {
      return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM agents WHERE id = ${agentId} FOR UPDATE`);
        const rows = (await tx
          .select()
          .from(selfRepairIssues)
          .where(eq(selfRepairIssues.agentId, agentId))
          .orderBy(selfRepairIssues.createdAt)
          .limit(1001)) as RepairIssue[];
        if (!repairQueueReady(rows, now, dailyLimit)) return null;
        const issue = queuedRepairIssues(rows)[0];
        if (!issue) return null;
        const next = repairTransition(issue, 'investigating', {}, now);
        await tx
          .update(selfRepairIssues)
          .set({ status: next.status, version: next.version, data: next.data, updatedAt: now })
          .where(eq(selfRepairIssues.id, issue.id));
        return next;
      });
    },
    async update(issue, status, patch, now) {
      const next = repairTransition(issue, status, patch, now);
      const [saved] = await db
        .update(selfRepairIssues)
        .set({ status, version: next.version, data: next.data, updatedAt: now })
        .where(
          and(
            eq(selfRepairIssues.id, issue.id),
            eq(selfRepairIssues.agentId, issue.agentId),
            eq(selfRepairIssues.version, issue.version),
          ),
        )
        .returning();
      return saved ? (saved as RepairIssue) : null;
    },
    async failures(agentId, since) {
      const rows = await db
        .select({
          taskId: tasks.id,
          title: tasks.title,
          state: tasks.state,
          updatedAt: tasks.updatedAt,
        })
        .from(tasks)
        .where(
          and(
            eq(tasks.agentId, agentId),
            inArray(tasks.status, ['failed', 'needs_attention']),
            gte(tasks.updatedAt, since),
          ),
        )
        .orderBy(desc(tasks.updatedAt))
        .limit(20);
      return rows.map((row) => ({
        taskId: row.taskId,
        title: row.title ?? 'Failed task',
        symptomKey: repairFailureKey(row.title ?? 'Failed task', row.state),
        observedAt: row.updatedAt.toISOString(),
      }));
    },
  };
}
