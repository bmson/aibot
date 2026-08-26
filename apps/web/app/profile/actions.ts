'use server';

import {
  addPersonOccasion,
  approveQuarantinedMemory,
  confirmMemory,
  correctMemory,
  createMemory,
  createPerson,
  deletePerson,
  forgetMemory,
  forgetPersonOccasion,
  mergePeople,
  type OrganizeMemoryState,
  organizeMemoryNow,
  type ProminenceLevel,
  purgeProfileVoiceSamples,
  recompileProfileCard,
  rejectQuarantinedMemory,
  reviewPersonOccasion,
  setMemoryProminence,
  updatePersonIdentity,
  updatePersonRelationship,
  updateVoiceProfile,
} from '@assistant/application/profile';
import { revalidatePath } from 'next/cache';
import { requireOwner } from '@/auth';
import { getApplication, getDb, getRouter, getWorkspace } from '@/lib/server';

export type { OrganizeMemoryState, ProminenceLevel } from '@assistant/application/profile';

function revalidateProfile(): void {
  revalidatePath('/profile', 'layout');
}

export async function resolveCommitmentAction(id: string): Promise<void> {
  await requireOwner();
  await getApplication().resolveCommitment(id, 'Owner confirmed this loop is resolved.');
  revalidateProfile();
}

export async function dismissCommitmentAction(id: string): Promise<void> {
  await requireOwner();
  await getApplication().dismissCommitment(id);
  revalidateProfile();
}

export async function snoozeCommitmentAction(id: string): Promise<void> {
  await requireOwner();
  await getApplication().snoozeCommitment(id, new Date(Date.now() + 24 * 3600 * 1000));
  revalidateProfile();
}

export async function correctCommitmentAction(
  id: string,
  title: string,
  details: string,
  nextAction: string,
): Promise<void> {
  await requireOwner();
  await getApplication().correctCommitment(id, { title, details, nextAction });
  revalidateProfile();
}

export async function correctCommitmentFormAction(id: string, formData: FormData): Promise<void> {
  await correctCommitmentAction(
    id,
    String(formData.get('title') ?? ''),
    String(formData.get('details') ?? ''),
    String(formData.get('nextAction') ?? ''),
  );
}

export async function confirmFact(memoryId: string): Promise<void> {
  await requireOwner();
  await confirmMemory(getDb(), memoryId);
  revalidateProfile();
}

export async function correctFact(memoryId: string, content: string): Promise<{ error?: string }> {
  await requireOwner();
  const result = await correctMemory(getDb(), getRouter(), memoryId, content);
  revalidateProfile();
  return result;
}

export async function forgetFact(memoryId: string): Promise<void> {
  await requireOwner();
  await forgetMemory(getDb(), memoryId);
  revalidateProfile();
}

export async function setFactProminence(memoryId: string, level: ProminenceLevel): Promise<void> {
  await requireOwner();
  await setMemoryProminence(getDb(), memoryId, level);
  revalidateProfile();
}

export async function approveQuarantined(memoryId: string): Promise<void> {
  await requireOwner();
  await approveQuarantinedMemory(getDb(), memoryId);
  revalidateProfile();
}

export async function rejectQuarantined(memoryId: string): Promise<void> {
  await requireOwner();
  await rejectQuarantinedMemory(getDb(), memoryId);
  revalidateProfile();
}

export async function updateContactRelationship(
  contactId: string,
  relationship: string,
): Promise<void> {
  await requireOwner();
  await updatePersonRelationship(getDb(), contactId, relationship);
  revalidateProfile();
}

export async function updateContactIdentityAction(
  contactId: string,
  name: string,
  aliasesText: string,
): Promise<{ error?: string }> {
  await requireOwner();
  const result = await updatePersonIdentity(getDb(), contactId, name, aliasesText);
  revalidateProfile();
  return result;
}

export async function deleteContactAction(contactId: string): Promise<{ error?: string }> {
  await requireOwner();
  const result = await deletePerson(getDb(), contactId);
  revalidateProfile();
  return result;
}

export async function recompileCard(): Promise<void> {
  await requireOwner();
  await recompileProfileCard(getDb());
  revalidateProfile();
}

export async function consolidateNow(
  _previous: OrganizeMemoryState,
  _formData: FormData,
): Promise<OrganizeMemoryState> {
  await requireOwner();
  const result = await organizeMemoryNow(getDb());
  revalidateProfile();
  return result;
}

export async function mergeContactAction(sourceId: string, targetId: string): Promise<void> {
  await requireOwner();
  await mergePeople(getDb(), sourceId, targetId);
  revalidateProfile();
}

export async function purgeVoiceSamplesAction(): Promise<void> {
  await requireOwner();
  await purgeProfileVoiceSamples(getDb(), getWorkspace());
  revalidateProfile();
}

/** Edit the distilled voice profile (description, do's, don'ts, signature). */
export async function updateVoiceProfileAction(input: {
  description: string;
  dos: string;
  donts: string;
  signature: string;
}): Promise<{ error?: string }> {
  await requireOwner();
  const result = await updateVoiceProfile(getDb(), input);
  if (result.error) return result;
  revalidateProfile();
  return {};
}

export async function createPersonAction(input: {
  name: string;
  relationship: string;
  aliases: string;
}): Promise<{ error?: string; contactId?: string }> {
  await requireOwner();
  const result = await createPerson(getDb(), input);
  revalidateProfile();
  return result;
}

export async function createMemoryAction(input: {
  content: string;
  domain: string;
  importance: string;
  pinned: boolean;
  subjectContactId: string;
}): Promise<{ error?: string }> {
  await requireOwner();
  const result = await createMemory(getDb(), getRouter(), input);
  revalidateProfile();
  return result;
}

export async function addOccasionAction(
  contactId: string,
  input: {
    kind: string;
    label: string;
    month: string;
    day: string;
    year: string;
    leadDays: string;
    notes: string;
  },
): Promise<{ error?: string }> {
  await requireOwner();
  const result = await addPersonOccasion(getDb(), contactId, input);
  revalidateProfile();
  return result;
}

export async function forgetOccasionAction(occasionId: string): Promise<void> {
  await requireOwner();
  await forgetPersonOccasion(getDb(), occasionId);
  revalidateProfile();
}

export async function reviewOccasionAction(
  occasionId: string,
  verdict: 'approve' | 'reject',
): Promise<void> {
  await requireOwner();
  await reviewPersonOccasion(getDb(), occasionId, verdict);
  revalidateProfile();
}
