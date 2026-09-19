import { getAgent } from '@assistant/core/chat';
import { InboundEventSchema } from '@assistant/core/events';
import { compileOwnerCard } from '@assistant/core/memory/consolidation';
import { isOccasionKind, saveOccasion } from '@assistant/core/memory/occasions';
import { purgeVoiceSamples } from '@assistant/core/memory/voice-ingest';
import { enqueueTask } from '@assistant/core/workflow/machine';
import {
  contacts,
  createPostgresOwnerCardCompilationRepository,
  createPostgresProfileMemoryMaintenance,
  createPostgresProfileMemoryManagementRepository,
  type Db,
  deleteContact,
  mergeContacts,
  normalizeContactAliases,
  occasions,
  tasks,
  updateContactIdentity,
  voiceProfile,
} from '@assistant/db';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  type CreateProfileMemoryInput,
  createProfileMemoryCommands,
  type ProfileMemoryCommandPersistence,
  type ProfileMemoryEmbeddingPort,
} from './memory-commands.js';

export function createPostgresProfileMemoryCommandPersistence(
  db: Db,
): ProfileMemoryCommandPersistence {
  return {
    kind: 'profile-memory-command-persistence',
    memories: createPostgresProfileMemoryManagementRepository(db),
    ownerCards: createPostgresOwnerCardCompilationRepository(db),
    maintenance: createPostgresProfileMemoryMaintenance(db, async (input) => {
      await enqueueTask(db, {
        event: InboundEventSchema.parse(input.trigger),
        type: input.type,
      });
    }),
  };
}

export function profileMemoryCommands(
  store: Db | ProfileMemoryCommandPersistence,
  router: ProfileMemoryEmbeddingPort = {
    async embed() {
      throw new Error('Memory authoring requires an embedding provider');
    },
  },
) {
  const persistence =
    'kind' in store && store.kind === 'profile-memory-command-persistence'
      ? (store as ProfileMemoryCommandPersistence)
      : createPostgresProfileMemoryCommandPersistence(store as Db);
  const commands = createProfileMemoryCommands(persistence, router);
  if ('kind' in store && store.kind === 'profile-memory-command-persistence') return commands;
  // Legacy callers silently ignore missing/foreign facts. Keep that behavior
  // while transactional adapters enforce the single-owner invariant themselves.
  const existing = async (id: string, run: () => Promise<void>): Promise<void> => {
    if (await persistence.memories.get(id)) await run();
  };
  return {
    ...commands,
    confirmMemory: (id: string) => existing(id, () => commands.confirmMemory(id)),
    restoreMemory: (id: string) => existing(id, () => commands.restoreMemory(id)),
    forgetMemory: (id: string) => existing(id, () => commands.forgetMemory(id)),
    setMemoryProminence: (id: string, level: ProminenceLevel) =>
      existing(id, () => commands.setMemoryProminence(id, level)),
    approveQuarantinedMemory: (id: string) =>
      existing(id, () => commands.approveQuarantinedMemory(id)),
    rejectQuarantinedMemory: (id: string) =>
      existing(id, () => commands.rejectQuarantinedMemory(id)),
  };
}

export interface EmbeddingPort {
  embed(texts: string[]): Promise<number[][]>;
}

