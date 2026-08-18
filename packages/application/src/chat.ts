import {
  decodeMessageCursor,
  encodeMessageCursor,
  ensureChatConversation,
  getAgent,
  listConversations,
  listMessages,
  setConversationModel,
} from '@assistant/core/chat';
import { approvals, conversations, type Db, goals, models, tasks, toolCalls } from '@assistant/db';
import type { UIMessage } from 'ai';
import { and, count, desc, eq, inArray, isNotNull, isNull, lt, notInArray, sql } from 'drizzle-orm';

const TERMINAL_TASK_STATUSES = ['done', 'failed', 'cancelled'];
const SETTLED_TASK_STATUSES = new Set([
  ...TERMINAL_TASK_STATUSES,
  'needs_attention',
  'waiting_approval',
]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type InlineApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'missing';
export interface InlineApprovalDetail {
  label: string;
  value: string;
}

interface ApprovalPart {
  type: 'approval';
  approvalId: string;
  status?: InlineApprovalStatus;
}

interface BudgetRequestPart {
  type: 'budget-request';
  taskId: string;
  proposedBudgetUsd: number;
  status?: 'pending' | 'approved' | 'denied' | 'missing';
}

function isApprovalPart(part: unknown): part is ApprovalPart {
  return (
    Boolean(part) &&
    typeof part === 'object' &&
    (part as { type?: unknown }).type === 'approval' &&
    typeof (part as { approvalId?: unknown }).approvalId === 'string'
  );
}

function isBudgetRequestPart(part: unknown): part is BudgetRequestPart {
  return (
    Boolean(part) &&
    typeof part === 'object' &&
    (part as { type?: unknown }).type === 'budget-request' &&
    typeof (part as { taskId?: unknown }).taskId === 'string' &&
    typeof (part as { proposedBudgetUsd?: unknown }).proposedBudgetUsd === 'number'
  );
}

function detailLabel(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replaceAll('_', ' ')
    .trim();
  return words ? `${words[0]?.toUpperCase() ?? ''}${words.slice(1)}` : 'Value';
}

function detailValue(value: unknown): string {
  if (typeof value === 'string') return value || '(empty)';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return '(not set)';
  if (Array.isArray(value) && value.every((item) => typeof item !== 'object')) {
    return value.map(String).join(', ') || '(none)';
  }
  return JSON.stringify(value, null, 2) ?? String(value);
}

/** Attach live approval and budget state to persisted custom message parts. */
export async function hydrateChatApprovals(
  db: Db,
  messages: UIMessage[],
  now: Date = new Date(),
): Promise<UIMessage[]> {
  const approvalIds = [
    ...new Set(
      messages.flatMap((message) =>
        (message.parts as unknown[]).filter(isApprovalPart).map((part) => part.approvalId),
      ),
    ),
  ];
  const budgetTaskIds = [
    ...new Set(
      messages.flatMap((message) =>
        (message.parts as unknown[]).filter(isBudgetRequestPart).map((part) => part.taskId),
      ),
    ),
  ];
  if (!approvalIds.length && !budgetTaskIds.length) return messages;

  const [approvalRows, budgetTasks] = await Promise.all([
    approvalIds.length
      ? db
          .select({
            id: approvals.id,
            status: approvals.status,
            payload: approvals.payload,
            expiresAt: approvals.expiresAt,
          })
          .from(approvals)
          .where(inArray(approvals.id, approvalIds))
      : [],
    budgetTaskIds.length
      ? db
          .select({ id: tasks.id, status: tasks.status, budgetUsdLimit: tasks.budgetUsdLimit })
          .from(tasks)
          .where(inArray(tasks.id, budgetTaskIds))
      : [],
  ]);
  const approvalById = new Map(approvalRows.map((row) => [row.id, row]));
  const taskById = new Map(budgetTasks.map((task) => [task.id, task]));
  return messages.map((message) => ({
    ...message,
    parts: (message.parts as unknown[]).map((part) => {
      if (isBudgetRequestPart(part)) {
        const task = taskById.get(part.taskId);
        const status = !task
          ? 'missing'
          : Number(task.budgetUsdLimit) >= part.proposedBudgetUsd
            ? 'approved'
            : task.status === 'cancelled'
              ? 'denied'
              : task.status === 'needs_attention'
                ? 'pending'
                : 'missing';
        return { ...part, status };
      }
      if (!isApprovalPart(part)) return part;
      const approval = approvalById.get(part.approvalId);
      return approval
        ? {
            ...part,
            status:
              approval.status === 'pending' && approval.expiresAt <= now
                ? 'expired'
                : approval.status,
            details:
              approval.payload &&
              typeof approval.payload === 'object' &&
              !Array.isArray(approval.payload)
                ? Object.entries(approval.payload).map(([key, value]) => ({
                    label: detailLabel(key),
                    value: detailValue(value),
                  }))
                : [{ label: 'Value', value: detailValue(approval.payload) }],
          }
        : { ...part, status: 'missing' };
    }) as UIMessage['parts'],
  }));
}

export async function createChatConversation(db: Db): Promise<string> {
  const agent = await getAgent(db);
  return (await ensureChatConversation(db, agent.id)).id;
}

export function changeChatModel(
  db: Db,
  conversationId: string,
  modelId: string | null,
): Promise<void> {
  return setConversationModel(db, conversationId, modelId);
}

async function ownedChat(db: Db, conversationId: string) {
  const agent = await getAgent(db);
  const [conversation] = await db
    .select({ id: conversations.id, isPrimary: conversations.isPrimary })
    .from(conversations)
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.agentId, agent.id),
        eq(conversations.channel, 'chat'),
      ),
    );
  if (!conversation) throw new Error('chat not found');
  return { agent, conversation };
}

