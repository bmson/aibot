'use server';

import { dismissSavedCard } from '@assistant/application/cards';
import { revalidatePath } from 'next/cache';
import { requireOwner } from '@/auth';
import { getAgentIdentity, getDb } from '@/lib/server';

export async function dismissCard(formData: FormData): Promise<void> {
  await requireOwner();
  const cardId = String(formData.get('cardId') ?? '');
  const agent = await getAgentIdentity();
  if (!agent.id || !cardId) return;
  await dismissSavedCard(getDb(), agent.id, cardId);
  revalidatePath('/cards');
}
