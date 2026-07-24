'use server';

import { createHash } from 'node:crypto';
import {
  compileOwnerCard,
  enqueueTask,
  getAgent,
  InboundEventSchema,
  isOccasionKind,
  MEMORY_DOMAINS,
  purgeVoiceSamples,
  saveOccasion,
} from '@assistant/core';
import {
  addTombstone,
  contacts,
  deleteContact,
  isTombstoned,
  memories,
  mergeContacts,
  normalizeContactAliases,
  occasions,
  tasks,
  updateContactIdentity,
} from '@assistant/db';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
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

export type ProminenceLevel = 'always' | 'auto' | 'minor';

/**
 * Set how prominently a fact figures in conversations — one owner-facing control
 * replacing the old pin/demote pair:
 *   always → pinned into the compiled card, guaranteed in every prompt.
 *   auto   → AI Bot decides (important owner facts auto-surface; the rest are
 *            recalled when relevant). Lifts a previously-minor fact back to the
 *            default importance so it can surface again; leaves a normal/high
 *            importance untouched.
 *   minor  → a small detail: importance 1 and unpinned, so it never auto-appears
 *            in the card but stays available for recall.
 */
export async function setFactProminence(memoryId: string, level: ProminenceLevel): Promise<void> {
  await requireOwner();
  const db = getDb();
  if (level === 'always') {
    await db.update(memories).set({ pinned: true }).where(eq(memories.id, memoryId));
  } else if (level === 'minor') {
    await db
      .update(memories)
      .set({ pinned: false, importance: 1 })
      .where(eq(memories.id, memoryId));
  } else {
    await db
      .update(memories)
      .set({
        pinned: false,
        importance: sql`CASE WHEN ${memories.importance} <= 1 THEN 3 ELSE ${memories.importance} END`,
      })
      .where(eq(memories.id, memoryId));
  }
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
export interface OrganizeMemoryState {
  taskId: string | null;
  outcome: 'idle' | 'queued' | 'already-running' | 'error';
  message: string | null;
}

export async function consolidateNow(
  _previous: OrganizeMemoryState,
  _formData: FormData,
): Promise<OrganizeMemoryState> {
  await requireOwner();
  const db = getDb();
  const agent = await getAgent(db);
  const [active] = await db
    .select({ id: tasks.id, status: tasks.status })
    .from(tasks)
    .where(
      and(
        eq(tasks.agentId, agent.id),
        inArray(tasks.status, ['pending', 'running']),
        sql`${tasks.trigger} #>> '{payload,job}' = 'memory.consolidate'`,
      ),
    )
    .orderBy(desc(tasks.createdAt))
    .limit(1);
  if (active) {
    return {
      taskId: active.id,
      outcome: 'already-running',
      message:
        active.status === 'running'
          ? 'Memory organization is already in progress.'
          : 'Memory organization is already queued.',
    };
  }
  const event = InboundEventSchema.parse({
    source: 'internal',
    externalEventId: `profile:consolidate:${new Date().toISOString().slice(0, 16)}`,
    agentId: agent.id,
    trust: 'assistant',
    payload: { job: 'memory.consolidate', instruction: 'owner-requested memory consolidation' },
  });
  const { task } = await enqueueTask(db, {
    event,
    type: 'scheduled',
    budgetUsdLimit: '0.10',
  });
  revalidateProfile();
  return {
    taskId: task.id,
    outcome: 'queued',
    message: 'Memory organization is queued. This page will update as it works.',
  };
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

// ── Manual creation ──────────────────────────────────────────────────────────

/**
 * Owner adds a person by hand. A manually-named person is vouched-for, so they
 * are created 'known' (their content is not treated as unverified). Refuses an
 * exact-name duplicate so the owner merges rather than forking a contact.
 */
export async function createPersonAction(input: {
  name: string;
  relationship: string;
  aliases: string;
}): Promise<{ error?: string; contactId?: string }> {
  await requireOwner();
  const name = input.name.trim().slice(0, 120);
  if (name.length < 1) return { error: 'Enter a name.' };
  const db = getDb();
  const [existing] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(sql`lower(${contacts.name}) = ${name.toLowerCase()}`)
    .limit(1);
  if (existing) return { error: 'A person with that name already exists.' };
  const aliases = normalizeContactAliases(
    input.aliases
      .slice(0, 4_000)
      .split(/[,\n]/)
      .map((alias) => alias.trim())
      .filter(Boolean),
    name,
  );
  const [row] = await db
    .insert(contacts)
    .values({ name, relationship: input.relationship.trim().slice(0, 80), trust: 'known', aliases })
    .returning({ id: contacts.id });
  await compileOwnerCard(db);
  revalidateProfile();
  return { contactId: row?.id };
}

/**
 * Owner adds a fact by hand. Owner-authored → full confidence, owner-confirmed
 * (so consolidation protects the wording), origin 'owner'. `subjectContactId`
 * says who it is about — the owner's own id, or a person's. A previously
 * forgotten fact stays forgotten (tombstone wins).
 */
export async function createMemoryAction(input: {
  content: string;
  domain: string;
  importance: string;
  pinned: boolean;
  subjectContactId: string;
}): Promise<{ error?: string }> {
  await requireOwner();
  const content = input.content.trim();
  if (content.length < 3) return { error: 'Write a little more.' };
  if (!UUID_RE.test(input.subjectContactId)) return { error: 'Invalid subject.' };
  const db = getDb();

  const contentHash = createHash('sha256').update(content).digest('hex');
  if (await isTombstoned(db, contentHash)) {
    return { error: 'You previously forgot this fact, so it is not saved again.' };
  }
  const importance = Math.min(Math.max(Math.trunc(Number(input.importance)) || 3, 1), 5);
  const domain = (MEMORY_DOMAINS as readonly string[]).includes(input.domain)
    ? input.domain
    : undefined;
  const [embedding] = await getRouter().embed([content]);
  const agent = await getAgent(db);
  const [row] = await db
    .insert(memories)
    .values({
      agentId: agent.id,
      category: 'knowledge',
      kind: 'fact',
      content,
      contentHash,
      embedding,
      importance,
      confidence: '1.00',
      originTrust: 'owner',
      ownerConfirmed: true,
      pinned: input.pinned,
      subjectContactId: input.subjectContactId,
      domain,
      source: 'manual',
    })
    .onConflictDoNothing({ target: memories.contentHash })
    .returning({ id: memories.id });
  if (!row) return { error: 'That fact is already saved.' };
  await compileOwnerCard(db);
  revalidateProfile();
  return {};
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
