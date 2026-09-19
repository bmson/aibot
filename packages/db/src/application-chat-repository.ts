import { randomUUID } from 'node:crypto';
import type {
  ApplicationChatMessage,
  ApplicationChatPersistence,
  ApplicationChatSuggestion,
  TaskLease,
} from '@assistant/persistence';
import {
  boundedChatConversationLimit,
  boundedChatMessageLimit,
  newTaskRecord,
} from '@assistant/persistence';
import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  ne,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import type { Db } from './client.js';
import { createPostgresExecutionEvidenceRepository } from './execution-evidence-repository.js';
import {
  agents,
  approvals,
  budgets,
  conversations,
  goals,
  messages,
  models,
  suggestions,
  tasks,
  toolCalls,
} from './schema.js';
import { createPostgresTaskRepository } from './task-lifecycle-repository.js';

const TERMINAL_TASK_STATUSES = ['done', 'failed', 'cancelled'];
const GOAL_BLOCKED_PREFIX = 'Waiting on the owner:';
const DIRECT_CHAT_LEASE_MS = 10 * 60_000;

function conciseTitle(value: string | undefined): string | undefined {
  const title = value?.replace(/\s+/g, ' ').trim() ?? '';
  if (!title) return undefined;
  return title.length > 80 ? `${title.slice(0, 79)}…` : title;
}

function ownedConversationWhere(agentId: string, conversationId: string) {
  return and(
    eq(conversations.id, conversationId),
    eq(conversations.agentId, agentId),
    eq(conversations.channel, 'chat'),
  );
}

