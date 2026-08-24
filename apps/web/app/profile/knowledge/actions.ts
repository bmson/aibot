'use server';

import {
  addOwnerKnowledgeGraphFact,
  mergeKnowledgeGraphEntities,
  renameKnowledgeGraphEntity,
  retryQuarantinedKnowledgeGraphSources,
  reviewKnowledgeGraphRelation,
} from '@assistant/application';
import { revalidatePath } from 'next/cache';
import { requireOwner } from '@/auth';
import { getDb, getRouter } from '@/lib/server';

function revalidateKnowledgeGraph(): void {
  revalidatePath('/profile');
  revalidatePath('/profile/knowledge');
}

export async function confirmKnowledgeRelation(relationId: string): Promise<void> {
  await requireOwner();
  await reviewKnowledgeGraphRelation(getDb(), relationId, 'confirmed');
  revalidateKnowledgeGraph();
}

export async function rejectKnowledgeRelation(relationId: string): Promise<void> {
  await requireOwner();
  await reviewKnowledgeGraphRelation(getDb(), relationId, 'rejected');
  revalidateKnowledgeGraph();
}

export async function retryQuarantinedKnowledgeSources(): Promise<void> {
  await requireOwner();
  await retryQuarantinedKnowledgeGraphSources(getDb());
  revalidateKnowledgeGraph();
}

export async function renameKnowledgeEntity(entityId: string, formData: FormData): Promise<void> {
  await requireOwner();
  await renameKnowledgeGraphEntity(getDb(), entityId, String(formData.get('label') ?? ''));
  revalidateKnowledgeGraph();
}

export async function mergeKnowledgeEntity(sourceId: string, formData: FormData): Promise<void> {
  await requireOwner();
  await mergeKnowledgeGraphEntities(getDb(), sourceId, String(formData.get('targetId') ?? ''));
  revalidateKnowledgeGraph();
}

export interface AddKnowledgeRelationState {
  error: string | null;
  success: string | null;
}

export async function addKnowledgeRelation(
  _previous: AddKnowledgeRelationState,
  formData: FormData,
): Promise<AddKnowledgeRelationState> {
  await requireOwner();
  const result = await addOwnerKnowledgeGraphFact(getDb(), getRouter(), {
    subjectLabel: String(formData.get('subjectLabel') ?? ''),
    subjectKind: String(formData.get('subjectKind') ?? ''),
    predicate: String(formData.get('predicate') ?? ''),
    objectLabel: String(formData.get('objectLabel') ?? ''),
    objectKind: String(formData.get('objectKind') ?? ''),
    note: String(formData.get('note') ?? ''),
  });
  if (result.error) return { error: result.error, success: null };
  revalidateKnowledgeGraph();
  return { error: null, success: 'Relationship saved with your note as its source.' };
}
