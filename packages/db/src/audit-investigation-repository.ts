import {
  AUDIT_FIELDS,
  AUDIT_TASK_FIELDS,
  type AuditInvestigationRepository,
  type AuditReadInput,
} from '@assistant/persistence';
import { and, desc, eq, getTableColumns, lt, lte, or, sql } from 'drizzle-orm';
import type { AnyPgColumn, AnyPgTable } from 'drizzle-orm/pg-core';
import type { Db } from './client.js';
import {
  approvals,
  conversations,
  messages,
  modelCallAudit,
  modelCalls,
  recallMetrics,
  responseChecks,
  tasks,
  toolCalls,
} from './schema.js';

const tables = {
  toolCalls,
  modelCalls,
  modelCallAudit,
  approvals,
  messages,
  contextMessages: messages,
  responseChecks,
  recallMetrics,
};
function column(columns: Record<string, AnyPgColumn>, field: string): AnyPgColumn {
  const value = columns[field];
  if (!value) throw new Error(`Unknown audit column: ${field}`);
  return value;
}
function projection(table: AnyPgTable, fields: readonly string[]) {
  const columns = getTableColumns(table) as Record<string, AnyPgColumn>;
  return Object.fromEntries(fields.map((field) => [field, column(columns, field)])) as Record<
    string,
    AnyPgColumn
  >;
}
export function createPostgresAuditInvestigationRepository(db: Db): AuditInvestigationRepository {
  const task = async (agentId: string, taskId: string) => {
    const [row] = await db
      .select(projection(tasks, AUDIT_TASK_FIELDS))
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.agentId, agentId)));
    return (row as unknown as Awaited<ReturnType<AuditInvestigationRepository['task']>>) ?? null;
  };
  return {
    task,
    async read(agentId: string, taskId: string, input: AuditReadInput) {
      const ownerTask = await task(agentId, taskId);
      if (!ownerTask) return [];
      const table = tables[input.section];
      const columns = getTableColumns(table) as Record<string, AnyPgColumn>;
      const time = column(columns, input.section === 'approvals' ? 'requestedAt' : 'createdAt');
      const orderedTime = sql`date_trunc('milliseconds', ${time})`;
      let scope: ReturnType<typeof and> = eq(column(columns, 'taskId'), taskId);
      if (input.section === 'contextMessages') {
        if (!ownerTask.conversationId) return [];
        const [conversation] = await db
          .select({ id: conversations.id })
          .from(conversations)
          .where(
            and(eq(conversations.id, ownerTask.conversationId), eq(conversations.agentId, agentId)),
          );
        if (!conversation) return [];
        scope = and(
          eq(messages.conversationId, conversation.id),
          lte(messages.createdAt, ownerTask.createdAt),
        );
      }
      const rows = await db
        .select(projection(table, AUDIT_FIELDS[input.section]))
        .from(table)
        .where(
          and(
            scope,
            input.entryId ? eq(column(columns, 'id'), input.entryId) : undefined,
            input.cursor
              ? or(
                  lt(orderedTime, input.cursor.at.toISOString()),
                  and(
                    eq(orderedTime, input.cursor.at.toISOString()),
                    lt(column(columns, 'id'), input.cursor.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(orderedTime), desc(column(columns, 'id')))
        .limit(input.entryId ? 1 : input.limit);
      return rows.map((row) => {
        const data = row as unknown as Record<string, unknown>;
        if (
          typeof data.id !== 'string' ||
          !(data[input.section === 'approvals' ? 'requestedAt' : 'createdAt'] instanceof Date)
        )
          throw new Error('Invalid audit row');
        return {
          id: data.id as string,
          at: data[input.section === 'approvals' ? 'requestedAt' : 'createdAt'] as Date,
          data,
        };
      });
    },
  };
}
