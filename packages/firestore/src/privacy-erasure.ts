import { randomUUID } from 'node:crypto';
import type { PrivacyErasureCounts, PrivacyErasureRepository } from '@assistant/persistence';
import { FieldPath, FieldValue, type Query, type Transaction } from '@google-cloud/firestore';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

const PAGE_SIZE = 50;
type CountKey = keyof PrivacyErasureCounts;
type Job = {
  agentId: string;
  generation: string;
  status: 'active' | 'content-erased' | 'complete';
  counts: PrivacyErasureCounts;
};

export function privacyErasureIsActive(status: unknown): boolean {
  // A malformed durable fence must never re-enable recall or writes.
  return status !== 'complete';
}

function validJob(job: Job): boolean {
  return (
    typeof job.generation === 'string' &&
    !!job.generation &&
    ['active', 'content-erased', 'complete'].includes(job.status) &&
    [job.counts?.memories, job.counts?.graphRelations, job.counts?.writingSamples].every(
      (count) => Number.isSafeInteger(count) && count >= 0,
    )
  );
}

/** Each page is transactional; an incomplete job stays fenced and restarts from remaining rows. */
export class FirestorePrivacyErasureRepository implements PrivacyErasureRepository {
  readonly kind = 'privacy-erasure-repository' as const;

  constructor(readonly store: InstallationStore) {}

  private async soleOwner(): Promise<string> {
    const snapshot = await this.store.collection('agents').limit(2).get();
    const doc = snapshot.docs[0];
    const id = doc?.get('id');
    if (snapshot.size !== 1 || !doc || typeof id !== 'string' || !id || documentKey(id) !== doc.id)
      throw new Error('Privacy erasure requires exactly one configured owner');
    return id;
  }

  private async begin(agentId: string): Promise<Job> {
    const jobRef = this.store.doc('privacyErasureJobs', agentId);
    const cardRef = this.store.doc('ownerCards', agentId);
    return this.store.db.runTransaction(async (tx) => {
      const ownerQuery = await tx.get(this.store.collection('agents').limit(2));
      if (
        ownerQuery.size !== 1 ||
        ownerQuery.docs[0]?.get('id') !== agentId ||
        documentKey(agentId) !== ownerQuery.docs[0]?.id
      )
        throw new Error('Privacy erasure owner changed');
      const [jobSnapshot, card] = await tx.getAll(jobRef, cardRef);
      if (card?.exists && card.get('agentId') !== agentId)
        throw new Error('Owner card belongs to another agent');
      const current = jobSnapshot?.exists ? decodeRecord<Job>(jobSnapshot.data()) : null;
      if (current && current.agentId !== agentId)
        throw new Error('Privacy erasure job owner mismatch');
      if (current && !validJob(current)) throw new Error('Privacy erasure job is malformed');
      const job: Job =
        current && privacyErasureIsActive(current.status)
          ? { ...current, status: 'active' }
          : {
              agentId,
              generation: randomUUID(),
              status: 'active',
              counts: { memories: 0, graphRelations: 0, writingSamples: 0 },
            };
      const now = this.store.now();
      tx.set(jobRef, encodeRecord({ ...job, updatedAt: now }));
      tx.set(cardRef, encodeRecord({ agentId, content: '', compiledAt: now, invalidatedAt: now }));
      return job;
    });
  }

  private async activeJob(tx: Transaction, agentId: string, generation: string) {
    const ref = this.store.doc('privacyErasureJobs', agentId);
    const snapshot = await tx.get(ref);
    if (
      !snapshot.exists ||
      snapshot.get('agentId') !== agentId ||
      snapshot.get('generation') !== generation ||
      snapshot.get('status') !== 'active'
    )
      throw new Error('Privacy erasure fence changed');
    return ref;
  }

