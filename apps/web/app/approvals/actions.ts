'use server';

import { getAgent, resolveApproval } from '@assistant/core';
import { approvals, toolCalls } from '@assistant/db';
import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { requireOwner } from '@/auth';
import { getDb } from '@/lib/server';

function revalidateApprovalViews(): void {
  revalidatePath('/');
  revalidatePath('/approvals');
  revalidatePath('/tasks');
  revalidatePath('/chat', 'layout');
}

export async function approveApproval(approvalId: string): Promise<void> {
  await requireOwner();
  await resolveApproval(getDb(), { approvalId, decision: 'approved', via: 'web' });
  revalidateApprovalViews();
}

export async function denyApproval(approvalId: string): Promise<void> {
  await requireOwner();
  await resolveApproval(getDb(), { approvalId, decision: 'denied', via: 'web' });
  revalidateApprovalViews();
}

export async function resolveApprovalInline(
  approvalId: string,
  decision: 'approved' | 'denied',
): Promise<{ ok: boolean; error?: string }> {
  await requireOwner();
  const result = await resolveApproval(getDb(), { approvalId, decision, via: 'web' });
  revalidateApprovalViews();
  return result.ok ? { ok: true } : { ok: false, error: result.reason };
}

/** Approve and create the one currently supported recipient-scoped standing rule. */
export async function approveAndRemember(approvalId: string): Promise<void> {
  await requireOwner();
  const db = getDb();
  const [row] = await db
    .select({ approval: approvals, toolName: toolCalls.toolName })
    .from(approvals)
    .innerJoin(toolCalls, eq(approvals.toolCallId, toolCalls.id))
    .where(eq(approvals.id, approvalId))
    .limit(1);
  if (row?.approval.status !== 'pending') return;

  const payload = row.approval.payload as { to?: unknown } | null;
  const recipients = Array.isArray(payload?.to)
    ? payload.to.filter((item): item is string => typeof item === 'string')
    : [];
  const recipient = recipients.length === 1 ? recipients[0] : undefined;
  if (row.toolName !== 'gmail.send' || !recipient) {
    await resolveApproval(db, { approvalId, decision: 'approved', via: 'web' });
  } else {
    const agent = await getAgent(db);
    await resolveApproval(db, {
      approvalId,
      decision: 'approved',
      via: 'web',
      policy: {
        agentId: agent.id,
        toolName: 'gmail.send',
        templateKey: 'gmail.send.to_recipient',
        match: { recipient: recipient.toLowerCase() },
        effect: 'allow',
      },
    });
  }
  revalidateApprovalViews();
}

export interface EditApproveState {
  error: string | null;
  /** Raw textarea content echoed back on error so the user's edit isn't lost on reset. */
  raw?: string;
}

/** Edit-then-approve: validate the edited JSON, then resolve with editedPayload. */
export async function editAndApprove(
  _prev: EditApproveState,
  formData: FormData,
): Promise<EditApproveState> {
  await requireOwner();
  const approvalId = String(formData.get('approvalId') ?? '');
  const raw = String(formData.get('payload') ?? '');

  let editedPayload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { error: 'Payload must be a JSON object.', raw };
    }
    editedPayload = parsed as Record<string, unknown>;
  } catch {
    return { error: 'Invalid JSON — fix the payload and submit again.', raw };
  }

  const result = await resolveApproval(getDb(), {
    approvalId,
    decision: 'approved',
    via: 'web',
    editedPayload,
  });
  if (!result.ok) return { error: `Could not approve: ${result.reason}`, raw };

  revalidateApprovalViews();
  return { error: null };
}
