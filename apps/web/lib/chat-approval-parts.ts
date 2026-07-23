import { approvals, type Db, tasks } from '@assistant/db';
import type { UIMessage } from 'ai';
import { inArray } from 'drizzle-orm';

export type InlineApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'missing';
export interface InlineApprovalDetail {
  label: string;
  value: string;
}

interface ApprovalPartLike {
  type: 'approval';
  approvalId: string;
  status?: InlineApprovalStatus;
}

interface BudgetRequestPartLike {
  type: 'budget-request';
  taskId: string;
  proposedBudgetUsd: number;
  status?: 'pending' | 'approved' | 'denied' | 'missing';
}

function isApprovalPart(part: unknown): part is ApprovalPartLike {
  return (
    Boolean(part) &&
    typeof part === 'object' &&
    (part as { type?: unknown }).type === 'approval' &&
    typeof (part as { approvalId?: unknown }).approvalId === 'string'
  );
}

function isBudgetRequestPart(part: unknown): part is BudgetRequestPartLike {
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

function approvalDetails(payload: unknown): InlineApprovalDetail[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return [{ label: 'Value', value: detailValue(payload) }];
  }
  return Object.entries(payload).map(([key, value]) => ({
    label: detailLabel(key),
    value: detailValue(value),
  }));
}

/** Attach live approval state to persisted custom message parts in one query. */
export async function withApprovalStatuses(
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
  if (approvalIds.length === 0 && budgetTaskIds.length === 0) return messages;

  const [rows, budgetTasks] = await Promise.all([
    approvalIds.length > 0
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
    budgetTaskIds.length > 0
      ? db
          .select({ id: tasks.id, status: tasks.status, budgetUsdLimit: tasks.budgetUsdLimit })
          .from(tasks)
          .where(inArray(tasks.id, budgetTaskIds))
      : [],
  ]);
  const approvalById = new Map(rows.map((row) => [row.id, row]));
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
                : (approval.status as Exclude<InlineApprovalStatus, 'missing'>),
            details: approvalDetails(approval.payload),
          }
        : { ...part, status: 'missing' };
    }) as UIMessage['parts'],
  }));
}