  private async deleteOwned(
    agentId: string,
    generation: string,
    collection: string,
    countKey?: CountKey,
  ): Promise<void> {
    for (;;) {
      const removed = await this.store.db.runTransaction(async (tx) => {
        const jobRef = await this.activeJob(tx, agentId, generation);
        const page = await tx.get(
          this.store.collection(collection).where('agentId', '==', agentId).limit(PAGE_SIZE),
        );
        for (const doc of page.docs) {
          if (
            doc.get('agentId') !== agentId ||
            typeof doc.get('id') !== 'string' ||
            documentKey(doc.get('id')) !== doc.id
          )
            throw new Error(`${collection} document ownership or identity mismatch`);
          tx.delete(doc.ref);
        }
        if (countKey && page.size)
          tx.update(jobRef, { [`counts.${countKey}`]: FieldValue.increment(page.size) });
        return page.size;
      });
      if (removed === 0) return;
    }
  }

  private async eraseMemories(agentId: string, generation: string): Promise<void> {
    for (;;) {
      const removed = await this.store.db.runTransaction(async (tx) => {
        const jobRef = await this.activeJob(tx, agentId, generation);
        const page = await tx.get(
          this.store.collection('memories').where('agentId', '==', agentId).limit(PAGE_SIZE),
        );
        const refs = page.docs.flatMap((doc) => {
          const hash = doc.get('contentHash');
          const id = doc.get('id');
          if (
            doc.get('agentId') !== agentId ||
            typeof id !== 'string' ||
            documentKey(id) !== doc.id ||
            typeof hash !== 'string' ||
            !hash
          )
            throw new Error('Memory document ownership or identity mismatch');
          return [
            this.store.doc('memoryContentHashes', hash),
            this.store.doc('memoryTombstones', hash),
            this.store.doc('knowledgeGraphSources', id),
            this.store.doc('graphDeletionIntents', id),
          ];
        });
        const related = refs.length ? await tx.getAll(...refs) : [];
        for (let index = 0; index < page.docs.length; index += 1) {
          const doc = page.docs[index];
          if (!doc) continue;
          const id = String(doc.get('id'));
          const hash = String(doc.get('contentHash'));
          const [hashDoc, tombstone, source, intent] = related.slice(index * 4, index * 4 + 4);
          if (hashDoc?.exists && hashDoc.get('memoryId') !== id)
            throw new Error('Memory hash points to another record');
          if (source?.exists && source.get('memoryId') !== id)
            throw new Error('Graph source points to another memory');
          if (
            intent?.exists &&
            (intent.get('memoryId') !== id || intent.get('agentId') !== agentId)
          )
            throw new Error('Graph deletion intent belongs to another owner');
          if (!tombstone?.exists)
            tx.create(this.store.doc('memoryTombstones', hash), {
              id: hash,
              contentHash: hash,
              reason: 'owner_forget',
              createdAt: this.store.now(),
            });
          if (hashDoc?.exists) tx.delete(hashDoc.ref);
          if (source?.exists) tx.delete(source.ref);
          if (intent?.exists) tx.delete(intent.ref);
          tx.delete(doc.ref);
        }
        if (page.size) tx.update(jobRef, { 'counts.memories': FieldValue.increment(page.size) });
        return page.size;
      });
      if (removed === 0) return;
    }
  }

