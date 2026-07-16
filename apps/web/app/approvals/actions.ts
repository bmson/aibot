'use server';

import { resolveApproval } from '@assistant/core';
import { revalidatePath } from 'next/cache';
import { requireOwner } from '@/auth';
import { getDb } from '@/lib/server';

function revalidateApprovalViews(): void {
  revalidatePath('/');
  revalidatePath('/approvals');
  revalidatePath('/tasks');
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
