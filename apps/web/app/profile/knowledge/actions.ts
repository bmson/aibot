'use server';

import {
  addOwnerKnowledgeGraphFact,
  cleanKnowledgeProjectionOrphans,
  correctKnowledgeGraphRelation,
  correctKnowledgeSource,
  forgetKnowledgeSource,
  getKnowledgeGraphNeighborhood,
  getKnowledgeSourceImpact,
  type KnowledgeGraphEntityView,
  type KnowledgeGraphNeighborEdge,
  mergeKnowledgeGraphEntities,
  reextractRelativeDateSources,
  renameKnowledgeGraphEntity,
  retryQuarantinedKnowledgeGraphSources,
  retypeKnowledgeGraphEntity,
  reviewKnowledgeGraphRelation,
  searchKnowledgeGraphEntities,
} from '@assistant/application';
import { approveQuarantinedMemory, confirmMemory } from '@assistant/application/profile';
import { revalidatePath } from 'next/cache';
import { requireOwner } from '@/auth';
import { getDb, getRouter } from '@/lib/server';

function revalidateKnowledgeGraph(): void {
  revalidatePath('/profile');
  revalidatePath('/profile/knowledge');
}

/**
 * Shared shape for the curation forms, so each can report what happened. A
 * 'use server' module may only export async functions, so the initial value
 * lives with the components that seed useActionState.
 */
