import { createHash, randomUUID } from 'node:crypto';
import {
  type EmbeddingSpace,
  type ImportCommandRepository,
  type ImportFactWrite,
  type ImportJobFence,
  type ImportJobRepository,
  type ImportOccasionWrite,
  type ImportProgress,
  type ImportRunCursor,
  type ImportStartInput,
  MAX_OWNER_CARD_CONTACT_SCAN,
  newTaskRecord,
  type Records,
  type VoiceIngestCursor,
  type VoiceSampleWrite,
  validateEmbedding,
} from '@assistant/persistence';
import {
  type DocumentReference,
  type DocumentSnapshot,
  FieldPath,
  FieldValue,
  type Query,
  type QueryDocumentSnapshot,
  type Transaction,
} from '@google-cloud/firestore';
import { isEmulatorClosedTransaction } from './emulator-transaction.js';
import { embeddingSpaceKey, memoryDocument } from './memory.js';
import { occasionDocumentId } from './memory-consolidation.js';
import { createWakeIntent } from './outbox.js';
import { privacyErasureIsActive } from './privacy-erasure.js';
import { FirestoreProfileMemoryMaintenance } from './profile-memory-maintenance.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

type ImportSource = Records['importSources'];
type Task = Records['tasks'];

const IMPORT_JOBS = new Set(['import.run', 'voice.ingest']);
const ACTIVE_TASK_STATUSES = ['pending', 'sleeping', 'running', 'needs_attention'];
const SOURCE_TAG = /^[a-z0-9._-]{2,80}$/;
const PAGE_SIZE = 100;
const SCAN_PAGE_SIZE = 500;
const MAX_WINDOW_FACTS = 25;
const MAX_WINDOW_OCCASIONS = 10;
const MAX_VOICE_BATCH = 100;
const MAX_WRITING_SAMPLE_SCAN = 20_000;
/** One source's memories are purged or reviewed in pages; past this the command fails. */
const MAX_SOURCE_MEMORIES = 100_000;
const ASSISTANT_ALIASES = new Set(['assistant', 'ai bot', 'b bot', 'the assistant', 'bot']);
const VOICE_REGISTERS = new Set(['email_professional', 'email_casual', 'sms', 'chat']);

function sourceKeyId(agentId: string, source: string): string {
  return createHash('sha256').update(`${agentId}\0${source}`).digest('hex');
}

function uuidFromHash(input: string): string {
  const bytes = createHash('sha256').update(input).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Uploaded samples key on owner and text, so a replayed batch finds its own rows. */
function writingSampleId(agentId: string, text: string): string {
  return uuidFromHash(`writing-sample\0${agentId}\0${text}`);
}

function namePrefixMatch(left: string, right: string): boolean {
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  return shorter.length >= 3 && (shorter === longer || longer.startsWith(`${shorter} `));
}

function nonNegativeInteger(value: unknown): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error('Import task cursor is malformed');
  return value as number;
}