export async function archiveChatConversation(
  db: Db,
  conversationId: string,
): Promise<'archived' | 'active' | 'primary'> {
  const { agent, conversation } = await ownedChat(db, conversationId);
  if (conversation.isPrimary) return 'primary';
  const [activeTask] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.agentId, agent.id),
        eq(tasks.conversationId, conversation.id),
        notInArray(tasks.status, TERMINAL_TASK_STATUSES),
      ),
    )
    .limit(1);
  if (activeTask) return 'active';
  await db
    .update(conversations)
    .set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(conversations.id, conversation.id), isNull(conversations.archivedAt)));
  return 'archived';
}

export async function restoreChatConversation(db: Db, conversationId: string): Promise<void> {
  const { conversation } = await ownedChat(db, conversationId);
  await db
    .update(conversations)
    .set({ archivedAt: null, updatedAt: new Date() })
    .where(and(eq(conversations.id, conversation.id), isNotNull(conversations.archivedAt)));
}

export async function archiveInactiveChats(db: Db, olderThanDays = 30): Promise<number> {
  const agent = await getAgent(db);
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
  const candidates = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.agentId, agent.id),
        eq(conversations.channel, 'chat'),
        eq(conversations.isPrimary, false),
        isNull(conversations.archivedAt),
        lt(conversations.updatedAt, cutoff),
      ),
    )
    .orderBy(desc(conversations.updatedAt))
    .limit(100);
  let archived = 0;
  for (const candidate of candidates) {
    const [activeTask] = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.agentId, agent.id),
          eq(tasks.conversationId, candidate.id),
          notInArray(tasks.status, TERMINAL_TASK_STATUSES),
        ),
      )
      .limit(1);
    if (activeTask) continue;
    const changed = await db
      .update(conversations)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(conversations.id, candidate.id), isNull(conversations.archivedAt)))
      .returning({ id: conversations.id });
    archived += changed.length;
  }
  return archived;
}

export async function listChatHistory(db: Db, archived: boolean) {
  const agent = await getAgent(db);
  const [chatRows, archivedCountRows, scopeCountRows, activeTaskRows] = await Promise.all([
    listConversations(db, agent.id, { archived }),
    db
      .select({ value: count() })
      .from(conversations)
      .where(
        and(
          eq(conversations.agentId, agent.id),
          eq(conversations.channel, 'chat'),
          isNotNull(conversations.archivedAt),
        ),
      ),
    db
      .select({ value: count() })
      .from(conversations)
      .where(
        and(
          eq(conversations.agentId, agent.id),
          eq(conversations.channel, 'chat'),
          archived ? isNotNull(conversations.archivedAt) : isNull(conversations.archivedAt),
        ),
      ),
    db
      .selectDistinct({ conversationId: tasks.conversationId })
      .from(tasks)
      .where(
        and(
          eq(tasks.agentId, agent.id),
          isNotNull(tasks.conversationId),
          notInArray(tasks.status, TERMINAL_TASK_STATUSES),
        ),
      ),
  ]);
  return {
    conversations: chatRows,
    archivedCount: Number(archivedCountRows[0]?.value ?? 0),
    totalInScope: Number(scopeCountRows[0]?.value ?? chatRows.length),
    activeConversationIds: activeTaskRows
      .map((task) => task.conversationId)
      .filter((id): id is string => id !== null),
  };
}

function goalIdFromMetadata(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
  const goalId = (metadata as Record<string, unknown>).goalId;
  return typeof goalId === 'string' && UUID_RE.test(goalId) ? goalId : undefined;
}

/** Validate the opaque chat polling cursor without exposing core encoding to transports. */
export function isValidChatCursor(value: string): boolean {
  return decodeMessageCursor(value) !== undefined;
}