  private async eraseVoiceImports(agentId: string, generation: string): Promise<void> {
    for (;;) {
      const removed = await this.store.db.runTransaction(async (tx) => {
        await this.activeJob(tx, agentId, generation);
        const page = await tx.get(
          this.store
            .collection('importSources')
            .where('agentId', '==', agentId)
            .where('source', '>=', 'voice-samples')
            .where('source', '<', 'voice-samples\uf8ff')
            .limit(PAGE_SIZE),
        );
        const taskRefs = page.docs.map((doc) => {
          const taskId = doc.get('taskId');
          return typeof taskId === 'string' && taskId ? this.store.doc('tasks', taskId) : null;
        });
        const assetRefs = page.docs.map((doc) =>
          this.store.doc('privacyErasureAssets', String(doc.get('id'))),
        );
        const tasks = await Promise.all(taskRefs.map((ref) => (ref ? tx.get(ref) : null)));
        const assets = assetRefs.length ? await tx.getAll(...assetRefs) : [];
        for (let index = 0; index < page.docs.length; index += 1) {
          const doc = page.docs[index];
          if (!doc) continue;
          const id = doc.get('id');
          const path = doc.get('workspacePath');
          const source = doc.get('source');
          if (
            doc.get('agentId') !== agentId ||
            typeof id !== 'string' ||
            documentKey(id) !== doc.id ||
            typeof path !== 'string' ||
            !path ||
            typeof source !== 'string' ||
            !source.startsWith('voice-samples')
          )
            throw new Error('Voice import ownership or identity mismatch');
          const task = tasks[index];
          if (task?.exists) {
            if (task.get('agentId') !== agentId || task.get('id') !== doc.get('taskId'))
              throw new Error('Voice import task belongs to another agent');
            if (
              ['pending', 'sleeping', 'running', 'needs_attention'].includes(
                String(task.get('status')),
              )
            )
              tx.update(task.ref, {
                status: 'cancelled',
                lockedUntil: null,
                runAfter: null,
                updatedAt: this.store.now(),
              });
          }
          const existing = assets[index];
          if (
            existing?.exists &&
            (existing.get('agentId') !== agentId ||
              existing.get('sourceId') !== id ||
              existing.get('workspacePath') !== path)
          )
            throw new Error('Voice asset cleanup belongs to another agent');
          if (!existing?.exists)
            tx.create(assetRefs[index] as FirebaseFirestore.DocumentReference, {
              agentId,
              sourceId: id,
              workspacePath: path,
              createdAt: this.store.now(),
            });
          tx.delete(doc.ref);
        }
        return page.size;
      });
      if (removed === 0) return;
    }
  }

  private async eraseSituationPacks(agentId: string, generation: string): Promise<void> {
    let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
    for (;;) {
      let query: Query = this.store
        .collection('situationPacks')
        .where('agentId', '==', agentId)
        .orderBy(FieldPath.documentId())
        .limit(PAGE_SIZE);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      for (const pack of page.docs) {
        const id = pack.get('id');
        if (
          pack.get('agentId') !== agentId ||
          typeof id !== 'string' ||
          documentKey(id) !== pack.id
        )
          throw new Error('Situation pack ownership or identity mismatch');
        for (;;) {
          const removed = await this.store.db.runTransaction(async (tx) => {
            await this.activeJob(tx, agentId, generation);
            const current = await tx.get(pack.ref);
            if (!current.exists || current.get('agentId') !== agentId || current.get('id') !== id)
              throw new Error('Situation pack owner changed');
            const previews = await tx.get(
              this.store.collection('situationPreviews').where('packId', '==', id).limit(PAGE_SIZE),
            );
            for (const preview of previews.docs) {
              if (
                preview.get('packId') !== id ||
                typeof preview.get('id') !== 'string' ||
                documentKey(preview.get('id')) !== preview.id
              )
                throw new Error('Situation preview belongs to another pack');
              tx.delete(preview.ref);
            }
            return previews.size;
          });
          if (removed === 0) break;
        }
        await this.store.db.runTransaction(async (tx) => {
          await this.activeJob(tx, agentId, generation);
          const current = await tx.get(pack.ref);
          if (!current.exists || current.get('agentId') !== agentId || current.get('id') !== id)
            throw new Error('Situation pack owner changed');
          if (current.get('privacyErasureGeneration') === generation) return;
          const data = decodeRecord<Record<string, unknown>>(current.get('data'));
          if (!data || typeof data !== 'object' || Array.isArray(data))
            throw new Error('Invalid situation pack data');
          tx.update(pack.ref, {
            data: encodeRecord({ ...data, decisions: [] }),
            version: Number(current.get('version')) + 1,
            privacyErasureGeneration: generation,
            updatedAt: this.store.now(),
          });
        });
      }
      if (page.size < PAGE_SIZE) break;
      cursor = page.docs.at(-1);
    }
  }

