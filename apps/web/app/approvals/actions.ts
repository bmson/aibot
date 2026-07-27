'use server';

import {
  approveAndRememberApproval,
  decideApproval,
  decideApprovals,
} from '@assistant/application/approvals';
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
  await decideApproval(getDb(), approvalId, 'approved');
  revalidateApprovalViews();
}

export async function denyApproval(approvalId: string): Promise<void> {
  await requireOwner();
  await decideApproval(getDb(), approvalId, 'denied');
  revalidateApprovalViews();
}

export async function resolveApprovalInline(
  approvalId: string,
  decision: 'approved' | 'denied',
): Promise<{ ok: boolean; error?: string }> {
  await requireOwner();
  const result = await decideApproval(getDb(), approvalId, decision);
  revalidateApprovalViews();
  return result.ok ? { ok: true } : { ok: false, error: result.reason };
}

/**
 * Resolve several approvals in one server round trip ("Approve all" on a
 * grouped chat card). Sequential on purpose — resolveApproval wakes the parked
 * task per approval — and per-id failures are reported, not thrown, so one
 * expired approval doesn't strand the rest.
 */
export async function resolveApprovalsInline(
  approvalIds: string[],
  decision: 'approved' | 'denied',
): Promise<{ failures: Array<{ approvalId: string; error: string }> }> {
  await requireOwner();
  const failures = await decideApprovals(getDb(), approvalIds, decision);
  revalidateApprovalViews();
  return { failures };
}

/** Approve and create the one currently supported recipient-scoped standing rule. */
export async function approveAndRemember(approvalId: string): Promise<void> {
  await requireOwner();
  await approveAndRememberApproval(getDb(), approvalId);
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

  const result = await decideApproval(getDb(), approvalId, 'approved', editedPayload);
  if (!result.ok) return { error: `Could not approve: ${result.reason}`, raw };

  revalidateApprovalViews();
  return { error: null };
}
