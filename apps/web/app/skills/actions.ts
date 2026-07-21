'use server';

import { deleteSkill, getAgent, saveSkill, setSkillDeprecated, updateSkill } from '@assistant/core';
import { revalidatePath } from 'next/cache';
import { requireOwner } from '@/auth';
import { getDb, getRouter } from '@/lib/server';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function revalidateSkills(): void {
  revalidatePath('/skills');
}

/** Owner hand-authors a durable procedure. */
export async function addSkillAction(input: {
  name: string;
  preconditions: string;
  steps: string;
  gotchas: string;
}): Promise<{ error?: string }> {
  await requireOwner();
  const name = input.name.trim();
  const steps = input.steps.trim();
  if (!name) return { error: 'Give the skill a name.' };
  if (!steps) return { error: 'Describe the steps.' };
  const db = getDb();
  const agent = await getAgent(db);
  try {
    await saveSkill(db, getRouter(), {
      agentId: agent.id,
      name,
      preconditions: input.preconditions,
      steps,
      gotchas: input.gotchas,
      originTrust: 'owner',
      ownerAuthored: true,
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Skill could not be saved.' };
  }
  revalidateSkills();
  return {};
}

/** Owner rewrites an existing skill. */
export async function editSkillAction(
  skillId: string,
  patch: { name: string; preconditions: string; steps: string; gotchas: string },
): Promise<{ error?: string }> {
  await requireOwner();
  if (!UUID_RE.test(skillId)) return { error: 'Invalid skill.' };
  if (!patch.name.trim() || !patch.steps.trim()) return { error: 'Name and steps are required.' };
  await updateSkill(getDb(), getRouter(), skillId, patch);
  revalidateSkills();
  return {};
}

export async function deleteSkillAction(skillId: string): Promise<void> {
  await requireOwner();
  if (!UUID_RE.test(skillId)) return;
  await deleteSkill(getDb(), skillId);
  revalidateSkills();
}

export async function toggleSkillDeprecatedAction(
  skillId: string,
  deprecated: boolean,
): Promise<void> {
  await requireOwner();
  if (!UUID_RE.test(skillId)) return;
  await setSkillDeprecated(getDb(), skillId, deprecated);
  revalidateSkills();
}
