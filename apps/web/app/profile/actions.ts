'use server';

import { createHash } from 'node:crypto';
import {
  compileOwnerCard,
  enqueueTask,
  getAgent,
  InboundEventSchema,
  isOccasionKind,
  purgeVoiceSamples,
  saveOccasion,
} from '@assistant/core';
import {
  addTombstone,
  contacts,
  deleteContact,
  memories,
  mergeContacts,
  occasions,
  updateContactIdentity,
} from '@assistant/db';
import { eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { requireOwner } from '@/auth';
import { getDb, getRouter, getWorkspace } from '@/lib/server';

function revalidateProfile(): void {
  revalidatePath('/profile', 'layout');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

/**
 * Set a contact's relationship. Naming a non-empty relationship is the owner
 * vouching for the person, so an 'unknown' contact is promoted to 'known'
 * (owner stays owner; already-known stays known).
 */
export async function updateContactRelationship(
  contactId: string,
  relationship: string,
): Promise<void> {
  await requireOwner();
  const db = getDb();
  const trimmed = relationship.trim().slice(0, 80);
  await db
    .update(contacts)
    .set({
      relationship: trimmed,
      ...(trimmed
        ? {
            trust: sql`CASE WHEN ${contacts.trust} = 'unknown' THEN 'known' ELSE ${contacts.trust} END`,
          }
        : {}),
      updatedAt: sql`now()`,
    })
    .where(eq(contacts.id, contactId));
  await compileOwnerCard(db);
  revalidateProfile();
}

/** Rename a person shown on the Profile page. Owner identity is intentionally excluded. */
export async function updateContactIdentityAction(
  contactId: string,
  name: string,
  aliasesText: string,
): Promise<{ error?: string }> {
  await requireOwner();
  if (!UUID_RE.test(contactId)) return { error: 'Invalid person identifier.' };
  const db = getDb();
  try {
    await updateContactIdentity(db, {
      contactId,
      name,
      aliases: aliasesText
        .slice(0, 4_000)
        .split(/[,\n]/)
        .map((alias) => alias.trim())
        .filter(Boolean),
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Person could not be renamed.' };
  }
  await compileOwnerCard(db);
  revalidateProfile();
  return {};
}

/** Delete a person and tombstone every fact about them so they stay deleted. */
export async function deleteContactAction(contactId: string): Promise<{ error?: string }> {
  await requireOwner();
  if (!UUID_RE.test(contactId)) return { error: 'Invalid person identifier.' };
  const db = getDb();
  try {
    await deleteContact(db, contactId);
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Person could not be deleted.' };
  }
  await compileOwnerCard(db);
  revalidateProfile();
  return {};
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

/**
 * Clear the auto-captured and uploaded voice samples (and any voice-import
 * husks), leaving seed-script samples and the distilled profile untouched.
 */
export async function purgeVoiceSamplesAction(): Promise<void> {
  await requireOwner();
  await purgeVoiceSamples(getDb(), getWorkspace());
  revalidateProfile();
}

// ── Occasions (Phase 17) ─────────────────────────────────────────────────────

/** Owner adds an occasion (birthday/anniversary/custom) for a person. */
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
  if (!UUID_RE.test(contactId)) return { error: 'Invalid person identifier.' };
  if (!isOccasionKind(input.kind)) return { error: 'Choose an occasion type.' };
  const month = Number(input.month);
  const day = Number(input.day);
  const year = input.year.trim() ? Number(input.year) : null;
  if (
    !Number.isInteger(month) ||
    month < 1 ||
    month > 12 ||
    !Number.isInteger(day) ||
    day < 1 ||
    day > 31
  ) {
    return { error: 'Enter a valid month (1–12) and day (1–31).' };
  }
  if (year !== null && (!Number.isInteger(year) || year < 1900 || year > 2200)) {
    return { error: 'Enter a valid year, or leave it blank.' };
  }
  const leadDays = input.leadDays.trim() ? Number(input.leadDays) : 7;
  const db = getDb();
  const agent = await getAgent(db);
  try {
    await saveOccasion(db, {
      agentId: agent.id,
      contactId,
      kind: input.kind,
      label: input.label.trim(),
      month,
      day,
      year,
      leadDays: Number.isInteger(leadDays) && leadDays >= 0 ? leadDays : 7,
      notes: input.notes.trim(),
      originTrust: 'owner',
      quarantined: false,
      ownerConfirmed: true,
      source: 'profile',
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Occasion could not be saved.' };
  }
  revalidateProfile();
  return {};
}

/** Owner removes an occasion. */
export async function forgetOccasionAction(occasionId: string): Promise<void> {
  await requireOwner();
  if (!UUID_RE.test(occasionId)) return;
  await getDb().delete(occasions).where(eq(occasions.id, occasionId));
  revalidateProfile();
}

/** Quarantine review for occasions learned from unverified sources. */
export async function reviewOccasionAction(
  occasionId: string,
  verdict: 'approve' | 'reject',
): Promise<void> {
  await requireOwner();
  if (!UUID_RE.test(occasionId)) return;
  const db = getDb();
  if (verdict === 'approve') {
    await db
      .update(occasions)
      .set({ quarantined: false, ownerConfirmed: true, updatedAt: sql`now()` })
      .where(eq(occasions.id, occasionId));
  } else {
    await db.delete(occasions).where(eq(occasions.id, occasionId));
  }
  revalidateProfile();
}