export interface WorkspaceDeletePort {
  delete(relativePath: string): Promise<void>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ProminenceLevel = 'always' | 'auto' | 'minor';

export function confirmMemory(
  store: Db | ProfileMemoryCommandPersistence,
  memoryId: string,
): Promise<void> {
  return profileMemoryCommands(store).confirmMemory(memoryId);
}

export function restoreMemory(
  store: Db | ProfileMemoryCommandPersistence,
  memoryId: string,
): Promise<void> {
  return profileMemoryCommands(store).restoreMemory(memoryId);
}

export function correctMemory(
  store: Db | ProfileMemoryCommandPersistence,
  router: EmbeddingPort,
  memoryId: string,
  content: string,
): Promise<{ error?: string }> {
  return profileMemoryCommands(store, router).correctMemory(memoryId, content);
}

export function forgetMemory(
  store: Db | ProfileMemoryCommandPersistence,
  memoryId: string,
): Promise<void> {
  return profileMemoryCommands(store).forgetMemory(memoryId);
}

export function setMemoryProminence(
  store: Db | ProfileMemoryCommandPersistence,
  memoryId: string,
  level: ProminenceLevel,
): Promise<void> {
  return profileMemoryCommands(store).setMemoryProminence(memoryId, level);
}

export function approveQuarantinedMemory(
  store: Db | ProfileMemoryCommandPersistence,
  memoryId: string,
): Promise<void> {
  return profileMemoryCommands(store).approveQuarantinedMemory(memoryId);
}

export function rejectQuarantinedMemory(
  store: Db | ProfileMemoryCommandPersistence,
  memoryId: string,
): Promise<void> {
  return profileMemoryCommands(store).rejectQuarantinedMemory(memoryId);
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

/**
 * Messages the db layer writes deliberately for the owner to read. Anything
 * else that escapes it — a postgres.js driver error carrying the failed SQL and
 * its bound parameters, a constraint violation, an unforeseen bug — is replaced
 * with a plain fallback and logged instead of rendered. This is an allowlist of
 * intentional copy rather than a blocklist of driver noise, so a new failure
 * mode nobody anticipated degrades quietly instead of leaking by default.
 */
const OWNER_FACING_DB_ERRORS: ReadonlySet<string> = new Set([
  'Person name is required.',
  'Person name must be 120 characters or fewer.',
  'Person name contains unsupported control characters.',
  'A person can have at most 20 aliases.',
  'Person not found or cannot be renamed.',
  'Person not found.',
  'The owner profile cannot be deleted.',
  'Person could not be deleted.',
]);

export function ownerFacingError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : '';
  if (OWNER_FACING_DB_ERRORS.has(message)) return message;
  console.error('[profile] unexpected person command failure:', error);
  return fallback;
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
    return { error: ownerFacingError(error, 'Person could not be renamed. Please try again.') };
  }
  await compileOwnerCard(db);
  return {};
}

export async function deletePerson(db: Db, contactId: string): Promise<{ error?: string }> {
  if (!UUID_RE.test(contactId)) return { error: 'Invalid person identifier.' };
  try {
    await deleteContact(db, contactId);
  } catch (error) {
    return { error: ownerFacingError(error, 'Person could not be deleted. Please try again.') };
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

export async function mergePeople(
  db: Db,
  sourceId: string,
  targetId: string,
): Promise<{ error?: string }> {
  try {
    await mergeContacts(db, { sourceId, targetId });
  } catch (error) {
    return {
      error: ownerFacingError(error, 'These people could not be merged. Please try again.'),
    };
  }
  await compileOwnerCard(db);
  return {};
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

export function createMemory(
  store: Db | ProfileMemoryCommandPersistence,
  router: EmbeddingPort,
  input: CreateProfileMemoryInput,
): Promise<{ error?: string }> {
  return profileMemoryCommands(store, router).createMemory(input);
}

export interface PersonOccasionInput {
  kind: string;
  label: string;
  month: string;
  day: string;
  year: string;
  leadDays: string;
  notes: string;
}

/** Edit the exact date in place, including clearing a previously saved year. */
export async function updatePersonOccasion(
  db: Db,
  occasionId: string,
  input: PersonOccasionInput,
): Promise<{ error?: string }> {
  if (!UUID_RE.test(occasionId)) return { error: 'Invalid occasion identifier.' };
  const agent = await getAgent(db);
  const [existing] = await db
    .select({ contactId: occasions.contactId })
    .from(occasions)
    .where(and(eq(occasions.id, occasionId), eq(occasions.agentId, agent.id)))
    .limit(1);
  if (!existing) return { error: 'That occasion no longer exists.' };
  return addPersonOccasion(db, existing.contactId, input, occasionId);
}

export async function addPersonOccasion(
  db: Db,
  contactId: string,
  input: PersonOccasionInput,
  occasionId?: string,
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
  if (day > new Date(Date.UTC(year ?? 2000, month, 0)).getUTCDate()) {
    return { error: 'That date does not exist. Check the month, day, and year.' };
  }
  const leadDays = input.leadDays.trim() ? Number(input.leadDays) : 7;
  if (!Number.isInteger(leadDays) || leadDays < 0 || leadDays > 60) {
    return { error: 'Choose a reminder between 0 and 60 days before.' };
  }
  const agent = await getAgent(db);
  try {
    if (occasionId) {
      const updated = await db
        .update(occasions)
        .set({
          kind: input.kind,
          label: input.label.trim().slice(0, 120),
          month,
          day,
          year,
          leadDays,
          notes: input.notes.trim().slice(0, 2000),
          originTrust: 'owner',
          ownerConfirmed: true,
          quarantined: false,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(occasions.id, occasionId),
            eq(occasions.agentId, agent.id),
            eq(occasions.contactId, contactId),
          ),
        )
        .returning({ id: occasions.id });
      return updated.length ? {} : { error: 'That occasion no longer exists.' };
    }
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
  } catch {
    return {
      error:
        'Occasion could not be saved. Check whether this date is already recorded and try again.',
    };
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
