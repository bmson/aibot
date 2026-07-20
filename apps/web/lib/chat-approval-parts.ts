import { approvals, type Db } from '@assistant/db';
import type { UIMessage } from 'ai';
import { inArray } from 'drizzle-orm';

export type InlineApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'missing';

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
    .select({ id: approvals.id, status: approvals.status })
    .from(approvals)
    .where(inArray(approvals.id, approvalIds));
  const statusById = new Map(
    rows.map((row) => [row.id, row.status as Exclude<InlineApprovalStatus, 'missing'>]),
  );

  return messages.map((message) => ({
    ...message,
    parts: (message.parts as unknown[]).map((part) =>
      isApprovalPart(part)
        ? { ...part, status: statusById.get(part.approvalId) ?? 'missing' }
        : part,
    ) as UIMessage['parts'],
  }));
}
