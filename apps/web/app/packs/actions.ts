'use server';

import {
  changeOwnerPack,
  listPackSources,
  listSituationPacks,
} from '@assistant/application/situations';
import { revalidatePath } from 'next/cache';
import { requireOwner } from '@/auth';
import { getAgentIdentity, getDb } from '@/lib/server';

export async function loadPacks() {
  await requireOwner();
  const agent = await getAgentIdentity();
  if (!agent.id) return { packs: [], sources: [] };
  const [packs, sources] = await Promise.all([
    listSituationPacks(getDb(), agent.id),
    listPackSources(getDb(), agent.id),
  ]);
  return { packs, sources };
}
export async function changePack(input: unknown) {
  await requireOwner();
  const agent = await getAgentIdentity();
  if (!agent.id) return { ok: false as const, error: 'Owner unavailable.' };
  const result = await changeOwnerPack(getDb(), agent.id, input);
  revalidatePath('/packs');
  return result;
}
