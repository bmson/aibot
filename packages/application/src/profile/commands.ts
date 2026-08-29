import { createHash } from 'node:crypto';
import { getAgent } from '@assistant/core/chat';
import { InboundEventSchema } from '@assistant/core/events';
import { compileOwnerCard } from '@assistant/core/memory/consolidation';
import { MEMORY_DOMAINS } from '@assistant/core/memory/extraction';
import { removeOrphanedKnowledgeGraphEntities } from '@assistant/core/memory/knowledge-graph';
import { isOccasionKind, saveOccasion } from '@assistant/core/memory/occasions';
import { purgeVoiceSamples } from '@assistant/core/memory/voice-ingest';
import { enqueueTask } from '@assistant/core/workflow/machine';
import {
  addTombstone,
  contacts,
  type Db,
  deleteContact,
  isTombstoned,
  memories,
  mergeContacts,
  normalizeContactAliases,
  occasions,
  tasks,
  updateContactIdentity,
  voiceProfile,
} from '@assistant/db';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';

export interface EmbeddingPort {
  embed(texts: string[]): Promise<number[][]>;
}

export interface WorkspaceDeletePort {
  delete(relativePath: string): Promise<void>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function confirmMemory(db: Db, memoryId: string): Promise<void> {
  await db
    .update(memories)
    .set({ confidence: '1.00', ownerConfirmed: true, quarantined: false })
    .where(eq(memories.id, memoryId));
  await compileOwnerCard(db);
}

export async function correctMemory(
  db: Db,
  router: EmbeddingPort,
  memoryId: string,
  content: string,
): Promise<{ error?: string }> {
  const trimmed = content.trim();
  if (trimmed.length < 3) return { error: 'Correction is too short.' };
  const [existing] = await db.select().from(memories).where(eq(memories.id, memoryId)).limit(1);
  if (!existing) return { error: 'Fact not found.' };
  await addTombstone(db, existing.contentHash, 'owner_correct');
  const [embedding] = await router.embed([trimmed]);
  const contentHash = createHash('sha256').update(trimmed).digest('hex');
  await db
    .update(memories)
    .set({
      content: trimmed,
      contentHash,
      embedding,
      confidence: '1.00',
      ownerConfirmed: true,
      originTrust: 'owner',
      quarantined: false,
    })
    .where(eq(memories.id, memoryId));
  await compileOwnerCard(db);
  return {};
}

export async function forgetMemory(db: Db, memoryId: string): Promise<void> {
  const [existing] = await db.select().from(memories).where(eq(memories.id, memoryId)).limit(1);
  if (!existing) return;
  await addTombstone(db, existing.contentHash, 'owner_forget');
  await db.delete(memories).where(eq(memories.id, memoryId));
  await removeOrphanedKnowledgeGraphEntities(db, existing.agentId);
  await compileOwnerCard(db);
}

export type ProminenceLevel = 'always' | 'auto' | 'minor';

export async function setMemoryProminence(
  db: Db,
  memoryId: string,
  level: ProminenceLevel,
): Promise<void> {
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
}

export async function approveQuarantinedMemory(db: Db, memoryId: string): Promise<void> {
  await db.update(memories).set({ quarantined: false }).where(eq(memories.id, memoryId));
  await compileOwnerCard(db);
}

export async function rejectQuarantinedMemory(db: Db, memoryId: string): Promise<void> {
  const [existing] = await db.select().from(memories).where(eq(memories.id, memoryId)).limit(1);
  if (!existing) return;
  await addTombstone(db, existing.contentHash, 'quarantine_reject');
  await db.delete(memories).where(eq(memories.id, memoryId));
  await removeOrphanedKnowledgeGraphEntities(db, existing.agentId);
}

export async function updatePersonRelationship(
  db: Db,
  contactId: string,
  relationship: string,
): Promise<void> {
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
}

export async function updatePersonIdentity(
  db: Db,
  contactId: string,
  name: string,
  aliasesText: string,
): Promise<{ error?: string }> {
  if (!UUID_RE.test(contactId)) return { error: 'Invalid person identifier.' };
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
  return {};
}

export async function deletePerson(db: Db, contactId: string): Promise<{ error?: string }> {
  if (!UUID_RE.test(contactId)) return { error: 'Invalid person identifier.' };
  try {
    await deleteContact(db, contactId);
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Person could not be deleted.' };
  }
  await compileOwnerCard(db);
  return {};
}

export function recompileProfileCard(db: Db): Promise<unknown> {
  return compileOwnerCard(db);
}

export interface OrganizeMemoryState {
  taskId: string | null;
  outcome: 'idle' | 'queued' | 'already-running' | 'error';
  message: string | null;
}

export async function organizeMemoryNow(db: Db): Promise<OrganizeMemoryState> {
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
  return {
    taskId: task.id,
    outcome: 'queued',
    message: 'Memory organization is queued. This page will update as it works.',
  };
}

export async function mergePeople(db: Db, sourceId: string, targetId: string): Promise<void> {
  await mergeContacts(db, { sourceId, targetId });
  await compileOwnerCard(db);
}

export function purgeProfileVoiceSamples(
  db: Db,
  workspace: WorkspaceDeletePort,
): Promise<{ deleted: number }> {
  return purgeVoiceSamples(db, workspace);
}

/**
 * Edit the distilled voice profile the rewriter imitates. The lists arrive as
 * one entry per line from the form; blank lines drop. Bounds match the
 * ingest-time profile, so an owner edit can never smuggle a prompt's worth of
 * prose into the rewrite step.
 */
export async function updateVoiceProfile(
  db: Db,
  input: { description: string; dos: string; donts: string; signature: string },
): Promise<{ error?: string }> {
  const description = input.description.trim().slice(0, 2000);
  if (!description) return { error: 'The voice description is required.' };
  const lines = (raw: string) =>
    raw
      .split('\n')
      .map((line) => line.trim().slice(0, 300))
      .filter((line) => line.length > 0)
      .slice(0, 12);
  await db
    .insert(voiceProfile)
    .values({
      id: 1,
      description,
      dos: lines(input.dos),
      donts: lines(input.donts),
      signature: input.signature.trim().slice(0, 300),
      updatedAt: sql`now()`,
    })
    .onConflictDoUpdate({
      target: voiceProfile.id,
      set: {
        description,
        dos: lines(input.dos),
        donts: lines(input.donts),
        signature: input.signature.trim().slice(0, 300),
        updatedAt: sql`now()`,
      },
    });
  return {};
}

export async function createPerson(
  db: Db,
  input: { name: string; relationship: string; aliases: string },
): Promise<{ error?: string; contactId?: string }> {
  const name = input.name.trim().slice(0, 120);
  if (name.length < 1) return { error: 'Enter a name.' };
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
  return { contactId: row?.id };
}

export async function createMemory(
  db: Db,
  router: EmbeddingPort,
  input: {
    content: string;
    domain: string;
    importance: string;
    pinned: boolean;
    subjectContactId: string;
  },
): Promise<{ error?: string }> {
  const content = input.content.trim();
  if (content.length < 3) return { error: 'Write a little more.' };
  if (!UUID_RE.test(input.subjectContactId)) return { error: 'Invalid subject.' };
  const contentHash = createHash('sha256').update(content).digest('hex');
  if (await isTombstoned(db, contentHash)) {
    return { error: 'You previously forgot this fact, so it is not saved again.' };
  }
  const importance = Math.min(Math.max(Math.trunc(Number(input.importance)) || 3, 1), 5);
  const domain = (MEMORY_DOMAINS as readonly string[]).includes(input.domain)
    ? input.domain
    : undefined;
  const [embedding] = await router.embed([content]);
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
  return {};
}

export async function addPersonOccasion(
  db: Db,
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
  return {};
}

export async function forgetPersonOccasion(db: Db, occasionId: string): Promise<void> {
  if (!UUID_RE.test(occasionId)) return;
  await db.delete(occasions).where(eq(occasions.id, occasionId));
}

export async function reviewPersonOccasion(
  db: Db,
  occasionId: string,
  verdict: 'approve' | 'reject',
): Promise<void> {
  if (!UUID_RE.test(occasionId)) return;
  if (verdict === 'approve') {
    await db
      .update(occasions)
      .set({ quarantined: false, ownerConfirmed: true, updatedAt: sql`now()` })
      .where(eq(occasions.id, occasionId));
  } else {
    await db.delete(occasions).where(eq(occasions.id, occasionId));
  }
}
