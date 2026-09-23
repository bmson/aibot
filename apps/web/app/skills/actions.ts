'use server';

import { loadConfig } from '@assistant/config';
import { revalidatePath } from 'next/cache';
import { requireOwner } from '@/auth';
import {
  deleteFirestoreMobileSkill,
  setFirestoreMobileSkillDeprecated,
  writeFirestoreMobileSkill,
} from '@/lib/mobile-skill-write';
import { getChatApplication } from '@/lib/server';

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
  if (loadConfig().PERSISTENCE_DRIVER === 'firestore') {
    try {
      await writeFirestoreMobileSkill(input);
      revalidateSkills();
      return {};
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Skill could not be saved.' };
    }
  }
  const result = await getChatApplication().addSkill(input);
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
  if (loadConfig().PERSISTENCE_DRIVER === 'firestore') {
    try {
      await writeFirestoreMobileSkill(patch, skillId);
      revalidateSkills();
      return {};
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Skill could not be saved.' };
    }
  }
  const result = await getChatApplication().editSkill(skillId, patch);
  if (result.error) return result;
  revalidateSkills();
  return {};
}

export async function deleteSkillAction(skillId: string): Promise<void> {
  await requireOwner();
  if (!UUID_RE.test(skillId)) return;
  if (loadConfig().PERSISTENCE_DRIVER === 'firestore') {
    await deleteFirestoreMobileSkill(skillId);
    revalidateSkills();
    return;
  }
  await getChatApplication().deleteSkill(skillId);
  revalidateSkills();
}

export async function toggleSkillDeprecatedAction(
  skillId: string,
  deprecated: boolean,
): Promise<void> {
  await requireOwner();
  if (!UUID_RE.test(skillId)) return;
  if (loadConfig().PERSISTENCE_DRIVER === 'firestore') {
    await setFirestoreMobileSkillDeprecated(skillId, deprecated);
    revalidateSkills();
    return;
  }
  await getChatApplication().setSkillDeprecated(skillId, deprecated);
  revalidateSkills();
}