function plannerSection(state: unknown, key: string): Record<string, unknown> {
  const root = state && typeof state === 'object' ? (state as Record<string, unknown>) : {};
  const planner =
    root.plannerState && typeof root.plannerState === 'object'
      ? (root.plannerState as Record<string, unknown>)
      : {};
  const value = planner[key];
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function stateWith(state: unknown, key: string, cursor: object): Record<string, unknown> {
  const root = state && typeof state === 'object' ? { ...(state as Record<string, unknown>) } : {};
  const planner =
    root.plannerState && typeof root.plannerState === 'object'
      ? { ...(root.plannerState as Record<string, unknown>) }
      : {};
  planner[key] = cursor;
  root.plannerState = planner;
  return root;
}

function importCursorFrom(state: unknown): ImportRunCursor {
  const value = plannerSection(state, 'import');
  const cursor: ImportRunCursor = {
    windowIndex: nonNegativeInteger(value.windowIndex),
    saved: nonNegativeInteger(value.saved),
    duplicates: nonNegativeInteger(value.duplicates),
    tombstoned: nonNegativeInteger(value.tombstoned),
    quarantined: nonNegativeInteger(value.quarantined),
    occasionsSaved: nonNegativeInteger(value.occasionsSaved),
  };
  if (typeof value.manifestPath === 'string') cursor.manifestPath = value.manifestPath;
  if (typeof value.manifestHash === 'string') cursor.manifestHash = value.manifestHash;
  return cursor;
}

function voiceCursorFrom(state: unknown): VoiceIngestCursor {
  const value = plannerSection(state, 'voiceIngest');
  return {
    index: nonNegativeInteger(value.index),
    saved: nonNegativeInteger(value.saved),
    duplicates: nonNegativeInteger(value.duplicates),
  };
}

function validProgress(progress: ImportProgress): ImportProgress {
  if (
    typeof progress.progress !== 'string' ||
    !Number.isSafeInteger(progress.progressPercent) ||
    progress.progressPercent < 0 ||
    progress.progressPercent > 100
  )
    throw new Error('Import progress is malformed');
  return { progress: progress.progress.slice(0, 500), progressPercent: progress.progressPercent };
}

function ownedSource(snapshot: DocumentSnapshot, agentId: string): ImportSource {
  const row = decodeRecord<ImportSource>(snapshot.data());
  if (
    !row.id ||
    documentKey(row.id) !== snapshot.id ||
    row.agentId !== agentId ||
    typeof row.source !== 'string' ||
    typeof row.workspacePath !== 'string'
  )
    throw new Error('Malformed or foreign import source record');
  return row;
}

/** Owner and erasure checks shared by every import mutation, inside its transaction. */
async function readConfiguredOwner(
  tx: Transaction,
  store: InstallationStore,
  agentId: string,
): Promise<void> {
  const owners = await tx.get(store.collection('agents').limit(2));
  const owner = owners.docs[0];
  if (
    owners.size !== 1 ||
    !owner ||
    owner.id !== documentKey(agentId) ||
    owner.get('id') !== agentId
  )
    throw new Error('Imports require exactly one matching configured owner');
  const erasure = await tx.get(store.doc('privacyErasureJobs', agentId));
  if (
    erasure.exists &&
    (erasure.get('agentId') !== agentId || privacyErasureIsActive(erasure.get('status')))
  )
    throw new Error('Privacy erasure is in progress');
}

/**
 * The one source row for `source`, by its identity claim or, for rows imported
 * from PostgreSQL before claims existed, by an owner-scoped lookup.
 */
async function readSource(
  tx: Transaction,
  store: InstallationStore,
  agentId: string,
  source: string,
): Promise<{ row: ImportSource; ref: DocumentReference; claimed: boolean } | null> {
  const claim = await tx.get(store.doc('importSourceKeys', sourceKeyId(agentId, source)));
  if (claim.exists) {
    const sourceId = claim.get('sourceId');
    if (claim.get('agentId') !== agentId || claim.get('source') !== source || !sourceId)
      throw new Error('Import source identity claim is malformed');
    const snapshot = await tx.get(store.doc('importSources', String(sourceId)));
    if (!snapshot.exists) throw new Error('Import source identity claim is stale');
    const row = ownedSource(snapshot, agentId);
    if (row.source !== source) throw new Error('Import source identity claim is stale');
    return { row, ref: snapshot.ref, claimed: true };
  }
  const matches = await tx.get(
    store
      .collection('importSources')
      .where('agentId', '==', agentId)
      .where('source', '==', source)
      .limit(2),
  );
  if (matches.size > 1) throw new Error('Duplicate import source identity');
  const snapshot = matches.docs[0];
  if (!snapshot) return null;
  const row = ownedSource(snapshot, agentId);
  if (row.source !== source) throw new Error('Malformed or foreign import source record');
  return { row, ref: snapshot.ref, claimed: false };
}

function invalidateOwnerCard(
  tx: Transaction,
  store: InstallationStore,
  agentId: string,
  now: Date,
): void {
  tx.set(
    store.doc('ownerCards', agentId),
    encodeRecord({ agentId, content: '', compiledAt: now, invalidatedAt: now }),
  );
}

/** Firestore state for the import code jobs, fenced by owner, lease, source, and erasure. */
export class FirestoreImportJobRepository implements ImportJobRepository {
  readonly kind = 'import-job-repository' as const;

  constructor(
    readonly store: InstallationStore,
    readonly configuredAgentId: string,
    readonly embeddingSpace: EmbeddingSpace,
  ) {}

  private async readFence(
    tx: Transaction,
    fence: ImportJobFence,
  ): Promise<{
    task: Task;
    taskRef: DocumentReference;
    source: ImportSource;
    sourceRef: DocumentReference;
  } | null> {
    if (
      !this.configuredAgentId ||
      fence.agentId !== this.configuredAgentId ||
      !fence.leaseToken ||
      !Number.isSafeInteger(fence.queueGeneration) ||
      fence.queueGeneration < 0 ||
      !SOURCE_TAG.test(fence.source)
    )
      return null;
    await readConfiguredOwner(tx, this.store, fence.agentId);
    const taskSnap = await tx.get(this.store.doc('tasks', fence.taskId));
    if (!taskSnap.exists) return null;
    const task = decodeRecord<Task>(taskSnap.data());
    const payload = (task.trigger as { payload?: Record<string, unknown> } | null)?.payload;
    if (
      task.id !== fence.taskId ||
      documentKey(task.id) !== taskSnap.id ||
      task.agentId !== fence.agentId ||
      task.status !== 'running' ||
      task.queueGeneration !== fence.queueGeneration ||
      task.leaseToken !== fence.leaseToken ||
      !task.lockedUntil ||
      task.lockedUntil.getTime() <= this.store.now().getTime() ||
      !IMPORT_JOBS.has(String(payload?.job ?? '')) ||
      payload?.source !== fence.source
    )
      return null;
    const source = await readSource(tx, this.store, fence.agentId, fence.source);
    if (!source) return null;
    return { task, taskRef: taskSnap.ref, source: source.row, sourceRef: source.ref };
  }

  /** The fence plus a source still linked to this task and not purged. */
  private async readLinked(tx: Transaction, fence: ImportJobFence, statuses: string[]) {
    const current = await this.readFence(tx, fence);
    if (
      !current ||
      current.source.taskId !== fence.taskId ||
      !statuses.includes(current.source.status)
    )
      return null;
    return current;
  }

  async load(fence: ImportJobFence) {
    return this.store.db.runTransaction(async (tx) => {
      const current = await this.readFence(tx, fence);
      return current ? { source: current.source, state: current.task.state } : null;
    });
  }

  async claimSnapshotSlot(fence: ImportJobFence, ttlMs: number): Promise<boolean> {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 3_600_000)
      throw new Error('Import snapshot slot lease is outside its bounds');
    return this.store.db.runTransaction(async (tx) => {
      if (!(await this.readLinked(tx, fence, ['pending', 'running', 'failed', 'done'])))
        return false;
      const slotRef = this.store.doc('coordination', 'import-snapshot');
      const slot = await tx.get(slotRef);
      const now = this.store.now();
      const expiresAt = slot.get('expiresAt')?.toDate?.() as Date | undefined;
      if (
        slot.exists &&
        slot.get('taskId') !== fence.taskId &&
        expiresAt &&
        expiresAt.getTime() > now.getTime()
      )
        return false;
      tx.set(slotRef, {
        taskId: fence.taskId,
        expiresAt: new Date(now.getTime() + ttlMs),
        updatedAt: now,
      });
      return true;
    });
  }

  async releaseSnapshotSlot(fence: ImportJobFence): Promise<void> {
    await this.store.db.runTransaction(async (tx) => {
      const slotRef = this.store.doc('coordination', 'import-snapshot');
      const slot = await tx.get(slotRef);
      if (slot.exists && slot.get('taskId') === fence.taskId) tx.delete(slotRef);
    });
  }

  async begin(
    fence: ImportJobFence,
    input: { itemsTotal: number; state: unknown } & ImportProgress,
  ): Promise<boolean> {
    if (!Number.isSafeInteger(input.itemsTotal) || input.itemsTotal < 0)
      throw new Error('Import item total is malformed');
    const progress = validProgress(input);
    // Both cursors must parse before they are persisted.
    importCursorFrom(input.state);
    voiceCursorFrom(input.state);
    return this.store.db.runTransaction(async (tx) => {
      const current = await this.readLinked(tx, fence, ['pending', 'running', 'failed', 'done']);
      if (!current) return false;
      const now = this.store.now();
      tx.update(
        current.sourceRef,
        encodeRecord({ status: 'running', itemsTotal: input.itemsTotal, updatedAt: now }),
      );
      tx.update(
        current.taskRef,
        encodeRecord({ state: input.state, ...progress, reclaimCount: 0, updatedAt: now }),
      );
      return true;
    });
  }

  async resolveSubjects(
    fence: ImportJobFence,
    subjects: Array<{ subject: string; relationship?: string }>,
  ): Promise<Array<string | null>> {
    if (subjects.length === 0) return [];
    if (subjects.length > MAX_WINDOW_FACTS + MAX_WINDOW_OCCASIONS)
      throw new Error('Import subject resolution is outside its bounds');
    const contacts: Records['contacts'][] = [];
    let cursor: QueryDocumentSnapshot | undefined;
    for (;;) {
      let page = this.store
        .collection('contacts')
        .orderBy(FieldPath.documentId())
        .limit(SCAN_PAGE_SIZE);
      if (cursor) page = page.startAfter(cursor);
      const snapshot = await page.get();
      for (const doc of snapshot.docs) {
        const row = decodeRecord<Records['contacts']>(doc.data());
        if (row.id && documentKey(row.id) === doc.id) contacts.push(row);
      }
      if (contacts.length > MAX_OWNER_CARD_CONTACT_SCAN)
        throw new Error('Import contact scan exceeds its explicit limit');
      if (snapshot.size < SCAN_PAGE_SIZE) break;
      cursor = snapshot.docs.at(-1);
    }
    const owner = contacts.find((row) => row.trust === 'owner');
    const resolved: Array<string | null> = [];
    for (const input of subjects) {
      const name = input.subject.trim();
      const lower = name.toLowerCase();
      if (!name || ASSISTANT_ALIASES.has(lower)) {
        resolved.push(null);
        continue;
      }
      const ownerMatch = owner
        ? [owner.name, ...owner.aliases].some((candidate) =>
            namePrefixMatch(lower, candidate.toLowerCase()),
          )
        : false;
      if (lower === 'owner' || ownerMatch) {
        resolved.push(owner?.id ?? null);
        continue;
      }
      const match = contacts
        .filter((row) => row.trust !== 'owner')
        .find((row) =>
          [row.name, ...row.aliases].some((candidate) =>
            namePrefixMatch(lower, candidate.toLowerCase()),
          ),
        );
      if (match) {
        resolved.push(match.id);
        continue;
      }
      // The same name claim the memory tools use, so both writers converge on
      // one contact and a replayed window never creates a second person.
      const keyRef = this.store.doc(
        'contactNames',
        createHash('sha256').update(lower).digest('hex'),
      );
      const created = await this.store.db.runTransaction(async (tx) => {
        if (!(await this.readLinked(tx, fence, ['running']))) return null;
        const existing = await tx.get(keyRef);
        if (existing.exists) return String(existing.get('contactId'));
        const now = this.store.now();
        const id = randomUUID();
        const contact: Records['contacts'] = {
          id,
          name,
          createdAt: now,
          updatedAt: now,
          trust: 'unknown',
          aliases: [],
          emails: [],
          phones: [],
          relationship: input.relationship?.trim() ?? '',
          notes: '',
        };
        tx.create(this.store.doc('contacts', id), encodeRecord(contact));
        tx.create(keyRef, { contactId: id, createdAt: now });
        return { contact };
      });
      if (created === null) throw new Error('import task lease or source link was lost');
      if (typeof created === 'string') resolved.push(created);
      else {
        contacts.push(created.contact);
        resolved.push(created.contact.id);
      }
    }
    return resolved;
  }

  async commitImportWindow(
    fence: ImportJobFence,
    input: {
      windowIndex: number;
      facts: ImportFactWrite[];
      occasions: ImportOccasionWrite[];
      describe: (cursor: ImportRunCursor) => ImportProgress;
    },
  ): Promise<ImportRunCursor | null> {
    if (
      !Number.isSafeInteger(input.windowIndex) ||
      input.windowIndex < 0 ||
      input.facts.length > MAX_WINDOW_FACTS ||
      input.occasions.length > MAX_WINDOW_OCCASIONS
    )
      throw new Error('Import window is outside its persistence bounds');
    for (const fact of input.facts) {
      validateEmbedding(this.embeddingSpace, fact.embedding);
      if (
        !fact.content ||
        fact.contentHash !== createHash('sha256').update(fact.content).digest('hex') ||
        !Number.isInteger(fact.importance) ||
        fact.importance < 1 ||
        fact.importance > 5 ||
        !/^(0|1)\.\d{2}$/.test(fact.confidence) ||
        (fact.validFrom && !Number.isFinite(fact.validFrom.getTime()))
      )
        throw new Error('Import fact is malformed');
    }
    for (const occasion of input.occasions) {
      if (
        !occasion.contactId ||
        !['birthday', 'anniversary', 'custom'].includes(occasion.kind) ||
        !Number.isInteger(occasion.month) ||
        occasion.month < 1 ||
        occasion.month > 12 ||
        !Number.isInteger(occasion.day) ||
        occasion.day < 1 ||
        occasion.day > 31
      )
        throw new Error('Import occasion is malformed');
    }
    const occasionIds = input.occasions.map((occasion) =>
      occasionDocumentId(fence.agentId, occasion.contactId, occasion),
    );

    return this.store.db.runTransaction(async (tx) => {
      const current = await this.readLinked(tx, fence, ['running']);
      if (!current) return null;
      const cursor = importCursorFrom(current.task.state);
      if (cursor.windowIndex !== input.windowIndex) return null;

      const contactIds = [
        ...new Set([
          ...input.facts.flatMap((fact) => (fact.subjectContactId ? [fact.subjectContactId] : [])),
          ...input.occasions.map((occasion) => occasion.contactId),
        ]),
      ];
      const factRefs = input.facts.flatMap((fact) => [
        this.store.doc('memoryContentHashes', fact.contentHash),
        this.store.doc('memoryTombstones', fact.contentHash),
      ]);
      const occasionRefs = occasionIds.map((id) => this.store.doc('occasions', id));
      const contactRefs = contactIds.map((id) => this.store.doc('contacts', id));
      const reads = [...factRefs, ...occasionRefs, ...contactRefs];
      const snapshots = reads.length ? await tx.getAll(...reads) : [];
      const factSnaps = snapshots.slice(0, factRefs.length);
      const occasionSnaps = snapshots.slice(factRefs.length, factRefs.length + occasionRefs.length);
      const liveContacts = new Set(
        snapshots
          .slice(factRefs.length + occasionRefs.length)
          .filter((snapshot, index) => snapshot.exists && snapshot.get('id') === contactIds[index])
          .map((snapshot) => String(snapshot.get('id'))),
      );

      const now = this.store.now();
      const seen = new Set<string>();
      for (let index = 0; index < input.facts.length; index++) {
        const fact = input.facts[index];
        if (!fact) continue;
        const [hash, tombstone] = factSnaps.slice(index * 2, index * 2 + 2);
        if (tombstone?.exists) {
          cursor.tombstoned += 1;
          continue;
        }
        if (hash?.exists || seen.has(fact.contentHash)) {
          cursor.duplicates += 1;
          continue;
        }
        seen.add(fact.contentHash);
        const id = randomUUID();
        tx.create(
          this.store.doc('memories', id),
          memoryDocument(this.embeddingSpace, {
            id,
            createdAt: now,
            agentId: fence.agentId,
            expiresAt: null,
            embedding: fact.embedding,
            sourceTaskId: fence.taskId,
            kind: fact.kind,
            confidence: fact.confidence,
            contentHash: fact.contentHash,
            goalId: null,
            originTrust: 'owner',
            category: 'knowledge',
            content: fact.content,
            importance: fact.importance,
            quarantined: fact.quarantined,
            subjectContactId:
              fact.subjectContactId && liveContacts.has(fact.subjectContactId)
                ? fact.subjectContactId
                : null,
            domain: fact.domain,
            validFrom: fact.validFrom,
            validUntil: null,
            supersededById: null,
            ownerConfirmed: false,
            pinned: false,
            source: fence.source,
            lastAccessedAt: null,
            lastConsolidatedAt: null,
          }),
        );
        tx.create(this.store.doc('memoryContentHashes', fact.contentHash), { memoryId: id });
        cursor.saved += 1;
        if (fact.quarantined) cursor.quarantined += 1;
      }

      const upserted = new Set<string>();
      for (let index = 0; index < input.occasions.length; index++) {
        const occasion = input.occasions[index];
        const ref = occasionRefs[index];
        const existing = occasionSnaps[index];
        if (!occasion || !ref || !liveContacts.has(occasion.contactId) || upserted.has(ref.id))
          continue;
        upserted.add(ref.id);
        const notes = occasion.notes.trim().slice(0, 2000);
        if (existing?.exists) {
          // Fill a previously unknown year and append genuinely new notes;
          // never downgrade trust or re-quarantine a reviewed occasion.
          const row = decodeRecord<Records['occasions']>(existing.data());
          if (row.agentId !== fence.agentId || row.contactId !== occasion.contactId)
            throw new Error('Existing import occasion is malformed');
          tx.update(
            ref,
            encodeRecord({
              year: row.year ?? occasion.year,
              notes:
                row.notes === ''
                  ? notes
                  : notes === '' || row.notes.includes(notes)
                    ? row.notes
                    : `${row.notes}; ${notes}`,
              updatedAt: now,
            }),
          );
          continue;
        }
        const row: Records['occasions'] = {
          id: occasionIds[index] as string,
          agentId: fence.agentId,
          contactId: occasion.contactId,
          kind: occasion.kind,
          label: occasion.label.slice(0, 120),
          month: occasion.month,
          day: occasion.day,
          year: occasion.year,
          recurrence: 'annual',
          leadDays: 7,
          notes,
          originTrust: 'owner',
          quarantined: occasion.quarantined,
          ownerConfirmed: false,
          source: fence.source,
          createdAt: now,
          updatedAt: now,
        };
        tx.create(ref, encodeRecord(row));
        cursor.occasionsSaved += 1;
      }

      cursor.windowIndex += 1;
      const progress = validProgress(input.describe(cursor));
      tx.update(
        current.taskRef,
        encodeRecord({
          state: stateWith(current.task.state, 'import', cursor),
          ...progress,
          // Each committed window is proof of progress; see checkpointTask.
          reclaimCount: 0,
          updatedAt: now,
        }),
      );
      tx.update(
        current.sourceRef,
        encodeRecord({
          itemsProcessed: cursor.windowIndex,
          memoriesSaved: cursor.saved,
          memoriesQuarantined: cursor.quarantined,
          updatedAt: now,
        }),
      );
      return cursor;
    });
  }

  async ownerIdentity(
    fence: ImportJobFence,
  ): Promise<{ emails: string[]; names: string[] } | null> {
    return this.store.db.runTransaction(async (tx) => {
      if (!(await this.readLinked(tx, fence, ['pending', 'running', 'failed', 'done'])))
        return null;
      const owners = await tx.get(
        this.store.collection('contacts').where('trust', '==', 'owner').limit(1),
      );
      const owner = owners.docs[0]
        ? decodeRecord<Records['contacts']>(owners.docs[0].data())
        : null;
      return {
        emails: owner?.emails ?? [],
        names: [owner?.name ?? '', ...(owner?.aliases ?? [])].filter(Boolean),
      };
    });
  }

  async existingSampleTexts(fence: ImportJobFence, texts: string[]): Promise<Set<string>> {
    if (fence.agentId !== this.configuredAgentId)
      throw new Error('Writing samples are outside the configured owner');
    const wanted = new Set(texts);
    const found = new Set<string>();
    let scanned = 0;
    let cursor: QueryDocumentSnapshot | undefined;
    for (;;) {
      let page = this.store
        .collection('writingSamples')
        .where('agentId', '==', fence.agentId)
        .orderBy(FieldPath.documentId())
        .select('text')
        .limit(SCAN_PAGE_SIZE) as Query;
      if (cursor) page = page.startAfter(cursor);
      const snapshot = await page.get();
      scanned += snapshot.size;
      if (scanned > MAX_WRITING_SAMPLE_SCAN)
        throw new Error('Writing sample scan exceeds its explicit limit');
      for (const doc of snapshot.docs) {
        const text = doc.get('text');
        if (typeof text === 'string' && wanted.has(text)) found.add(text);
      }
      if (snapshot.size < SCAN_PAGE_SIZE) return found;
      cursor = snapshot.docs.at(-1);
    }
  }

  async commitVoiceBatch(
    fence: ImportJobFence,
    input: {
      index: number;
      nextIndex: number;
      register: string;
      context: string;
      samples: VoiceSampleWrite[];
      duplicates: number;
      describe: (cursor: VoiceIngestCursor) => ImportProgress;
    },
  ): Promise<VoiceIngestCursor | null> {
    if (
      !Number.isSafeInteger(input.index) ||
      input.index < 0 ||
      !Number.isSafeInteger(input.nextIndex) ||
      input.nextIndex < input.index ||
      input.nextIndex - input.index > MAX_VOICE_BATCH ||
      input.samples.length > input.nextIndex - input.index ||
      !Number.isSafeInteger(input.duplicates) ||
      input.duplicates < 0 ||
      !VOICE_REGISTERS.has(input.register) ||
      !input.context
    )
      throw new Error('Voice sample batch is outside its persistence bounds');
    for (const sample of input.samples) {
      if (!sample.text) throw new Error('Voice sample is malformed');
      validateEmbedding(this.embeddingSpace, sample.embedding);
    }
    const ids = input.samples.map((sample) => writingSampleId(fence.agentId, sample.text));
    return this.store.db.runTransaction(async (tx) => {
      const current = await this.readLinked(tx, fence, ['running']);
      if (!current) return null;
      const cursor = voiceCursorFrom(current.task.state);
      if (cursor.index !== input.index) return null;
      const refs = ids.map((id) => this.store.doc('writingSamples', id));
      const existing = refs.length ? await tx.getAll(...refs) : [];
      const now = this.store.now();
      cursor.duplicates += input.duplicates;
      const written = new Set<string>();
      for (let index = 0; index < input.samples.length; index++) {
        const sample = input.samples[index];
        const ref = refs[index];
        const id = ids[index];
        if (!sample || !ref || !id) continue;
        if (existing[index]?.exists || written.has(id)) {
          cursor.duplicates += 1;
          continue;
        }
        written.add(id);
        tx.create(
          ref,
          encodeRecord({
            id,
            agentId: fence.agentId,
            register: input.register,
            text: sample.text,
            context: input.context,
            embedding: FieldValue.vector(sample.embedding),
            embeddingSpace: embeddingSpaceKey(this.embeddingSpace),
            createdAt: now,
          }),
        );
        cursor.saved += 1;
      }
      cursor.index = input.nextIndex;
      const progress = validProgress(input.describe(cursor));
      tx.update(
        current.taskRef,
        encodeRecord({
          state: stateWith(current.task.state, 'voiceIngest', cursor),
          ...progress,
          reclaimCount: 0,
          updatedAt: now,
        }),
      );
      tx.update(
        current.sourceRef,
        encodeRecord({ itemsProcessed: cursor.index, memoriesSaved: cursor.saved, updatedAt: now }),
      );
      return cursor;
    });
  }

  async finish(
    fence: ImportJobFence,
    input: { status: 'done' | 'failed'; error: string | null },
  ): Promise<boolean> {
    return this.store.db.runTransaction(async (tx) => {
      const current = await this.readLinked(tx, fence, ['running']);
      if (!current) return false;
      tx.update(
        current.sourceRef,
        encodeRecord({
          status: input.status,
          error: input.error ? input.error.slice(0, 2000) : null,
          updatedAt: this.store.now(),
        }),
      );
      return true;
    });
  }
}