export interface KnowledgeActionState {
  error: string | null;
  success: string | null;
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

/**
 * Rename and merge both return a reason when they decline. Those used to be
 * dropped on the floor, so a rejected merge was indistinguishable from a
 * successful one — the page simply re-rendered unchanged.
 */
/**
 * Costs one model call per source, so it is a button rather than a schedule.
 * The nightly backfill has already taken the free share of this work.
 */
export async function reextractDatedSources(): Promise<void> {
  await requireOwner();
  await reextractRelativeDateSources(getDb());
  revalidateKnowledgeGraph();
}

export async function renameKnowledgeEntity(
  entityId: string,
  _previous: KnowledgeActionState,
  formData: FormData,
): Promise<KnowledgeActionState> {
  await requireOwner();
  const label = String(formData.get('label') ?? '');
  const result = await renameKnowledgeGraphEntity(getDb(), entityId, label);
  if (result.error) return { error: result.error, success: null };
  revalidateKnowledgeGraph();
  return { error: null, success: 'Display name updated.' };
}

export async function mergeKnowledgeEntity(
  sourceId: string,
  _previous: KnowledgeActionState,
  formData: FormData,
): Promise<KnowledgeActionState> {
  await requireOwner();
  const targetId = String(formData.get('targetId') ?? '');
  if (!targetId) return { error: 'Choose an item to merge into.', success: null };
  const result = await mergeKnowledgeGraphEntities(getDb(), sourceId, targetId);
  if (result.error) return { error: result.error, success: null };
  revalidateKnowledgeGraph();
  return { error: null, success: 'Items merged. Future extractions will use the one you kept.' };
}

export async function retypeKnowledgeEntity(
  entityId: string,
  _previous: KnowledgeActionState,
  formData: FormData,
): Promise<KnowledgeActionState> {
  await requireOwner();
  const kind = String(formData.get('kind') ?? '');
  const result = await retypeKnowledgeGraphEntity(getDb(), entityId, kind);
  if (result.error) return { error: result.error, success: null };
  revalidateKnowledgeGraph();
  return { error: null, success: 'Type updated. Existing connections are unchanged.' };
}

/** Type-ahead for the merge picker; reaches any entity, not a fixed prefix. */
export async function searchKnowledgeEntities(
  query: string,
  excludeId: string,
  kind: string,
): Promise<KnowledgeGraphEntityView[]> {
  await requireOwner();
  return searchKnowledgeGraphEntities(getDb(), {
    query,
    excludeId,
    kind: kind || undefined,
  });
}

/**
 * The interactive map's expansion fetch. The application layer clamps the
 * limit, so a client-supplied value can never widen it past the shared cap.
 */
export async function loadKnowledgeNeighborhood(
  entityId: string,
  limit?: number,
): Promise<{ edges: KnowledgeGraphNeighborEdge[]; total: number }> {
  await requireOwner();
  const neighborhood = await getKnowledgeGraphNeighborhood(getDb(), { entityId, limit });
  return { edges: neighborhood.edges, total: neighborhood.total };
}

export type AddKnowledgeRelationState = KnowledgeActionState;

export async function addKnowledgeRelation(
  _previous: AddKnowledgeRelationState,
  formData: FormData,
): Promise<AddKnowledgeRelationState> {
  await requireOwner();
  const subjectId = String(formData.get('subjectId') ?? '');
  const objectId = String(formData.get('objectId') ?? '');
  const result = await addOwnerKnowledgeGraphFact(getDb(), getRouter(), {
    subjectLabel: String(formData.get('subjectLabel') ?? ''),
    subjectKind: String(formData.get('subjectKind') ?? ''),
    subjectId: subjectId || undefined,
    predicate: String(formData.get('predicate') ?? ''),
    objectLabel: String(formData.get('objectLabel') ?? ''),
    objectKind: String(formData.get('objectKind') ?? ''),
    objectId: objectId || undefined,
    note: String(formData.get('note') ?? ''),
  });
  if (result.error) return { error: result.error, success: null };
  revalidateKnowledgeGraph();
  return { error: null, success: 'Relationship saved with your note as its source.' };
}

export async function correctKnowledgeRelation(
  relationId: string,
  _previous: AddKnowledgeRelationState,
  formData: FormData,
): Promise<AddKnowledgeRelationState> {
  await requireOwner();
  const result = await correctKnowledgeGraphRelation(getDb(), getRouter(), relationId, {
    subjectLabel: String(formData.get('subjectLabel') ?? ''),
    subjectKind: String(formData.get('subjectKind') ?? ''),
    subjectId: String(formData.get('subjectId') ?? '') || undefined,
    predicate: String(formData.get('predicate') ?? ''),
    objectLabel: String(formData.get('objectLabel') ?? ''),
    objectKind: String(formData.get('objectKind') ?? ''),
    objectId: String(formData.get('objectId') ?? '') || undefined,
    note: String(formData.get('note') ?? ''),
  });
  if (result.error) return { error: result.error, success: null };
  revalidateKnowledgeGraph();
  return {
    error: null,
    success: 'Corrected connection saved; the earlier connection is now marked inaccurate.',
  };
}

export async function loadKnowledgeSourceImpact(memoryId: string) {
  await requireOwner();
  return getKnowledgeSourceImpact(getDb(), memoryId);
}

export async function correctKnowledgeMemory(
  memoryId: string,
  content: string,
): Promise<{ error?: string }> {
  await requireOwner();
  const result = await correctKnowledgeSource(getDb(), getRouter(), memoryId, content);
  revalidateKnowledgeGraph();
  return result;
}

export async function forgetKnowledgeMemory(memoryId: string): Promise<void> {
  await requireOwner();
  await forgetKnowledgeSource(getDb(), memoryId);
  revalidateKnowledgeGraph();
}

export async function keepKnowledgeMemory(memoryId: string): Promise<void> {
  await requireOwner();
  await confirmMemory(getDb(), memoryId);
  revalidateKnowledgeGraph();
}

export async function approveKnowledgeMemory(memoryId: string): Promise<void> {
  await requireOwner();
  await approveQuarantinedMemory(getDb(), memoryId);
  revalidateKnowledgeGraph();
}

export async function removeDisconnectedKnowledgeItems(): Promise<void> {
  await requireOwner();
  await cleanKnowledgeProjectionOrphans(getDb());
  revalidateKnowledgeGraph();
}
