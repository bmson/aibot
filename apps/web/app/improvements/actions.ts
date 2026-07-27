'use server';

import { revalidatePath } from 'next/cache';
import { requireOwner } from '@/auth';
import { getApplication } from '@/lib/server';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function revalidate(): void {
  revalidatePath('/improvements');
  revalidatePath('/settings');
}

/** Owner approves a proposal — enacts an applyable change, or acknowledges an advisory one. */
export async function applyProposalAction(id: string): Promise<void> {
  await requireOwner();
  if (!UUID_RE.test(id)) return;
  await getApplication().applyImprovementProposal(id);
  revalidate();
}

export async function dismissProposalAction(id: string): Promise<void> {
  await requireOwner();
  if (!UUID_RE.test(id)) return;
  await getApplication().dismissImprovementProposal(id);
  revalidate();
}