export function createPostgresApplicationChatPersistence(db: Db): ApplicationChatPersistence {
  async function owned(agentId: string, conversationId: string) {
    const [row] = await db
      .select()
      .from(conversations)
      .where(ownedConversationWhere(agentId, conversationId))
      .limit(1);
    return row ?? null;
  }

  return {
    kind: 'application-chat-persistence',

    async resolveAgent() {
      const [agent] = await db
        .select()
        .from(agents)
        .orderBy(asc(agents.createdAt), asc(agents.id))
        .limit(1);
      if (!agent) throw new Error('no agent row — run pnpm seed');
      return agent;
    },

    async createConversation(agentId) {
      const [created] = await db
        .insert(conversations)
        .values({ agentId, channel: 'chat', trust: 'owner' })
        .returning();
      if (!created) throw new Error('failed to create conversation');
      return created;
    },

    getConversation: owned,

    async listConversations(agentId, input) {
      const limit = boundedChatConversationLimit(input.limit);
      const rows = await db
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.agentId, agentId),
            eq(conversations.channel, 'chat'),
            input.archived ? isNotNull(conversations.archivedAt) : isNull(conversations.archivedAt),
            input.after
              ? or(
                  lt(conversations.updatedAt, input.after.updatedAt),
                  and(
                    eq(conversations.updatedAt, input.after.updatedAt),
                    lt(conversations.id, input.after.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(conversations.updatedAt), desc(conversations.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const tail = page.at(-1);
      return {
        conversations: page,
        hasMore: rows.length > limit,
        nextCursor: tail ? { updatedAt: tail.updatedAt, id: tail.id } : null,
      };
    },

    async countConversations(agentId, archived) {
      const [row] = await db
        .select({ value: count() })
        .from(conversations)
        .where(
          and(
            eq(conversations.agentId, agentId),
            eq(conversations.channel, 'chat'),
            archived ? isNotNull(conversations.archivedAt) : isNull(conversations.archivedAt),
          ),
        );
      return Number(row?.value ?? 0);
    },

    async listActiveConversationIds(agentId) {
      const rows = await db
        .selectDistinct({ conversationId: tasks.conversationId })
        .from(tasks)
        .where(
          and(
            eq(tasks.agentId, agentId),
            isNotNull(tasks.conversationId),
            notInArray(tasks.status, TERMINAL_TASK_STATUSES),
          ),
        );
      return rows.map((row) => row.conversationId).filter((id): id is string => id !== null);
    },

    async archiveConversation(agentId, conversationId) {
      const conversation = await owned(agentId, conversationId);
      if (!conversation) throw new Error('chat not found');
      if (conversation.isPrimary) return 'primary';
      const [active] = await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(
          and(
            eq(tasks.agentId, agentId),
            eq(tasks.conversationId, conversationId),
            notInArray(tasks.status, TERMINAL_TASK_STATUSES),
          ),
        )
        .limit(1);
      if (active) return 'active';
      await db
        .update(conversations)
        .set({ archivedAt: new Date(), updatedAt: new Date() })
        .where(
          and(ownedConversationWhere(agentId, conversationId), isNull(conversations.archivedAt)),
        );
      return 'archived';
    },

    async restoreConversation(agentId, conversationId) {
      const [row] = await db
        .update(conversations)
        .set({ archivedAt: null, updatedAt: new Date() })
        .where(
          and(ownedConversationWhere(agentId, conversationId), isNotNull(conversations.archivedAt)),
        )
        .returning({ id: conversations.id });
      return Boolean(row);
    },

    async archiveInactiveConversations(agentId, olderThan, requestedLimit) {
      const limit = boundedChatConversationLimit(requestedLimit ?? 100);
      const candidates = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            eq(conversations.agentId, agentId),
            eq(conversations.channel, 'chat'),
            eq(conversations.isPrimary, false),
            isNull(conversations.archivedAt),
            lt(conversations.updatedAt, olderThan),
          ),
        )
        .orderBy(desc(conversations.updatedAt), desc(conversations.id))
        .limit(limit);
      if (!candidates.length) return 0;
      const archived = await db
        .update(conversations)
        .set({ archivedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            inArray(
              conversations.id,
              candidates.map((candidate) => candidate.id),
            ),
            eq(conversations.agentId, agentId),
            isNull(conversations.archivedAt),
            sql`NOT EXISTS (
              SELECT 1 FROM ${tasks}
              WHERE ${tasks.conversationId} = ${conversations.id}
                AND ${tasks.agentId} = ${agentId}
                AND ${tasks.status} NOT IN ${TERMINAL_TASK_STATUSES}
            )`,
          ),
        )
        .returning({ id: conversations.id });
      return archived.length;
    },

    async setConversationModel(agentId, conversationId, modelId) {
      const [row] = await db
        .update(conversations)
        .set({ modelOverride: modelId, updatedAt: new Date() })
        .where(ownedConversationWhere(agentId, conversationId))
        .returning({ id: conversations.id });
      return Boolean(row);
    },

    async setConversationTitleIfEmpty(agentId, conversationId, title) {
      const [row] = await db
        .update(conversations)
        .set({ title })
        .where(and(ownedConversationWhere(agentId, conversationId), eq(conversations.title, '')))
        .returning({ id: conversations.id });
      return Boolean(row);
    },

    async markConversationRead(agentId, conversationId, readAt, settleSeconds = 30) {
      const threshold = new Date(readAt.getTime() - Math.max(0, settleSeconds) * 1000);
      const [row] = await db
        .update(conversations)
        .set({ lastReadAt: readAt })
        .where(
          and(
            ownedConversationWhere(agentId, conversationId),
            or(isNull(conversations.lastReadAt), lt(conversations.lastReadAt, threshold)),
          ),
        )
        .returning({ id: conversations.id });
      return Boolean(row);
    },

    async getGoalTitle(agentId, goalId) {
      const [goal] = await db
        .select({ title: goals.title })
        .from(goals)
        .where(and(eq(goals.id, goalId), eq(goals.agentId, agentId)))
        .limit(1);
      return goal?.title ?? null;
    },

    async clearGoalBlockedOnOwnerReply(agentId, goalId) {
      await db
        .update(goals)
        .set({ nextAction: '', updatedAt: sql`now()` })
        .where(
          and(
            eq(goals.id, goalId),
            eq(goals.agentId, agentId),
            like(goals.nextAction, `${GOAL_BLOCKED_PREFIX}%`),
          ),
        );
    },

    async countActiveTasks(agentId, conversationId) {
      const [row] = await db
        .select({ value: count() })
        .from(tasks)
        .where(
          and(
            eq(tasks.agentId, agentId),
            eq(tasks.conversationId, conversationId),
            notInArray(tasks.status, TERMINAL_TASK_STATUSES),
          ),
        );
      return Number(row?.value ?? 0);
    },

    async getTaskStatus(agentId, conversationId, taskId) {
      const [task] = await db
        .select({ status: tasks.status })
        .from(tasks)
        .where(
          and(
            eq(tasks.id, taskId),
            eq(tasks.agentId, agentId),
            eq(tasks.conversationId, conversationId),
          ),
        )
        .limit(1);
      return task?.status ?? null;
    },

    async listTaskActivity(agentId, conversationId, taskId, requestedLimit = 3) {
      const limit = Math.max(1, Math.min(10, Math.floor(requestedLimit)));
      const rows = await db
        .select({
          toolName: toolCalls.toolName,
          status: toolCalls.status,
          step: toolCalls.step,
        })
        .from(toolCalls)
        .innerJoin(tasks, eq(toolCalls.taskId, tasks.id))
        .where(
          and(
            eq(tasks.id, taskId),
            eq(tasks.agentId, agentId),
            eq(tasks.conversationId, conversationId),
          ),
        )
        .orderBy(desc(toolCalls.createdAt), desc(toolCalls.id))
        .limit(limit);
      return rows.reverse();
    },

    async listEnabledModels() {
      return db
        .select({ id: models.id, label: models.label })
        .from(models)
        .where(
          and(
            eq(models.enabled, true),
            sql`${models.capabilities}->>'embedding' IS DISTINCT FROM 'true'`,
          ),
        )
        .orderBy(models.label);
    },

    async listMessages(agentId, conversationId, input = {}) {
      if (!(await owned(agentId, conversationId))) return null;
      const limit = boundedChatMessageLimit(input.limit);
      const createdAtExact = sql<string>`to_char(${messages.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
      const selection = { ...getTableColumns(messages), createdAtExact };
      if (input.after) {
        const after = input.after;
        const timestamp = sql`${after.createdAtExact ?? after.createdAt.toISOString()}::timestamptz`;
        const rows = await db
          .select(selection)
          .from(messages)
          .where(
            and(
              eq(messages.conversationId, conversationId),
              isNull(messages.hiddenAt),
              or(
                sql`${messages.createdAt} > ${timestamp}`,
                and(sql`${messages.createdAt} = ${timestamp}`, gt(messages.id, after.id)),
              ),
              ne(messages.id, after.id),
            ),
          )
          .orderBy(asc(messages.createdAt), asc(messages.id))
          .limit(limit + 1);
        return { messages: rows.slice(0, limit), hasMore: rows.length > limit };
      }
      const rows = await db
        .select(selection)
        .from(messages)
        .where(and(eq(messages.conversationId, conversationId), isNull(messages.hiddenAt)))
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(limit);
      return { messages: rows.reverse(), hasMore: false };
    },

    async listMessagesByIds(agentId, conversationId, ids) {
      if (!(await owned(agentId, conversationId))) return null;
      if (!ids.length) return [];
      return db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, conversationId),
            inArray(messages.id, ids),
            isNull(messages.hiddenAt),
          ),
        )
        .orderBy(asc(messages.createdAt), asc(messages.id));
    },

    async listRuntimeMessages(agentId, conversationId, taskIds, requestedLimit = 200) {
      if (!(await owned(agentId, conversationId))) return null;
      if (!taskIds.length) return [];
      const limit = boundedChatMessageLimit(requestedLimit);
      return db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, conversationId),
            inArray(messages.taskId, taskIds),
            eq(messages.role, 'assistant'),
            isNull(messages.hiddenAt),
          ),
        )
        .orderBy(asc(messages.createdAt), asc(messages.id))
        .limit(limit);
    },

    async getTaskKinds(agentId, taskIds) {
      if (!taskIds.length) return new Map();
      const rows = await db
        .select({ id: tasks.id, type: tasks.type })
        .from(tasks)
        .where(and(eq(tasks.agentId, agentId), inArray(tasks.id, taskIds)));
      return new Map(rows.map((row) => [row.id, row.type]));
    },

    async getHydrationState(agentId, input) {
      const [approvalRows, taskApprovalRows, budgetRows, suggestionRows] = await Promise.all([
        input.approvalIds.length
          ? db
              .select({
                id: approvals.id,
                taskId: approvals.taskId,
                summary: approvals.summary,
                status: approvals.status,
                payload: approvals.payload,
                expiresAt: approvals.expiresAt,
              })
              .from(approvals)
              .innerJoin(tasks, eq(approvals.taskId, tasks.id))
              .where(and(eq(tasks.agentId, agentId), inArray(approvals.id, input.approvalIds)))
          : [],
        input.approvalTaskIds.length
          ? db
              .select({
                id: approvals.id,
                taskId: approvals.taskId,
                summary: approvals.summary,
                status: approvals.status,
                payload: approvals.payload,
                expiresAt: approvals.expiresAt,
              })
              .from(approvals)
              .innerJoin(tasks, eq(approvals.taskId, tasks.id))
              .where(
                and(eq(tasks.agentId, agentId), inArray(approvals.taskId, input.approvalTaskIds)),
              )
          : [],
        input.budgetTaskIds.length
          ? db
              .select({
                id: tasks.id,
                status: tasks.status,
                budgetUsdLimit: tasks.budgetUsdLimit,
              })
              .from(tasks)
              .where(and(eq(tasks.agentId, agentId), inArray(tasks.id, input.budgetTaskIds)))
          : [],
        input.suggestionIds.length
          ? db
              .select({
                id: suggestions.id,
                status: suggestions.status,
                expiresAt: suggestions.expiresAt,
                snoozedUntil: suggestions.snoozedUntil,
                acceptedTaskId: suggestions.acceptedTaskId,
                acceptedTaskStatus: tasks.status,
                acceptedTaskProgress: tasks.progress,
                acceptedTaskConversationId: tasks.conversationId,
              })
              .from(suggestions)
              .leftJoin(tasks, eq(tasks.id, suggestions.acceptedTaskId))
              .where(
                and(eq(suggestions.agentId, agentId), inArray(suggestions.id, input.suggestionIds)),
              )
          : [],
      ]);
      return {
        approvals: approvalRows,
        taskApprovals: taskApprovalRows,
        budgetTasks: budgetRows,
        suggestions: suggestionRows as ApplicationChatSuggestion[],
      };
    },

    async setMessageHidden(agentId, conversationId, messageId, hidden) {
      const [row] = await db
        .update(messages)
        .set({ hiddenAt: hidden ? new Date() : null })
        .where(
          and(
            eq(messages.id, messageId),
            eq(messages.conversationId, conversationId),
            sql`EXISTS (
              SELECT 1 FROM ${conversations}
              WHERE ${conversations.id} = ${conversationId}
                AND ${conversations.agentId} = ${agentId}
                AND ${conversations.channel} = 'chat'
            )`,
          ),
        )
        .returning({ id: messages.id });
      return Boolean(row);
    },

    async appendOwned(agentId, input) {
      return db.transaction(async (tx) => {
        const [conversation] = await tx
          .select({ id: conversations.id })
          .from(conversations)
          .where(ownedConversationWhere(agentId, input.conversationId))
          .limit(1);
        if (!conversation) throw new Error('chat not found');
        const [row] = input.channelMessageId
          ? await tx
              .insert(messages)
              .values(input)
              .onConflictDoNothing({
                target: messages.channelMessageId,
                where: sql`${messages.channelMessageId} IS NOT NULL`,
              })
              .returning()
          : await tx.insert(messages).values(input).returning();
        if (row) {
          await tx
            .update(conversations)
            .set({ updatedAt: sql`now()` })
            .where(ownedConversationWhere(agentId, input.conversationId));
        }
        return row as ApplicationChatMessage | undefined;
      });
    },

    async createDirectChatTask(input) {
      return db.transaction(async (tx) => {
        const [conversation] = await tx
          .select({ id: conversations.id })
          .from(conversations)
          .where(ownedConversationWhere(input.agentId, input.conversationId))
          .limit(1);
        if (!conversation) throw new Error('chat not found');
        const [budget] = await tx.select().from(budgets).where(eq(budgets.scope, 'task_default'));
        const now = new Date();
        const task = newTaskRecord(
          {
            agentId: input.agentId,
            conversationId: input.conversationId,
            type: 'chat_turn',
            trust: 'owner',
            goalId: input.goalId,
            title: conciseTitle(input.title),
            budgetUsdLimit: budget?.limitUsd ?? '0.50',
            trigger: { source: 'chat', conversationId: input.conversationId },
          },
          randomUUID(),
          now,
        );
        const lease: TaskLease = {
          ...task,
          status: 'running',
          updatedAt: now,
          lockedUntil: new Date(now.getTime() + DIRECT_CHAT_LEASE_MS),
          leaseToken: randomUUID(),
        };
        const [created] = await tx.insert(tasks).values(lease).returning();
        if (!created) throw new Error('failed to create chat task');
        return created as TaskLease;
      });
    },

    async completeDirectChatTask(input) {
      const leaseToken = input.task.leaseToken;
      if (!leaseToken) return false;
      return db.transaction(async (tx) => {
        const [completed] = await tx
          .update(tasks)
          .set({
            status: input.status,
            progress: input.progress,
            lockedUntil: null,
            leaseToken: null,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(tasks.id, input.task.id),
              eq(tasks.agentId, input.agentId),
              eq(tasks.status, 'running'),
              eq(tasks.leaseToken, leaseToken),
              gt(tasks.lockedUntil, sql`now()`),
            ),
          )
          .returning({ id: tasks.id });
        if (!completed) return false;
        for (const message of input.messages) {
          if (
            message.conversationId !== input.task.conversationId ||
            message.taskId !== input.task.id
          ) {
            throw new Error('Chat completion message does not match its task');
          }
          await tx.insert(messages).values(message);
        }
        if (input.task.conversationId && input.messages.length) {
          await tx
            .update(conversations)
            .set({ updatedAt: sql`now()` })
            .where(ownedConversationWhere(input.agentId, input.task.conversationId));
        }
        return true;
      });
    },

    async raiseTaskBudget(agentId, taskId, requested) {
      if (!Number.isFinite(requested) || requested < 0.01 || requested > 10_000) {
        throw new Error('task budget must be between $0.01 and $10,000');
      }
      const [task] = await db
        .select({
          id: tasks.id,
          status: tasks.status,
          budgetUsdLimit: tasks.budgetUsdLimit,
          spentUsd: tasks.spentUsd,
        })
        .from(tasks)
        .where(and(eq(tasks.id, taskId), eq(tasks.agentId, agentId)))
        .limit(1);
      if (!task) throw new Error('activity item not found');
      if (task.status !== 'needs_attention') throw new Error('only stalled tasks can be retried');
      if (requested <= Number(task.budgetUsdLimit) || requested < Number(task.spentUsd)) {
        throw new Error('new task budget must be above its current cap and spend');
      }
      if (
        !(await createPostgresTaskRepository(db).wakeTask(task.id, { agentId, limit: requested }))
      ) {
        throw new Error('task changed before the budget increase could be applied');
      }
    },

    listConversationEvidence(agentId, conversationId, excludeTaskId) {
      return createPostgresExecutionEvidenceRepository(db).conversationEvidence({
        agentId,
        conversationId,
        excludeTaskId,
      });
    },
  };
}