  async erase(): Promise<PrivacyErasureCounts> {
    const agentId = await this.soleOwner();
    const job = await this.begin(agentId);
    await this.eraseVoiceImports(agentId, job.generation);
    await this.eraseSituationPacks(agentId, job.generation);
    await this.deleteOwned(agentId, job.generation, 'knowledgeGraphRelations', 'graphRelations');
    await this.deleteOwned(agentId, job.generation, 'knowledgeGraphEntityAliases');
    await this.deleteOwned(agentId, job.generation, 'knowledgeGraphEntities');
    await this.eraseMemories(agentId, job.generation);
    for (;;) {
      const removed = await this.store.db.runTransaction(async (tx) => {
        const jobRef = await this.activeJob(tx, agentId, job.generation);
        const page = await tx.get(this.store.collection('writingSamples').limit(PAGE_SIZE));
        for (const doc of page.docs) {
          if (typeof doc.get('id') !== 'string' || documentKey(doc.get('id')) !== doc.id)
            throw new Error('Writing sample identity mismatch');
          tx.delete(doc.ref);
        }
        if (page.size)
          tx.update(jobRef, { 'counts.writingSamples': FieldValue.increment(page.size) });
        return page.size;
      });
      if (removed === 0) break;
    }
    const jobRef = this.store.doc('privacyErasureJobs', agentId);
    return this.store.db.runTransaction(async (tx) => {
      await this.activeJob(tx, agentId, job.generation);
      const voiceRef = this.store.doc('voiceProfile', '1');
      const [voice, current] = await tx.getAll(voiceRef, jobRef);
      if (!voice || !current) throw new Error('Privacy erasure singleton read is incomplete');
      if (voice.exists && voice.get('id') !== 1) throw new Error('Voice profile identity mismatch');
      const now = this.store.now();
      tx.set(voiceRef, {
        id: 1,
        description: '',
        dos: [],
        donts: [],
        signature: '',
        updatedAt: now,
      });
      tx.update(jobRef, { status: 'content-erased', updatedAt: now });
      return decodeRecord<Job>(current?.data()).counts;
    });
  }

  async pendingAssets() {
    const agentId = await this.soleOwner();
    const page = await this.store
      .collection('privacyErasureAssets')
      .where('agentId', '==', agentId)
      .limit(100)
      .get();
    return page.docs.map((doc) => {
      const id = doc.get('sourceId');
      const path = doc.get('workspacePath');
      if (
        doc.get('agentId') !== agentId ||
        typeof id !== 'string' ||
        documentKey(id) !== doc.id ||
        typeof path !== 'string' ||
        !path
      )
        throw new Error('Privacy asset ownership or identity mismatch');
      return { id, workspacePath: path };
    });
  }

  async assetDeleted(id: string) {
    const agentId = await this.soleOwner();
    const ref = this.store.doc('privacyErasureAssets', id);
    await this.store.db.runTransaction(async (tx) => {
      const asset = await tx.get(ref);
      if (!asset.exists) return;
      if (asset.get('agentId') !== agentId || asset.get('sourceId') !== id)
        throw new Error('Privacy asset belongs to another agent');
      tx.delete(ref);
    });
  }

  async complete() {
    const agentId = await this.soleOwner();
    await this.store.db.runTransaction(async (tx) => {
      const jobRef = this.store.doc('privacyErasureJobs', agentId);
      const job = await tx.get(jobRef);
      if (!job.exists || job.get('agentId') !== agentId || job.get('status') !== 'content-erased')
        throw new Error('Privacy erasure data phase is incomplete');
      const pending = await tx.get(
        this.store.collection('privacyErasureAssets').where('agentId', '==', agentId).limit(1),
      );
      if (!pending.empty) throw new Error('Privacy erasure assets remain');
      tx.update(jobRef, { status: 'complete', updatedAt: this.store.now() });
    });
  }
}
