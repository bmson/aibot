'use server';

import { createHash } from 'node:crypto';
import { compileOwnerCard, enqueueTask, getAgent, InboundEventSchema } from '@assistant/core';
import { addTombstone, contacts, memories, mergeContacts } from '@assistant/db';
import { eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { requireOwner } from '@/auth';
import { getDb, getRouter } from '@/lib/server';

function revalidateProfile(): void {
  revalidatePath('/profile');
}

/** Owner vouches for a fact: full confidence, consolidation treats it as protected. */
export async function confirmFact(memoryId: string): Promise<void> {
  await requireOwner();
  const db = getDb();
  await db
    .update(memories)
    .set({ confidence: '1.00', ownerConfirmed: true, quarantined: false })
    .where(eq(memories.id, memoryId));
  await compileOwnerCard(db);
  revalidateProfile();
}

/**
 * Owner rewrites a fact: new content + hash + embedding, full confidence.
 * The OLD wording is tombstoned so extraction can't resurrect it.
 */
export async function correctFact(memoryId: string, content: string): Promise<{ error?: string }> {
  await requireOwner();
  const trimmed = content.trim();
  if (trimmed.length < 3) return { error: 'Correction is too short.' };

  const db = getDb();
  const [existing] = await db.select().from(memories).where(eq(memories.id, memoryId)).limit(1);
  if (!existing) return { error: 'Fact not found.' };

  await addTombstone(db, existing.contentHash, 'owner_correct');
  const [embedding] = await getRouter().embed([trimmed]);
  const newHash = createHash('sha256').update(trimmed).digest('hex');
  await db
    .update(memories)
    .set({
      content: trimmed,
      contentHash: newHash,
      embedding,
      confidence: '1.00',
      ownerConfirmed: true,
      originTrust: 'owner',
      quarantined: false,
    })
    .where(eq(memories.id, memoryId));
  await compileOwnerCard(db);
  revalidateProfile();
  return {};
}

/** Forget-with-tombstone: the row is deleted and its hash can never be re-extracted. */
export async function forgetFact(memoryId: string): Promise<void> {
  await requireOwner();
  const db = getDb();
  const [existing] = await db.select().from(memories).where(eq(memories.id, memoryId)).limit(1);
  if (!existing) return;
  await addTombstone(db, existing.contentHash, 'owner_forget');
  await db.delete(memories).where(eq(memories.id, memoryId));
  await compileOwnerCard(db);
  revalidateProfile();
}

/** Pin/unpin: pinned facts are always part of the compiled owner card. */
export async function setFactPinned(memoryId: string, pinned: boolean): Promise<void> {
  await requireOwner();
  const db = getDb();
  await db.update(memories).set({ pinned }).where(eq(memories.id, memoryId));
  await compileOwnerCard(db);
  revalidateProfile();
}

/**
 * Demote to minor detail: importance 1 (and unpinned), so the fact never
 * auto-appears in the compiled card but stays in memory for semantic recall.
 */
export async function demoteFact(memoryId: string): Promise<void> {
  await requireOwner();
  const db = getDb();
  await db.update(memories).set({ importance: 1, pinned: false }).where(eq(memories.id, memoryId));
  await compileOwnerCard(db);
  revalidateProfile();
}

/** Quarantine review: approve releases the memory into normal retrieval. */
export async function approveQuarantined(memoryId: string): Promise<void> {
  await requireOwner();
  const db = getDb();
  await db.update(memories).set({ quarantined: false }).where(eq(memories.id, memoryId));
  await compileOwnerCard(db);
  revalidateProfile();
}

/** Quarantine review: reject deletes AND tombstones (it can't sneak back in). */
export async function rejectQuarantined(memoryId: string): Promise<void> {
  await requireOwner();
  const db = getDb();
  const [existing] = await db.select().from(memories).where(eq(memories.id, memoryId)).limit(1);
  if (!existing) return;
  await addTombstone(db, existing.contentHash, 'quarantine_reject');
  await db.delete(memories).where(eq(memories.id, memoryId));
  revalidateProfile();
}

/** Bound as a form action: updateContactRelationship.bind(null, contactId). */
export async function updateContactRelationship(
  contactId: string,
  formData: FormData,
): Promise<void> {
  await requireOwner();
  const relationship = String(formData.get('relationship') ?? '');
  await getDb()
    .update(contacts)
    .set({ relationship: relationship.trim().slice(0, 80), updatedAt: sql`now()` })
    .where(eq(contacts.id, contactId));
  await compileOwnerCard(getDb());
  revalidateProfile();
}

/** Manual owner-card rebuild (deterministic, model-free). */
export async function recompileCard(): Promise<void> {
  await requireOwner();
  await compileOwnerCard(getDb());
  revalidateProfile();
}

/**
 * Queue the memory.consolidate code job (same one the nightly schedule runs):
 * dedupe, resolve contradictions, and MERGE fragmented same-topic facts into
 * unified statements. Runs in the background — results show up here and on
 * /tasks when it finishes. Minute-bucket idempotency absorbs double clicks.
 */
export async function consolidateNow(): Promise<void> {
  await requireOwner();
  const db = getDb();
  const agent = await getAgent(db);
  const event = InboundEventSchema.parse({
    source: 'internal',
    externalEventId: `profile:consolidate:${new Date().toISOString().slice(0, 16)}`,
    agentId: agent.id,
    trust: 'assistant',
    payload: { job: 'memory.consolidate', instruction: 'owner-requested memory consolidation' },
  });
  await enqueueTask(db, { event, type: 'scheduled', budgetUsdLimit: '0.10' });
  revalidateProfile();
}

/**
 * Merge duplicate people ("Anna" + "Anna Jónsdóttir"): facts move to the
 * target, contact fields union, the duplicate row disappears. Merging into
 * the owner marks facts as being about the owner.
 */
export async function mergeContactAction(sourceId: string, targetId: string): Promise<void> {
  await requireOwner();
  const db = getDb();
  await mergeContacts(db, { sourceId, targetId });
  await compileOwnerCard(db);
  revalidateProfile();
}
