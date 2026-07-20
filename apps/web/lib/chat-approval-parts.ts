import { approvals, type Db } from '@assistant/db';
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

function isApprovalPart(part: unknown): part is ApprovalPartLike {
  return (
    Boolean(part) &&
    typeof part === 'object' &&
    (part as { type?: unknown }).type === 'approval' &&
    typeof (part as { approvalId?: unknown }).approvalId === 'string'
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
export async function withApprovalStatuses(db: Db, messages: UIMessage[]): Promise<UIMessage[]> {
  const approvalIds = [
    ...new Set(
      messages.flatMap((message) =>
        (message.parts as unknown[]).filter(isApprovalPart).map((part) => part.approvalId),
      ),
    ),
  ];
  if (approvalIds.length === 0) return messages;

  const rows = await db
    .select({ id: approvals.id, status: approvals.status, payload: approvals.payload })
    .from(approvals)
    .where(inArray(approvals.id, approvalIds));
  const approvalById = new Map(rows.map((row) => [row.id, row]));

  return messages.map((message) => ({
    ...message,
    parts: (message.parts as unknown[]).map((part) => {
      if (!isApprovalPart(part)) return part;
      const approval = approvalById.get(part.approvalId);
      return approval
        ? {
            ...part,
            status: approval.status as Exclude<InlineApprovalStatus, 'missing'>,
            details: approvalDetails(approval.payload),
          }
        : { ...part, status: 'missing' };
    }) as UIMessage['parts'],
  }));
}