type MemoryPageMode = 'purge' | 'reject' | 'approve';

/**
 * Owner import-source commands. A source's memories are removed in bounded
 * pages after the source itself stops accepting writes, so a crashed purge is
 * resumed by running it again rather than leaving half a source recallable.
 */
export class FirestoreImportCommandRepository implements ImportCommandRepository {
  readonly kind = 'import-command-repository' as const;
  private readonly maintenance: FirestoreProfileMemoryMaintenance;

  constructor(
    readonly store: InstallationStore,
    readonly configuredAgentId: string,
  ) {
    this.maintenance = new FirestoreProfileMemoryMaintenance(store);
  }

  async start(input: ImportStartInput): Promise<{ sourceId: string; taskId: string }> {
    const agentId = this.configuredAgentId;
    if (!agentId) throw new Error('Imports require a configured owner');
    if (!SOURCE_TAG.test(input.source))
      throw new Error('source tag must be 2-80 chars of letters/digits/._-');
    if (!input.workspacePath || !['mbox', 'json', 'text'].includes(input.kind))
      throw new Error('Import source file is invalid');
    if (!IMPORT_JOBS.has(input.job)) throw new Error('Unknown import job');
    const label = input.job === 'voice.ingest' ? 'voice import' : 'import';
    const claimRef = this.store.doc('importSourceKeys', sourceKeyId(agentId, input.source));
    const taskId = randomUUID();
    const newSourceId = randomUUID();
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.store.db.runTransaction(async (tx) => {
          await readConfiguredOwner(tx, this.store, agentId);
          const existing = await readSource(tx, this.store, agentId, input.source);
          if (existing?.row.status === 'running' || existing?.row.status === 'pending')
            throw new Error(`${label} "${input.source}" is already ${existing.row.status}`);
          const now = this.store.now();
          const task = newTaskRecord(
            {
              agentId,
              type: 'adhoc',
              trust: 'owner',
              trigger: {
                source: 'internal',
                agentId,
                trust: 'owner',
                payload: {
                  ...input.payload,
                  job: input.job,
                  source: input.source,
                  path: input.workspacePath,
                  kind: input.kind,
                },
              },
              budgetUsdLimit: input.budgetUsdLimit,
            },
            taskId,
            now,
          );
          tx.create(this.store.doc('tasks', task.id), encodeRecord(task));
          createWakeIntent(tx, this.store, {
            taskId: task.id,
            generation: task.queueGeneration,
            availableAt: task.runAfter ?? now,
          });
          if (existing) {
            tx.update(
              existing.ref,
              encodeRecord({
                workspacePath: input.workspacePath,
                kind: input.kind,
                status: 'pending',
                taskId: task.id,
                itemsProcessed: 0,
                memoriesSaved: 0,
                memoriesQuarantined: 0,
                error: null,
                updatedAt: now,
              }),
            );
            if (!existing.claimed)
              tx.create(claimRef, {
                agentId,
                source: input.source,
                sourceId: existing.row.id,
              });
            return { sourceId: existing.row.id, taskId: task.id };
          }
          const row: ImportSource = {
            id: newSourceId,
            createdAt: now,
            updatedAt: now,
            agentId,
            status: 'pending',
            taskId: task.id,
            kind: input.kind,
            error: null,
            source: input.source,
            workspacePath: input.workspacePath,
            itemsTotal: null,
            itemsProcessed: 0,
            memoriesSaved: 0,
            memoriesQuarantined: 0,
          };
          tx.create(this.store.doc('importSources', row.id), encodeRecord(row));
          tx.create(claimRef, { agentId, source: input.source, sourceId: row.id });
          return { sourceId: row.id, taskId: task.id };
        });
      } catch (error) {
        if (!isEmulatorClosedTransaction(error) || attempt >= 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
      }
    }
  }

  /** Stop the source accepting writes: cancel its task and mark it purged. */
  private async stopSource(source: string): Promise<{ agentId: string; row: ImportSource }> {
    const agentId = this.configuredAgentId;
    return this.store.db.runTransaction(async (tx) => {
      await readConfiguredOwner(tx, this.store, agentId);
      const existing = await readSource(tx, this.store, agentId, source);
      if (!existing) throw new Error(`unknown import source: ${source}`);
      const taskSnap = existing.row.taskId
        ? await tx.get(this.store.doc('tasks', existing.row.taskId))
        : null;
      const now = this.store.now();
      if (taskSnap?.exists) {
        if (taskSnap.get('agentId') !== agentId || taskSnap.get('id') !== existing.row.taskId)
          throw new Error('Import task belongs to another agent');
        if (ACTIVE_TASK_STATUSES.includes(String(taskSnap.get('status'))))
          tx.update(taskSnap.ref, {
            status: 'cancelled',
            lockedUntil: null,
            runAfter: null,
            leaseToken: null,
            updatedAt: now,
          });
      }
      tx.update(
        existing.ref,
        encodeRecord({
          status: 'purged',
          memoriesSaved: 0,
          memoriesQuarantined: 0,
          updatedAt: now,
        }),
      );
      return { agentId, row: existing.row };
    });
  }

  /**
   * Apply one page of `mode` to the source's memories. Purged memories are
   * deleted without a tombstone (a re-run may learn them again); rejected ones
   * are tombstoned. Either way a graph deletion intent fences the graph writer.
   */
  private async memoryPage(
    agentId: string,
    source: string,
    mode: MemoryPageMode,
  ): Promise<string[]> {
    return this.store.db.runTransaction(async (tx) => {
      await readConfiguredOwner(tx, this.store, agentId);
      let query = this.store
        .collection('memories')
        .where('agentId', '==', agentId)
        .where('source', '==', source) as Query;
      if (mode !== 'purge') query = query.where('quarantined', '==', true);
      const page = await tx.get(query.limit(PAGE_SIZE));
      if (page.empty) return [];
      const rows = page.docs.map((doc) => {
        const row = decodeRecord<Records['memories']>(doc.data());
        if (
          !row.id ||
          documentKey(row.id) !== doc.id ||
          row.agentId !== agentId ||
          row.source !== source ||
          !row.contentHash
        )
          throw new Error('Import memory ownership or identity mismatch');
        return { doc, row };
      });
      const now = this.store.now();
      if (mode === 'approve') {
        for (const { doc } of rows) tx.update(doc.ref, { quarantined: false });
        invalidateOwnerCard(tx, this.store, agentId, now);
        return rows.map(({ row }) => row.id);
      }
      const related = await tx.getAll(
        ...rows.flatMap(({ row }) => [
          this.store.doc('memoryContentHashes', row.contentHash),
          this.store.doc('memoryTombstones', row.contentHash),
        ]),
      );
      const reason = mode === 'purge' ? 'import_purge' : 'quarantine_reject';
      for (let index = 0; index < rows.length; index++) {
        const entry = rows[index];
        if (!entry) continue;
        const [hash, tombstone] = related.slice(index * 2, index * 2 + 2);
        if (hash?.exists && hash.get('memoryId') === entry.row.id) tx.delete(hash.ref);
        if (mode === 'reject' && !tombstone?.exists)
          tx.create(
            this.store.doc('memoryTombstones', entry.row.contentHash),
            encodeRecord({
              id: entry.row.contentHash,
              contentHash: entry.row.contentHash,
              reason,
              createdAt: now,
            }),
          );
        tx.set(
          this.store.doc('graphDeletionIntents', entry.row.id),
          encodeRecord({
            memoryId: entry.row.id,
            agentId,
            contentHash: entry.row.contentHash,
            reason,
            source,
            createdAt: now,
            cleanupCompletedAt: null,
          }),
        );
        tx.delete(entry.doc.ref);
      }
      invalidateOwnerCard(tx, this.store, agentId, now);
      return rows.map(({ row }) => row.id);
    });
  }

  private async applyToSourceMemories(
    agentId: string,
    source: string,
    mode: MemoryPageMode,
  ): Promise<number> {
    let total = 0;
    for (;;) {
      const ids = await this.memoryPage(agentId, source, mode);
      if (ids.length === 0) break;
      total += ids.length;
      if (total > MAX_SOURCE_MEMORIES)
        throw new Error('Import source memory count exceeds its explicit limit');
    }
    if (mode !== 'approve') await this.cleanupGraph(agentId, source);
    return total;
  }

  /**
   * Remove graph facts sourced from this import's deleted memories. Intents a
   * crashed earlier purge left behind are finished here as well.
   */
  private async cleanupGraph(agentId: string, source: string): Promise<void> {
    let cleaned = 0;
    for (;;) {
      const pending = await this.store
        .collection('graphDeletionIntents')
        .where('agentId', '==', agentId)
        .where('source', '==', source)
        .where('cleanupCompletedAt', '==', null)
        .limit(PAGE_SIZE)
        .get();
      if (pending.empty) return;
      for (const intent of pending.docs) {
        const memoryId = intent.get('memoryId');
        if (typeof memoryId !== 'string' || documentKey(memoryId) !== intent.id)
          throw new Error('Import graph deletion intent is malformed');
        await this.maintenance.removeOrphanedGraphEntities({ agentId, memoryId });
      }
      cleaned += pending.size;
      if (cleaned > MAX_SOURCE_MEMORIES)
        throw new Error('Import graph cleanup exceeds its explicit limit');
    }
  }

  async purge(source: string): Promise<{ agentId: string; purged: number }> {
    const { agentId } = await this.stopSource(source);
    const purged = await this.applyToSourceMemories(agentId, source, 'purge');
    return { agentId, purged };
  }

  async remove(
    source: string,
  ): Promise<{ agentId: string; purgedMemories: number; workspacePath: string }> {
    const { agentId } = await this.stopSource(source);
    const purgedMemories = await this.applyToSourceMemories(agentId, source, 'purge');
    const workspacePath = await this.store.db.runTransaction(async (tx) => {
      await readConfiguredOwner(tx, this.store, agentId);
      const existing = await readSource(tx, this.store, agentId, source);
      if (!existing) throw new Error(`unknown import source: ${source}`);
      if (existing.row.status !== 'purged')
        throw new Error(`import "${source}" was restarted while it was being deleted`);
      tx.delete(existing.ref);
      if (existing.claimed)
        tx.delete(this.store.doc('importSourceKeys', sourceKeyId(agentId, source)));
      return existing.row.workspacePath;
    });
    return { agentId, purgedMemories, workspacePath };
  }

  async review(
    source: string,
    verdict: 'approve' | 'reject',
  ): Promise<{ agentId: string; reviewed: number }> {
    const agentId = this.configuredAgentId;
    const reviewed = await this.applyToSourceMemories(
      agentId,
      source,
      verdict === 'approve' ? 'approve' : 'reject',
    );
    if (reviewed === 0) return { agentId, reviewed };
    await this.store.db.runTransaction(async (tx) => {
      await readConfiguredOwner(tx, this.store, agentId);
      const existing = await readSource(tx, this.store, agentId, source);
      if (existing)
        tx.update(existing.ref, { memoriesQuarantined: 0, updatedAt: this.store.now() });
    });
    return { agentId, reviewed };
  }
}
