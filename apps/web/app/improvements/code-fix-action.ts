'use server';

import { revalidatePath } from 'next/cache';
import { requireOwner } from '@/auth';
import { requestProposalCodeFix } from '@/lib/proposal-code-fix';

export async function requestCodeFixAction(id: string): Promise<void> {
  await requireOwner();
  await requestProposalCodeFix(id);
  revalidatePath('/improvements');
}
