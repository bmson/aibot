import {
  decodeMessageCursor,
  encodeMessageCursor,
  ensureChatConversation,
  getAgent,
  listConversations,
  listMessages,
  listMessagesByIds,
  setConversationModel,
} from '@assistant/core/chat';
import { compactChatMessageParts } from '@assistant/core/chat-card';
import {
  approvals,
  conversations,
  type Db,
  goals,
  messages,
  models,
  suggestions,
  tasks,
  toolCalls,
} from '@assistant/db';
import type { UIMessage } from 'ai';
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';

const TERMINAL_TASK_STATUSES = ['done', 'failed', 'cancelled'];
const SETTLED_TASK_STATUSES = new Set([
  ...TERMINAL_TASK_STATUSES,
  'needs_attention',
  'waiting_approval',
]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * How far behind the present the poll cursor is allowed to advance.
 *
 * `messages.created_at` defaults to Postgres `now()`, which is TRANSACTION
 * START time, while the cursor can only advance over rows that have already
 * committed. A transaction that starts early and commits late — finishTask
 * wraps the terminal transition and the assistant reply together — therefore
 * lands a row whose timestamp is BEHIND a cursor the poll already moved past,
 * and the keyset comparison in listMessages will never return it again. The
 * message exists in the database and appears mid-log on the next page load:
 * exactly the "it vanished, then came back in the wrong place" report.
 *
 * So the cursor deliberately lags: rows are delivered the moment they are
 * visible, but the cursor only advances over rows old enough that nothing can
 * still commit behind them. Anything newer is re-delivered on the next tick
 * and the client's id-keyed merge absorbs the repeat.
 */
const CURSOR_SETTLE_MS = 15_000;

/** Cap on how many on-screen decision cards one poll may re-read. */
const MAX_REFRESH_IDS = 10;

/** How stale the read stamp must be before opening a thread rewrites it. */
const READ_STAMP_SETTLE_SECONDS = 30;

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

function isSuggestionPart(part: unknown): part is { type: 'suggestion'; suggestionId: string } {
  return (
    Boolean(part) &&
    typeof part === 'object' &&
    (part as { type?: unknown }).type === 'suggestion' &&
    typeof (part as { suggestionId?: unknown }).suggestionId === 'string'
  );
}

/**
 * The dashboard mirror of a parked task's approvals. Unlike an `approval` part
 * it names no single approval, so it used to be the one decision card with no
 * live state at all: it kept saying "1 action is waiting for review" long after
 * the owner had answered on the Approvals page. `approvalIds` is what makes it
 * hydratable; rows written before it fall back to the message's own task.
 */
interface ApprovalSummaryPart {
  type: 'approval-summary';
  purpose: string;
  approvalCount: number;
  approvalIds?: string[];
}

function isApprovalSummaryPart(part: unknown): part is ApprovalSummaryPart {
  return (
    Boolean(part) &&
    typeof part === 'object' &&
    (part as { type?: unknown }).type === 'approval-summary' &&
    typeof (part as { purpose?: unknown }).purpose === 'string'
  );
}

function summaryApprovalIds(part: ApprovalSummaryPart): string[] {
  return Array.isArray(part.approvalIds)
    ? part.approvalIds.filter((id): id is string => typeof id === 'string')
    : [];
}

function messageTaskId(message: UIMessage): string | undefined {
  const taskId = (message.metadata as { taskId?: unknown } | undefined)?.taskId;
  return typeof taskId === 'string' ? taskId : undefined;
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

/**
 * Persisted rows as the chat client reads them. `createdAt` travels on metadata
 * because it is what orders the rendered log — see orderChatLog in the web app.
 * Accepts the base row shape: listMessages rows carry an extra microsecond
 * cursor column that UI mapping has no use for.
 */
type PersistedMessage = typeof messages.$inferSelect;

function persistedParts(row: PersistedMessage): unknown[] {
  return Array.isArray(row.parts) ? row.parts : [];
}

function hasPart(row: PersistedMessage, type: string): boolean {
  return persistedParts(row).some(
    (part) =>
      Boolean(part) && typeof part === 'object' && (part as { type?: unknown }).type === type,
  );
}

function noticeMarker(row: PersistedMessage): string | undefined {
  for (const part of persistedParts(row)) {
    if (!part || typeof part !== 'object') continue;
    const value = part as { type?: unknown; notice?: unknown };
    if (value.type === 'notice' && typeof value.notice === 'string') return value.notice;
  }
  return undefined;
}

function approvalIds(row: PersistedMessage): string[] {
  return persistedParts(row)
    .filter(isApprovalPart)
    .map((part) => part.approvalId)
    .sort();
}

/** The dashboard approval nudge, recognisable by its prose shape alone. */
function isApprovalNudgeText(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.startsWith('Something needs your approval:') ||
    /^\d+ things need your approval:/u.test(trimmed) ||
    trimmed.startsWith('Approval needed to continue:')
  );
}

const NEEDS_ATTENTION_PREFIXES = [
  "I couldn't complete this after repeated attempts and stopped.",
  'A task stopped and needs you',
];

/**
 * The runtime state family one row belongs to, keyed by its task, or
 * undefined for ordinary conversation. Rows in a family are projections of
 * the SAME task state, so only the richest, newest one may stay visible.
 */
function runtimeStateFamily(row: PersistedMessage): string | undefined {
  if (!row.taskId || row.role !== 'assistant') return undefined;
  const approvalsInRow = approvalIds(row);
  const marker = noticeMarker(row);
  const text = row.text.trim();
  let family: string | undefined;
  if (hasPart(row, 'approval-summary')) family = 'approval-summary';
  else if (approvalsInRow.length > 0) family = `approval:${approvalsInRow.join(',')}`;
  else if (hasPart(row, 'budget-request')) family = 'budget-request';
  else if (marker === 'parked' || marker === 'needs-attention') family = marker;
  else if (NEEDS_ATTENTION_PREFIXES.some((prefix) => text.startsWith(prefix))) {
    family = 'needs-attention';
  }
  return family ? `${row.taskId}:${family}` : undefined;
}

/**
 * Runtime notices are state projections, not separate conversational turns.
 * Older workers could write one into the task's thread and then mirror a
 * second prose copy into that same primary thread. A crash between write and
 * stamp could also re-emit the same task state. Keep the richest, newest row
 * for each runtime state family while leaving ordinary repeated conversation
 * untouched.
 */
export function collapseRuntimeMessageDuplicates<T extends PersistedMessage>(rows: T[]): T[] {
  const structuredApprovalTasks = new Set(
    rows
      .filter((row) => row.taskId && (hasPart(row, 'approval') || hasPart(row, 'approval-summary')))
      .map((row) => row.taskId as string),
  );
  const dropped = new Set<string>();
  const families = new Map<string, T[]>();

  for (const row of rows) {
    if (!row.taskId || row.role !== 'assistant') continue;
    if (
      structuredApprovalTasks.has(row.taskId) &&
      !hasPart(row, 'approval-summary') &&
      isApprovalNudgeText(row.text)
    ) {
      dropped.add(row.id);
      continue;
    }

    const key = runtimeStateFamily(row);
    if (!key) continue;
    const group = families.get(key) ?? [];
    group.push(row);
    families.set(key, group);
  }

  const kept = new Set<string>();
  for (const group of families.values()) {
    // Prefer a structured state row over its dashboard prose mirror, then the
    // newest structured row when a later retry changed the details.
    const structured = group.filter(
      (row) =>
        noticeMarker(row) !== undefined ||
        hasPart(row, 'approval') ||
        hasPart(row, 'approval-summary') ||
        hasPart(row, 'budget-request'),
    );
    const candidates = structured.length > 0 ? structured : group;
    const winner = candidates.reduce((latest, row) =>
      row.createdAt > latest.createdAt ? row : latest,
    );
    kept.add(winner.id);
    for (const row of group) {
      if (row.id !== winner.id) dropped.add(row.id);
    }
  }

  return rows.filter((row) => !dropped.has(row.id) || kept.has(row.id));
}

/** Cap on how much task history one poll re-reads to catch stale on-screen rows. */
const MAX_RUNTIME_SIBLINGS = 200;

/**
 * Collapse one delivered page against the FULL runtime-state history of the
 * tasks it touches.
 *
 * Collapsing the page alone is not enough: the older twin of a state row was
 * delivered by an earlier tick and now sits behind the cursor, so a merge-by-id
 * client keeps showing it next to the newer row that replaced it — the
 * duplicate only disappears on the next full load. Re-reading the tasks'
 * assistant rows (indexed, and only when the page actually carries a state
 * row) lets one response both hide a just-arrived row whose card the client
 * already has AND name the already-delivered rows it supersedes.
 *
 * `visible` is the page after collapse; `superseded` names rows OUTSIDE the
 * page the client may be showing that should now come down. A superseded id
 * can also appear in this response's `refreshed` — the retraction wins.
 */
async function collapsePageWithTaskHistory(
  db: Db,
  conversationId: string,
  page: PersistedMessage[],
): Promise<{ visible: PersistedMessage[]; superseded: string[] }> {
  const taskIds = new Set<string>();
  for (const row of page) {
    if (!row.taskId || row.role !== 'assistant') continue;
    if (runtimeStateFamily(row) !== undefined || isApprovalNudgeText(row.text)) {
      taskIds.add(row.taskId);
    }
  }
  if (taskIds.size === 0) return { visible: page, superseded: [] };

  const siblings = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        inArray(messages.taskId, [...taskIds]),
        eq(messages.role, 'assistant'),
      ),
    )
    .orderBy(asc(messages.createdAt), asc(messages.id))
    .limit(MAX_RUNTIME_SIBLINGS);

  const siblingIds = new Set(siblings.map((row) => row.id));
  const union = [...siblings, ...page.filter((row) => !siblingIds.has(row.id))];
  const keptIds = new Set(collapseRuntimeMessageDuplicates(union).map((row) => row.id));
  const pageIds = new Set(page.map((row) => row.id));
  return {
    visible: page.filter((row) => keptIds.has(row.id)),
    superseded: union
      .filter((row) => !keptIds.has(row.id) && !pageIds.has(row.id))
      .map((row) => row.id),
  };
}

