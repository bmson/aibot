'use server';

import { revalidatePath } from 'next/cache';
import { requireOwner } from '@/auth';
import { getApplication } from '@/lib/server';

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
  const result = await getApplication().addSkill(input);
  if (result.error) return result;
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
  const result = await getApplication().editSkill(skillId, patch);
  if (result.error) return result;
  revalidateSkills();
  return {};
}

export async function deleteSkillAction(skillId: string): Promise<void> {
  await requireOwner();
  if (!UUID_RE.test(skillId)) return;
  await getApplication().deleteSkill(skillId);
  revalidateSkills();
}

export async function toggleSkillDeprecatedAction(
  skillId: string,
  deprecated: boolean,
): Promise<void> {
  await requireOwner();
  if (!UUID_RE.test(skillId)) return;
  await getApplication().setSkillDeprecated(skillId, deprecated);
  revalidateSkills();
}