export async function getChatConversationView(
  db: Db,
  conversationId: string,
  input: { taskId?: string; cursor?: string },
) {
  const agent = await getAgent(db);
  const [conversation] = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.agentId, agent.id),
        eq(conversations.channel, 'chat'),
      ),
    );
  if (!conversation) return null;
  const goalId = goalIdFromMetadata(conversation.metadata);
  const requestedTaskId = input.taskId && UUID_RE.test(input.taskId) ? input.taskId : undefined;
  const requestedCursor = decodeMessageCursor(input.cursor);
  const [messageRows, linkedGoal, requestedTask, activeTasks, enabledModels] = await Promise.all([
    listMessages(db, conversationId),
    goalId
      ? db
          .select({ title: goals.title })
          .from(goals)
          .where(and(eq(goals.id, goalId), eq(goals.agentId, agent.id)))
          .then(([goal]) => goal)
      : undefined,
    requestedTaskId
      ? db
          .select({ id: tasks.id })
          .from(tasks)
          .where(and(eq(tasks.id, requestedTaskId), eq(tasks.conversationId, conversationId)))
          .then(([task]) => task)
      : undefined,
    db
      .select({ value: count() })
      .from(tasks)
      .where(
        and(
          eq(tasks.agentId, agent.id),
          eq(tasks.conversationId, conversationId),
          notInArray(tasks.status, TERMINAL_TASK_STATUSES),
        ),
      ),
    db
      .select({ id: models.id, label: models.label })
      .from(models)
      .where(
        and(
          eq(models.enabled, true),
          sql`${models.capabilities}->>'embedding' IS DISTINCT FROM 'true'`,
        ),
      )
      .orderBy(models.label),
  ]);
  const messages = await hydrateChatApprovals(
    db,
    messageRows
      .filter((row) => row.role === 'user' || row.role === 'assistant')
      .map((row) => ({
        id: row.id,
        role: row.role as 'user' | 'assistant',
        parts: row.parts as UIMessage['parts'],
        metadata: { createdAt: row.createdAt.toISOString() },
      })),
  );
  // Where the open page should resume polling from. Without this the client
  // has no cursor until it sends a turn, so anything the assistant posted on
  // its own — a schedule, a watch, an approval resuming — stayed invisible
  // until the page was loaded again.
  const newest = messageRows.at(-1);
  return {
    conversation,
    agentName: agent.name || 'Assistant',
    messages,
    models: enabledModels,
    goalTitle: linkedGoal?.title,
    canArchive: !conversation.isPrimary && Number(activeTasks[0]?.value ?? 0) === 0,
    cursor: newest ? encodeMessageCursor(newest) : null,
    asyncTurn:
      requestedTask && requestedCursor && input.cursor
        ? { taskId: requestedTask.id, cursor: input.cursor }
        : undefined,
  };
}

/**
 * Everything the open chat has not seen yet, from one cursor forward.
 *
 * `taskId` is optional because the chat log is not only fed by the turn you
 * just sent: schedules, missions, watches, attention notices and inbound
 * email/SMS all persist into the conversation with no task the page knows
 * about, and the executor keeps writing after a parked task resumes. Polling
 * only for a known task is what made those land invisibly until a reload.
 * With a task, the caller also gets its status and live tool activity.
 */
export async function getChatUpdates(
  db: Db,
  input: { conversationId: string; taskId?: string; cursor?: string; pageSize?: number },
) {
  let taskStatus: string | null = null;
  if (input.taskId) {
    const [task] = await db
      .select({ status: tasks.status, conversationId: tasks.conversationId })
      .from(tasks)
      .where(eq(tasks.id, input.taskId));
    if (!task || task.conversationId !== input.conversationId) return null;
    taskStatus = task.status;
  } else {
    // The task lookup above is what proved the caller may read this thread.
    // Without one, check the conversation itself rather than trusting an id
    // from the query string.
    const agent = await getAgent(db);
    const [conversation] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.id, input.conversationId),
          eq(conversations.agentId, agent.id),
          eq(conversations.channel, 'chat'),
        ),
      );
    if (!conversation) return null;
  }
  const cursor = decodeMessageCursor(input.cursor);
  const pageSize = input.pageSize ?? 50;
  const rows = await listMessages(db, input.conversationId, {
    ...(cursor ? { after: cursor } : {}),
    limit: cursor ? pageSize + 1 : pageSize,
  });
  const hasMore = Boolean(cursor && rows.length > pageSize);
  const page = rows.slice(0, pageSize);
  const messages = await hydrateChatApprovals(
    db,
    page
      .filter((row) => row.role === 'user' || row.role === 'assistant')
      .map((row) => ({
        id: row.id,
        role: row.role as 'user' | 'assistant',
        parts: row.parts as UIMessage['parts'],
        metadata: { createdAt: row.createdAt.toISOString() },
      })),
  );
  const last = page.at(-1);
  const nextCursor = last ? encodeMessageCursor(last) : cursor ? encodeMessageCursor(cursor) : null;
  const taskId = input.taskId;
  const activity =
    taskId && taskStatus && !SETTLED_TASK_STATUSES.has(taskStatus)
      ? (
          await db
            .select({
              toolName: toolCalls.toolName,
              status: toolCalls.status,
              step: toolCalls.step,
            })
            .from(toolCalls)
            .where(eq(toolCalls.taskId, taskId))
            .orderBy(desc(toolCalls.createdAt))
            .limit(3)
        ).reverse()
      : [];
  return { taskStatus, messages, nextCursor, hasMore, activity };
}