function toUiMessages(rows: PersistedMessage[]): UIMessage[] {
  return rows
    .filter((row) => row.role === 'user' || row.role === 'assistant')
    .map((row) => ({
      id: row.id,
      role: row.role as 'user' | 'assistant',
      parts: compactChatMessageParts(
        row.text,
        Array.isArray(row.parts) ? row.parts : [],
        row.taskId ?? undefined,
      ) as UIMessage['parts'],
      // `taskId` rides along so hydration can resolve an approval summary
      // written before the part carried its own approval ids — see
      // hydrateChatApprovals. The client reads only `createdAt`.
      metadata: { createdAt: row.createdAt.toISOString(), taskId: row.taskId ?? undefined },
    }));
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
  const suggestionIds = [
    ...new Set(
      messages.flatMap((message) =>
        (message.parts as unknown[]).filter(isSuggestionPart).map((part) => part.suggestionId),
      ),
    ),
  ];
  // A summary either names its approvals or, on a row written before it did,
  // stands for whatever its task is currently waiting on.
  const summaryIds = new Set<string>();
  const summaryTaskIds = new Set<string>();
  for (const message of messages) {
    for (const part of message.parts as unknown[]) {
      if (!isApprovalSummaryPart(part)) continue;
      const ids = summaryApprovalIds(part);
      if (ids.length > 0) for (const id of ids) summaryIds.add(id);
      else {
        const taskId = messageTaskId(message);
        if (taskId) summaryTaskIds.add(taskId);
      }
    }
  }
  const lookupApprovalIds = [...new Set([...approvalIds, ...summaryIds])];
  if (
    !lookupApprovalIds.length &&
    !summaryTaskIds.size &&
    !budgetTaskIds.length &&
    !suggestionIds.length
  ) {
    return messages;
  }

  const [approvalRows, summaryTaskRows, budgetTasks, suggestionRows] = await Promise.all([
    lookupApprovalIds.length
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
          .where(inArray(approvals.id, lookupApprovalIds))
      : [],
    summaryTaskIds.size
      ? db
          .select({
            id: approvals.id,
            taskId: approvals.taskId,
            summary: approvals.summary,
            status: approvals.status,
            expiresAt: approvals.expiresAt,
          })
          .from(approvals)
          .where(inArray(approvals.taskId, [...summaryTaskIds]))
      : [],
    budgetTaskIds.length
      ? db
          .select({ id: tasks.id, status: tasks.status, budgetUsdLimit: tasks.budgetUsdLimit })
          .from(tasks)
          .where(inArray(tasks.id, budgetTaskIds))
      : [],
    suggestionIds.length
      ? db
          .select({
            id: suggestions.id,
            status: suggestions.status,
            expiresAt: suggestions.expiresAt,
            snoozedUntil: suggestions.snoozedUntil,
            acceptedTaskId: suggestions.acceptedTaskId,
          })
          .from(suggestions)
          .where(inArray(suggestions.id, suggestionIds))
      : [],
  ]);
  const suggestionById = new Map(suggestionRows.map((row) => [row.id, row]));
  const approvalById = new Map(approvalRows.map((row) => [row.id, row]));
  const taskById = new Map(budgetTasks.map((task) => [task.id, task]));
  const summaryByTask = new Map<string, typeof summaryTaskRows>();
  for (const row of summaryTaskRows) {
    summaryByTask.set(row.taskId, [...(summaryByTask.get(row.taskId) ?? []), row]);
  }
  /** An approval's state as the log should read it — pending lapses on time. */
  const settled = (row: { status: string; expiresAt: Date }): InlineApprovalStatus =>
    row.status === 'pending' && row.expiresAt <= now
      ? 'expired'
      : (row.status as InlineApprovalStatus);

  return messages.map((message) => ({
    ...message,
    parts: (message.parts as unknown[]).map((part) => {
      if (isApprovalSummaryPart(part)) {
        const ids = summaryApprovalIds(part);
        const taskId = messageTaskId(message);
        const rows = ids.length
          ? ids.flatMap((id) => {
              const row = approvalById.get(id);
              return row ? [row] : [];
            })
          : taskId
            ? (summaryByTask.get(taskId) ?? [])
            : [];
        // Nothing to resolve it against (a legacy row whose task is gone):
        // leave the persisted wording alone rather than claim it settled.
        if (rows.length === 0) return part;
        const outcomes = rows.map((row) => ({
          id: row.id,
          summary: row.summary,
          status: settled(row),
        }));
        return {
          ...part,
          pendingCount: outcomes.filter((outcome) => outcome.status === 'pending').length,
          outcomes,
        };
      }
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
      if (isSuggestionPart(part)) {
        const suggestion = suggestionById.get(part.suggestionId);
        if (!suggestion) return { ...part, status: 'missing' };
        // A suggestion nobody answered goes quiet on its own, so an elapsed
        // deadline reads as expired rather than as a live question.
        // A snooze is folded the same way: still sleeping reads as snoozed
        // (a settled receipt, not a live question), and a snooze whose time
        // has come reads as pending again so the card re-opens.
        const status =
          (suggestion.status === 'pending' || suggestion.status === 'snoozed') &&
          suggestion.expiresAt <= now
            ? 'expired'
            : suggestion.status === 'snoozed'
              ? suggestion.snoozedUntil && suggestion.snoozedUntil > now
                ? 'snoozed'
                : 'pending'
              : suggestion.status;
        return { ...part, status, acceptedTaskId: suggestion.acceptedTaskId ?? undefined };
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
  if (candidates.length === 0) return 0;
  // One statement, not two per candidate. This walked up to a hundred chats
  // asking the same question a hundred times; the condition it was asking is
  // something Postgres can answer inside the UPDATE.
  const archived = await db
    .update(conversations)
    .set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        inArray(
          conversations.id,
          candidates.map((candidate) => candidate.id),
        ),
        isNull(conversations.archivedAt),
        sql`NOT EXISTS (
          SELECT 1 FROM ${tasks}
          WHERE ${tasks.conversationId} = ${conversations.id}
            AND ${tasks.agentId} = ${agent.id}
            AND ${tasks.status} NOT IN ${TERMINAL_TASK_STATUSES}
        )`,
      ),
    )
    .returning({ id: conversations.id });
  return archived.length;
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
  input: { taskId?: string; cursor?: string; now?: Date },
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
  // Every load of this view is the owner opening the thread — the dashboard
  // page and both mobile reads funnel here — so it doubles as the read
  // cursor. The chat list marks a thread unread when activity lands after
  // this stamp. Best-effort: a failed stamp costs a dot, not the page.
  //
  // Only written when it would actually move. This is a read path that the
  // native app re-enters on every foreground and the web page on every load,
  // and an unconditional UPDATE put all of them in line behind each other for
  // the same row the executor is writing `updated_at` to. The unread dot is
  // about whether you have looked recently, not about the exact second.
  try {
    await db
      .update(conversations)
      .set({ lastReadAt: input.now ?? new Date() })
      .where(
        and(
          eq(conversations.id, conversation.id),
          or(
            isNull(conversations.lastReadAt),
            lt(
              conversations.lastReadAt,
              sql`now() - interval '${sql.raw(String(READ_STAMP_SETTLE_SECONDS))} seconds'`,
            ),
          ),
        ),
      );
  } catch (err) {
    console.error('conversation read stamp failed', err);
  }
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
    toUiMessages(collapseRuntimeMessageDuplicates(messageRows)),
  );
  return {
    conversation,
    agentName: agent.name || 'Assistant',
    // Chat formats day dividers and times in this zone on BOTH sides, so the
    // server-rendered log and the hydrated one agree and nothing shifts once
    // the client takes over.
    agentTimezone: agent.timezone,
    messages,
    models: enabledModels,
    goalTitle: linkedGoal?.title,
    canArchive: !conversation.isPrimary && Number(activeTasks[0]?.value ?? 0) === 0,
    // Where the open page resumes polling from. Without it the client has no
    // cursor until it sends a turn, so anything the assistant posted on its own
    // — a schedule, a watch, an approval resuming — stayed invisible until the
    // page was loaded again.
    //
    // Seeded under the same settle rule the poll advances by, because a render
    // is a poll like any other: a cursor planted on a row written moments ago
    // sits in front of whatever is still committing behind it, and the open
    // page never sees those at all. A chat whose every message is that fresh
    // starts with no cursor and picks one up on its first tick.
    cursor: advanceCursor(messageRows, undefined, false, input.now ?? new Date()),
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
 *
 * `refreshIds` names rows the caller is already showing and wants re-read —
 * decision cards whose live status may have changed elsewhere. They come back
 * in `refreshed`, deliberately NOT in `messages`: `messages` is what the client
 * uses to decide a turn has produced its answer, and a re-read of an old row is
 * not new output.
 *
 * `superseded` is the reverse direction: rows an earlier tick already
 * delivered that a row in THIS page replaces (a crash-retry re-emitting a task
 * state, a prose mirror superseded by its structured card). Collapsing one
 * page can never see those — the older twin sits behind the cursor — so the
 * page is collapsed against its tasks' full state history and the losers an
 * open client may be showing come back here for removal.
 */
export async function getChatUpdates(
  db: Db,
  input: {
    conversationId: string;
    taskId?: string;
    cursor?: string;
    pageSize?: number;
    refreshIds?: string[];
    now?: Date;
  },
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
  const { visible, superseded } = await collapsePageWithTaskHistory(db, input.conversationId, page);
  const messages = await hydrateChatApprovals(db, toUiMessages(visible));
  const refreshIds = (input.refreshIds ?? [])
    .filter((id) => UUID_RE.test(id))
    .slice(0, MAX_REFRESH_IDS);
  const refreshed = refreshIds.length
    ? await hydrateChatApprovals(
        db,
        toUiMessages(await listMessagesByIds(db, input.conversationId, refreshIds)),
      )
    : [];
  const nextCursor = advanceCursor(page, cursor, hasMore, input.now ?? new Date());
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
  return { taskStatus, messages, refreshed, superseded, nextCursor, hasMore, activity };
}

/**
 * How far the poll may remember having read. Never past a row young enough
 * that a slower transaction could still commit behind it (CURSOR_SETTLE_MS
 * above explains why that happens), and never backwards — the client loops
 * immediately while `hasMore` is set, so a cursor that could retreat would
 * spin. A full page means a real backlog, whose rows are old by definition, so
 * that case advances to the tail as before.
 */
function advanceCursor(
  page: Awaited<ReturnType<typeof listMessages>>,
  cursor: { createdAt: Date; id: string } | undefined,
  hasMore: boolean,
  now: Date,
): string | null {
  const fallback = cursor ? encodeMessageCursor(cursor) : null;
  if (page.length === 0) return fallback;
  if (hasMore) return encodeMessageCursor(page[page.length - 1] as (typeof page)[number]);
  const settledBefore = now.getTime() - CURSOR_SETTLE_MS;
  for (let index = page.length - 1; index >= 0; index -= 1) {
    const row = page[index] as (typeof page)[number];
    if (row.createdAt.getTime() <= settledBefore) return encodeMessageCursor(row);
  }
  return fallback;
}
