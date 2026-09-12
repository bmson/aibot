import type {
  ApprovedToolCall,
  CachedToolCallInput,
  ClaimApprovedToolCallInput,
  ToolExecutionOutcome,
  ToolExecutionRepository,
} from '@assistant/persistence';
import { and, eq, lte, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import {
  approvals,
  contacts,
  conversations,
  messages,
  rateLimits,
  tasks,
  toolCache,
  toolCalls,
} from './schema.js';

async function load(
  db: Db,
  agentId: string,
  taskId: string,
  toolCallId: string,
): Promise<ApprovedToolCall | null> {
  const [row] = await db
    .select({ toolCall: toolCalls, task: tasks, approval: approvals })
    .from(toolCalls)
    .innerJoin(tasks, and(eq(toolCalls.taskId, tasks.id), eq(tasks.agentId, agentId)))
    .leftJoin(approvals, eq(toolCalls.approvalId, approvals.id))
    .where(and(eq(toolCalls.id, toolCallId), eq(toolCalls.taskId, taskId)))
    .limit(1);
  if (!row) return null;
  if (row.toolCall.approvalId && !row.approval) return null;
  if (
    row.approval &&
    (row.approval.toolCallId !== row.toolCall.id ||
      row.approval.taskId !== row.task.id ||
      row.approval.status !== 'approved')
  )
    return null;
  return row;
}

export function createPostgresToolExecutionRepository(db: Db): ToolExecutionRepository {
  return {
    kind: 'tool-execution-repository',
    load: (agentId, taskId, toolCallId) => load(db, agentId, taskId, toolCallId),
    claim: async (input: ClaimApprovedToolCallInput) =>
      db.transaction(async (tx) => {
        // Approval decisions lock the approval before its linked call; retain that lock order.
        await tx.execute(
          sql`select ${approvals.id} from ${approvals} where ${approvals.id} = (select ${toolCalls.approvalId} from ${toolCalls} where ${toolCalls.id} = ${input.toolCallId}) for update`,
        );
        await tx.execute(
          sql`select ${toolCalls.id} from ${toolCalls} where ${toolCalls.id} = ${input.toolCallId} for update`,
        );
        const current = await load(
          tx as unknown as Db,
          input.agentId,
          input.taskId,
          input.toolCallId,
        );
        if (current?.toolCall.status !== 'approved') return null;
        if (
          input.expectedApprovalId !== undefined &&
          current.toolCall.approvalId !== input.expectedApprovalId
        )
          return null;
        if (
          input.expectedResolutionPayload !== undefined &&
          JSON.stringify(current.approval?.resolutionPayload ?? null) !==
            JSON.stringify(input.expectedResolutionPayload)
        )
          return null;
        const [claimed] = await tx
          .update(toolCalls)
          .set({
            status: 'executing',
            args: input.args,
            decision: input.decision,
            startedAt: input.startedAt ?? sql`now()`,
          })
          .where(
            and(
              eq(toolCalls.id, input.toolCallId),
              eq(toolCalls.taskId, input.taskId),
              eq(toolCalls.status, 'approved'),
            ),
          )
          .returning({ id: toolCalls.id });
        return claimed
          ? {
              ...current,
              toolCall: {
                ...current.toolCall,
                ...claimed,
                status: 'executing',
                args: input.args,
                decision: input.decision,
              },
            }
          : null;
      }),
    outcome: async (input: ToolExecutionOutcome) => {
      if (!(await load(db, input.agentId, input.taskId, input.toolCallId))) return false;
      const [updated] = await db
        .update(toolCalls)
        .set({
          status: input.status,
          ...(input.result !== undefined ? { result: input.result } : {}),
          ...(input.error !== undefined ? { error: input.error } : {}),
          finishedAt: input.finishedAt ?? sql`now()`,
        })
        .where(
          and(
            eq(toolCalls.id, input.toolCallId),
            eq(toolCalls.taskId, input.taskId),
            input.fromStatus
              ? eq(toolCalls.status, input.fromStatus)
              : eq(toolCalls.status, 'executing'),
          ),
        )
        .returning({ id: toolCalls.id });
      return Boolean(updated);
    },
    contacts: () => db.select({ emails: contacts.emails, phones: contacts.phones }).from(contacts),
    underRateLimit: async (scope, toolName, now = new Date()) => {
      const [limit] = await db.select().from(rateLimits).where(eq(rateLimits.scope, scope));
      if (!limit) return true;
      const countSince = async (ms: number) => {
        const [row] = await db
          .select({ n: sql<number>`count(*)` })
          .from(toolCalls)
          .where(
            and(
              eq(toolCalls.toolName, toolName),
              eq(toolCalls.status, 'succeeded'),
              sql`${toolCalls.createdAt} >= ${new Date(now.getTime() - ms).toISOString()}::timestamptz`,
            ),
          );
        return Number(row?.n ?? 0);
      };
      if (limit.maxPerHour !== null && (await countSince(60 * 60_000)) >= limit.maxPerHour)
        return false;
      if (limit.maxPerDay !== null && (await countSince(24 * 60 * 60_000)) >= limit.maxPerDay)
        return false;
      return true;
    },
    cacheGet: async (cacheKey, now = new Date()) => {
      const [row] = await db
        .select({ result: toolCache.result })
        .from(toolCache)
        .where(
          and(
            eq(toolCache.cacheKey, cacheKey),
            sql`${toolCache.expiresAt} >= ${now.toISOString()}::timestamptz`,
          ),
        );
      return row ?? null;
    },
    cachePut: async (input) => {
      await db
        .insert(toolCache)
        .values({ ...input, result: input.result as Record<string, unknown> })
        .onConflictDoUpdate({
          target: toolCache.cacheKey,
          set: { result: input.result as Record<string, unknown>, expiresAt: input.expiresAt },
        });
    },
    start: async (input) => {
      const [task] = await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.id, input.taskId), eq(tasks.agentId, input.agentId)));
      if (!task) return null;
      const query = db
        .insert(toolCalls)
        .values({
          taskId: input.taskId,
          step: input.step,
          toolName: input.toolName,
          args: input.args,
          risk: 'autonomous',
          status: 'executing',
          idempotencyKey: input.idempotencyKey,
          decision: input.decision,
          startedAt: input.startedAt ?? new Date(),
        })
        .returning();
      const [row] = input.idempotencyKey
        ? await query.onConflictDoNothing({
            target: toolCalls.idempotencyKey,
            where: sql`${toolCalls.idempotencyKey} IS NOT NULL`,
          })
        : await query;
      return row ?? null;
    },
    findIdempotent: async (agentId, taskId, idempotencyKey) => {
      const [row] = await db
        .select({ call: toolCalls })
        .from(toolCalls)
        .innerJoin(tasks, and(eq(toolCalls.taskId, tasks.id), eq(tasks.agentId, agentId)))
        .where(and(eq(toolCalls.idempotencyKey, idempotencyKey), eq(toolCalls.taskId, taskId)));
      return row?.call ?? null;
    },
    cached: async (input: CachedToolCallInput) => {
      const [task] = await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.id, input.taskId), eq(tasks.agentId, input.agentId)));
      if (!task) throw new Error('tool call task is not owned by agent');
      const [row] = await db
        .insert(toolCalls)
        .values({
          taskId: input.taskId,
          step: input.step,
          toolName: input.toolName,
          args: input.args,
          risk: 'autonomous',
          status: 'succeeded',
          idempotencyKey: input.idempotencyKey,
          decision: input.decision,
          result: input.result,
          startedAt: input.startedAt ?? new Date(),
          finishedAt: new Date(),
        })
        .returning();
      if (!row) throw new Error('failed to persist cached tool call');
      return row;
    },
    parentIsMission: async (agentId, parentTaskId) => {
      const [row] = await db
        .select({ type: tasks.type })
        .from(tasks)
        .where(and(eq(tasks.id, parentTaskId), eq(tasks.agentId, agentId)));
      return row?.type === 'mission';
    },
    conversationGoalId: async (agentId, conversationId) => {
      const [row] = await db
        .select({ metadata: conversations.metadata })
        .from(conversations)
        .where(and(eq(conversations.id, conversationId), eq(conversations.agentId, agentId)));
      const goalId = (row?.metadata as { goalId?: unknown } | null)?.goalId;
      return typeof goalId === 'string' ? goalId : null;
    },
    goalWorkEvidence: async (agentId, taskId) => {
      const rows = await db
        .select({
          toolName: toolCalls.toolName,
          status: toolCalls.status,
          result: toolCalls.result,
        })
        .from(toolCalls)
        .innerJoin(tasks, and(eq(toolCalls.taskId, tasks.id), eq(tasks.agentId, agentId)))
        .where(eq(toolCalls.taskId, taskId));
      return rows;
    },
    ownerMessageHistory: async (agentId, conversationId, before) => {
      const rows = await db
        .select({ text: messages.text })
        .from(messages)
        .innerJoin(conversations, eq(messages.conversationId, conversations.id))
        .where(
          and(
            eq(messages.conversationId, conversationId),
            eq(conversations.agentId, agentId),
            eq(conversations.channel, 'chat'),
            eq(conversations.trust, 'owner'),
            eq(messages.role, 'user'),
            eq(messages.origin, 'owner'),
            lte(messages.createdAt, before),
          ),
        )
        .orderBy(sql`${messages.createdAt} DESC`)
        .limit(4);
      return rows.reverse().map((row) => row.text);
    },
    searchResults: async (taskId) => {
      const rows = await db
        .select({ result: toolCalls.result })
        .from(toolCalls)
        .where(
          and(
            eq(toolCalls.taskId, taskId),
            eq(toolCalls.toolName, 'web.search'),
            eq(toolCalls.status, 'succeeded'),
          ),
        );
      return rows.map((row) => row.result);
    },
  };
}
